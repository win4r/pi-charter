/**
 * Per-session state of the extension: whether Charter mode is on, which
 * charter is active, and the lazily built engine behind the tools and commands.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir, type ModelRuntime } from "@earendil-works/pi-coding-agent";

import { type CharterConfig, configLocations, type ConfigLocations, loadConfig } from "../core/config.ts";
import type { CharterState } from "../core/state.ts";
import { CharterStore } from "../core/store.ts";
import { nextAction, statusLine } from "../core/summary.ts";
import { CharterError, type Role } from "../core/types.ts";
import { Engine, type RoleRunner } from "../engine/pipeline.ts";
import { PiRoleRunner } from "./child.ts";
import { ENTRY_TYPE, type Mode, STATUS_KEY, TOOL_NAMES } from "./schemas.ts";

/** Seams for tests; production passes nothing. */
export interface CharterDeps {
	modelRuntime?: ModelRuntime;
	agentDir?: string;
	runner?: RoleRunner;
}

interface SavedMode {
	enabled: boolean;
	charter: string | null;
}

/** Charter tools are visible to the model only while the mode is on. */
function syncTools(pi: ExtensionAPI, mode: Mode): void {
	const own: readonly string[] = TOOL_NAMES;
	const others = pi.getActiveTools().filter((name) => !own.includes(name));
	pi.setActiveTools(mode.enabled ? [...others, ...own] : others);
}

const packageFile = (relativePath: string): string => fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));

export class CharterSession {
	readonly pi: ExtensionAPI;
	private readonly mode: Mode;

	private readonly agentDir: string;
	private readonly runner: RoleRunner;
	private readonly files = new Map<string, Promise<string>>();
	private latest: ExtensionContext | undefined;
	private engineKey = "";
	private cachedEngine: Engine | undefined;

	constructor(pi: ExtensionAPI, deps: CharterDeps, mode: Mode) {
		this.pi = pi;
		this.mode = mode;
		this.agentDir = deps.agentDir ?? getAgentDir();
		this.runner =
			deps.runner ??
			new PiRoleRunner({
				agentDir: this.agentDir,
				modelRuntime: deps.modelRuntime,
				sessionModel: () => (this.latest?.model ? { provider: this.latest.model.provider, id: this.latest.model.id } : undefined),
				// Only a persisted main session has a directory worth saving transcripts next to.
				sessionDir: () => (this.latest?.sessionManager.getSessionFile() ? this.latest.sessionManager.getSessionDir() : undefined),
				rolePrompt: (role: Role) => this.prompt(role),
			});
	}

	/** Remember the freshest context; agents read the session model and directory from it. */
	touch(ctx: ExtensionContext): void {
		this.latest = ctx;
	}

	locations(ctx: ExtensionContext): ConfigLocations {
		return configLocations(ctx.cwd, CONFIG_DIR_NAME, this.agentDir);
	}

	async loadConfig(ctx: ExtensionContext): Promise<{ config: CharterConfig; sources: string[] }> {
		return loadConfig(this.locations(ctx), { trustProject: ctx.isProjectTrusted() });
	}

	/** The engine for the current project and configuration (rebuilt only when either changes). */
	async engine(ctx: ExtensionContext): Promise<Engine> {
		this.touch(ctx);
		const { config } = await this.loadConfig(ctx);
		const key = `${ctx.cwd}\n${JSON.stringify(config)}`;
		if (!this.cachedEngine || key !== this.engineKey) {
			this.cachedEngine = new Engine({ projectRoot: ctx.cwd, config, store: new CharterStore(ctx.cwd, config.directory), runner: this.runner });
			this.engineKey = key;
		}
		return this.cachedEngine;
	}

	requireActive(): string {
		if (!this.activeId) throw new CharterError("No charter is active. Create one with charter_new, or ask the developer to run /charter resume.");
		return this.activeId;
	}

	private file(relativePath: string): Promise<string> {
		let cached = this.files.get(relativePath);
		if (!cached) {
			cached = readFile(packageFile(relativePath), "utf8");
			this.files.set(relativePath, cached);
		}
		return cached;
	}

	prompt(name: Role | "steward"): Promise<string> {
		return this.file(`prompts/${name}.md`);
	}

	async templates(): Promise<{ brief: string; spec: string; design: string }> {
		const [brief, spec, design] = await Promise.all([this.file("templates/brief.md"), this.file("templates/spec.md"), this.file("templates/design.md")]);
		return { brief, spec, design };
	}

	// ------------------------------------------------------------ mode + tools

	get enabled(): boolean {
		return this.mode.enabled;
	}

	get activeId(): string | null {
		return this.mode.activeId;
	}

	/** Change the mode, show or hide the tools, and persist it so `/resume` and restarts pick it up. */
	setMode(enabled: boolean, charter: string | null = this.mode.activeId): void {
		this.mode.enabled = enabled;
		this.mode.activeId = charter;
		syncTools(this.pi, this.mode);
		const saved: SavedMode = { enabled, charter };
		const serialized = JSON.stringify(saved);
		if (serialized === this.mode.saved) return;
		this.mode.saved = serialized;
		this.pi.appendEntry(ENTRY_TYPE, saved);
	}

	/** State of the active charter, or `undefined` when none is active or it vanished. */
	async activeState(ctx: ExtensionContext): Promise<CharterState | undefined> {
		if (!this.activeId) return undefined;
		try {
			return await (await this.engine(ctx)).store.charter(this.activeId).load();
		} catch {
			return undefined;
		}
	}

	async refreshStatus(ctx: ExtensionContext, live?: string): Promise<void> {
		if (!ctx.hasUI) return;
		if (!this.enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const state = await this.activeState(ctx);
		ctx.ui.setStatus(STATUS_KEY, state ? statusLine(state, live) : "charter · no active charter");
	}

	/** The small, changing part of the system prompt. Kept short so updates stay cheap. */
	async stateSection(ctx: ExtensionContext): Promise<string> {
		const state = await this.activeState(ctx);
		if (!state) {
			return "No charter is active. When the developer describes a change, call charter_new with a short title.";
		}
		const engine = await this.engine(ctx);
		return [
			`Active charter: ${state.id} ("${state.title}") in ${engine.store.relativeRoot}/${state.id}/`,
			`Stage: ${state.stage}${state.approval ? ` (approved revision ${state.approval.revision})` : ""}`,
			`Next: ${nextAction(state)}`,
		].join("\n");
	}
}
