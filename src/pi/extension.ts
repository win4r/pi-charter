/**
 * Startup module: declares the command, the tools and the event hooks, and
 * nothing else. The engine, the agent runner and the command handlers live in
 * `runtime.ts`, which is imported the first time Charter is actually used, so
 * sessions that never turn the mode on do not pay for it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ENTRY_TYPE, type Mode, STATUS_KEY, SUBCOMMANDS, TOOL_NAMES, TOOL_SPECS } from "./schemas.ts";
import type { CharterDeps, CharterSession } from "./session.ts";

export type { CharterDeps } from "./session.ts";

export function createCharterExtension(deps: CharterDeps = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const mode: Mode = { enabled: false, activeId: null, saved: "" };
		let runtime: Promise<typeof import("./runtime.ts")> | undefined;
		let session: CharterSession | undefined;
		const load = (): Promise<typeof import("./runtime.ts")> => (runtime ??= import("./runtime.ts"));
		const current = async (): Promise<CharterSession> => (session ??= new (await load()).CharterSession(pi, deps, mode));

		for (const spec of TOOL_SPECS) {
			pi.registerTool({
				name: spec.name,
				label: spec.label,
				description: spec.description,
				promptSnippet: spec.promptSnippet,
				parameters: spec.parameters,
				defaultActive: false,
				...(spec.sequential ? { executionMode: "sequential" as const } : {}),
				async execute(_toolCallId, params, signal, onUpdate, ctx) {
					const { TOOL_EXECUTORS } = await load();
					return TOOL_EXECUTORS[spec.name](await current(), params as Record<string, unknown>, signal, onUpdate, ctx);
				},
			});
		}

		pi.registerCommand("charter", {
			description: "Spec-driven delivery: draft a charter, approve it, run the implement/audit/refine pipeline",
			getArgumentCompletions: (prefix) => {
				if (prefix.includes(" ")) return null;
				const matches = SUBCOMMANDS.filter(([name]) => name.startsWith(prefix)).map(([name, help]) => ({ value: name, label: name, description: help }));
				return matches.length > 0 ? matches : null;
			},
			handler: async (args, ctx) => (await load()).runCommand(await current(), args, ctx),
		});

		/** Rebuild the mode from the session's own entries. Cheap unless the mode turns out to be on. */
		const restore = async (ctx: ExtensionContext): Promise<void> => {
			mode.enabled = false;
			mode.activeId = null;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
				const data = entry.data as { enabled?: unknown; charter?: unknown } | undefined;
				mode.enabled = data?.enabled === true;
				mode.activeId = typeof data?.charter === "string" ? data.charter : null;
			}
			mode.saved = JSON.stringify({ enabled: mode.enabled, charter: mode.activeId });

			const own: readonly string[] = TOOL_NAMES;
			const others = pi.getActiveTools().filter((name) => !own.includes(name));
			pi.setActiveTools(mode.enabled ? [...others, ...own] : others);

			if (mode.enabled) {
				const active = await current();
				active.touch(ctx);
				await active.refreshStatus(ctx);
			} else if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		};

		// Startup, /resume, /new, /fork and /reload all arrive here; /tree changes the active branch.
		pi.on("session_start", (_event, ctx) => restore(ctx));
		pi.on("session_tree", (_event, ctx) => restore(ctx));

		pi.on("before_agent_start", async (event, ctx) => {
			const sections = event.systemPromptOptions.sections;
			if (!mode.enabled) {
				delete sections.charter;
				delete sections.charter_state;
				return;
			}
			const active = await current();
			active.touch(ctx);
			// Two sections on purpose: the long instructions never change, so they stay cached;
			// only the few lines of state are re-sent when the charter moves.
			sections.charter = await active.prompt("steward");
			sections.charter_state = await active.stateSection(ctx);
		});

		pi.on("tool_call", async (event, ctx) => {
			if (!mode.enabled || (event.toolName !== "write" && event.toolName !== "edit")) return undefined;
			return (await load()).guardWrite(await current(), event, ctx);
		});

		pi.on("tool_execution_end", async (event, ctx) => {
			if (mode.enabled && (TOOL_NAMES as readonly string[]).includes(event.toolName)) await (await current()).refreshStatus(ctx);
		});
	};
}

export default createCharterExtension();
