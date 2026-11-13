/**
 * The `/charter` command. Commands are typed by the developer and cannot be
 * invoked by a model, which makes them the right place for approval and for
 * overrides (skip, rollback, extra cycles).
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { cloneConfig, describeRole, enabledRoles, saveConfig } from "../core/config.ts";
import type { DecisionInput } from "../core/decisions.ts";
import { detectChecks } from "../core/detect.ts";
import { pathExists, readTextIfExists } from "../core/fsx.ts";
import { GitWorkspace } from "../core/git.ts";
import { isRunnable } from "../core/machine.ts";
import { formatDiagnostics } from "../core/spec/lint.ts";
import { isCharterId } from "../core/store.ts";
import { describeStatus } from "../core/summary.ts";
import { errorMessage, ROLES, type Role, THINKING_LEVELS, type ThinkingLevel } from "../core/types.ts";
import type { Engine } from "../engine/pipeline.ts";
import { SUBCOMMANDS } from "./schemas.ts";
import type { CharterSession } from "./session.ts";
import { approvalMessage } from "./tools.ts";

const INHERIT = "Use the main session's model";

type Handler = (argument: string, ctx: ExtensionCommandContext) => Promise<void>;

const DECISIONS = ["answer", "fix", "waive", "revise"] as const;

/** Parse `/charter decide` input: `<ref> <decision> <text>`, several separated by `;` or line breaks. */
export function parseDecisions(input: string): DecisionInput[] {
	const decisions: DecisionInput[] = [];
	for (const part of input.split(/[;\n]/)) {
		const segment = part.trim();
		if (segment === "") continue;
		const match = /^(\S+)\s+(\S+)\s*([\s\S]*)$/.exec(segment);
		const decision = match?.[2]?.toLowerCase();
		if (!match?.[1] || !decision || !(DECISIONS as readonly string[]).includes(decision)) {
			throw new Error(`Cannot read "${segment}". Use: /charter decide <ref> <${DECISIONS.join("|")}> <your answer or reason> ; <ref> ...`);
		}
		decisions.push({ ref: match[1], decision: decision as DecisionInput["decision"], text: (match[3] ?? "").trim() });
	}
	if (decisions.length === 0) throw new Error(`Usage: /charter decide <ref> <${DECISIONS.join("|")}> <your answer or reason> ; <ref> ...`);
	return decisions;
}

function buildHandlers(session: CharterSession): { handlers: Record<string, Handler>; enable: (ctx: ExtensionCommandContext) => Promise<void>; show: (message: string) => void } {
	const { pi } = session;

	/** Short messages go to the notification area; long ones into the transcript. */
	const say = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};
	const show = (message: string): void => {
		pi.sendMessage({ customType: "charter", content: message, display: true });
	};
	/** Hand control to the model with a developer-authored instruction. */
	const instruct = (ctx: ExtensionContext, message: string): void => {
		if (ctx.isIdle()) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "followUp" });
	};

	const resolveId = async (engine: Engine, argument: string): Promise<string> => {
		const wanted = argument.trim();
		if (wanted === "") return session.requireActive();
		if (isCharterId(wanted)) return wanted;
		// "3" or "003" names charter 003-...; anything else is matched as part of the id.
		const charters = await engine.store.list();
		const byNumber = /^\d+$/.test(wanted) ? charters.filter((entry) => Number.parseInt(entry.id, 10) === Number.parseInt(wanted, 10)) : [];
		const matches = byNumber.length > 0 ? byNumber : charters.filter((entry) => entry.id.includes(wanted));
		if (matches.length === 1 && matches[0]) return matches[0].id;
		throw new Error(matches.length === 0 ? `No charter matches "${wanted}".` : `"${wanted}" matches several charters: ${matches.map((entry) => entry.id).join(", ")}`);
	};

	const enable = async (ctx: ExtensionCommandContext): Promise<void> => {
		const engine = await session.engine(ctx);
		const { sources } = await session.loadConfig(ctx);

		// Fail early on a configured model Pi does not offer, instead of at the first run.
		const available = new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`));
		for (const role of enabledRoles(engine.config)) {
			const model = engine.config.roles[role].model;
			if (model && !available.has(model)) throw new Error(`The ${role} model "${model}" is not available in Pi. Authenticate its provider or change it with /charter setup.`);
			if (!model && !ctx.model) throw new Error(`The ${role} inherits the session model, but no model is selected in this session.`);
		}

		let active = session.activeId;
		if (active && !(await pathExists(engine.store.charter(active).statePath))) active = null;
		const charters = await engine.store.list();
		if (!active && ctx.hasUI && charters.length > 0) {
			const fresh = "Start a new charter";
			const open = charters.filter((entry) => entry.stage !== "done");
			const choice = await ctx.ui.select("Charter", [fresh, ...[...open, ...charters.filter((entry) => entry.stage === "done")].map((entry) => `${entry.id} — ${entry.stage} — ${entry.title}`)]);
			if (choice === undefined) return;
			if (choice !== fresh) active = choice.split(" — ")[0] ?? null;
		}
		session.setMode(true, active);
		await session.refreshStatus(ctx);

		const roles = enabledRoles(engine.config);
		say(
			ctx,
			[
				"Charter mode on.",
				roles.length === 0 ? "Phases: specification only (implementer disabled)." : `Phases: ${roles.map((role) => describeRole(engine.config, role)).join(" -> ")}`,
				engine.config.checks.length > 0 ? `Checks: ${engine.config.checks.map((check) => check.name).join(", ")}` : "Checks: none configured (/charter setup can detect them).",
				sources.length === 0 ? "Using built-in defaults; run /charter setup to choose models and checks." : `Configuration: ${sources.join(", ")}`,
				active ? `Active charter: ${active}` : "Describe the change you want; a charter will be drafted with you.",
			].join("\n"),
		);
	};

	const setup = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.hasUI) throw new Error(`Setup is interactive. Without a UI, edit ${session.locations(ctx).project} by hand (see docs/configuration.md).`);
		const { config: current } = await session.loadConfig(ctx);
		const config = cloneConfig(current);
		const scoped = ctx.scopedModels.map((entry) => entry.model);
		const models = (scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable()).map((model) => `${model.provider}/${model.id}`).sort();

		for (const role of ROLES) {
			const settings = config.roles[role];
			const purpose: Record<Role, string> = {
				implementer: "writes the code (off = specification only)",
				auditor: "independently checks every acceptance criterion",
				refiner: "simplifies accepted code, guarded by checks",
			};
			const yes = `Enable the ${role} — ${purpose[role]}`;
			const no = `Disable the ${role}`;
			const enabled = await ctx.ui.select(`${role[0]?.toUpperCase()}${role.slice(1)}`, settings.enabled ? [yes, no] : [no, yes]);
			if (enabled === undefined) return;
			settings.enabled = enabled === yes;
			if (!settings.enabled) {
				if (role === "implementer") break;
				continue;
			}
			const currentModel = settings.model ?? INHERIT;
			const model = await ctx.ui.select(`Model for the ${role}`, [currentModel, ...[INHERIT, ...models].filter((entry) => entry !== currentModel)]);
			if (model === undefined) return;
			settings.model = model === INHERIT ? null : model;
			const thinking = await ctx.ui.select(`Thinking level for the ${role}`, [settings.thinking, ...THINKING_LEVELS.filter((level) => level !== settings.thinking)]);
			if (thinking === undefined) return;
			settings.thinking = thinking as ThinkingLevel;
			if (role === "auditor") {
				const shards = await ctx.ui.select("Parallel auditors (criteria are split between them)", ["1", "2", "3", "4"].sort((a, b) => (a === String(config.roles.auditor.shards) ? -1 : b === String(config.roles.auditor.shards) ? 1 : 0)));
				if (shards === undefined) return;
				config.roles.auditor.shards = Number(shards);
			}
		}

		if (config.roles.implementer.enabled) {
			const detected = await detectChecks(ctx.cwd);
			if (config.checks.length > 0) {
				const keep = await ctx.ui.confirm("Project checks", `Keep the configured checks?\n${config.checks.map((check) => `${check.name}: ${check.run}`).join("\n")}`);
				if (!keep) config.checks = [];
			}
			if (config.checks.length === 0 && detected.length > 0) {
				const use = await ctx.ui.confirm("Project checks", `Run these after every implementation and refinement?\n${detected.map((check) => `${check.name}: ${check.run}`).join("\n")}`);
				if (use) config.checks = detected;
			}
			if (config.checks.length === 0) {
				const command = await ctx.ui.input("Command that verifies the project (blank for none)", "npm test");
				if (command?.trim()) config.checks = [{ name: "check", run: command.trim(), timeoutSeconds: 600 }];
			}
		}

		const target = session.locations(ctx).project;
		await saveConfig(target, config);
		say(ctx, `Saved ${target}.`);
	};

	const doctor = async (ctx: ExtensionCommandContext): Promise<void> => {
		const lines: string[] = ["Charter doctor", ""];
		let problems = 0;
		const bad = (message: string): void => {
			problems++;
			lines.push(`FAIL  ${message}`);
		};
		const ok = (message: string): void => {
			lines.push(`ok    ${message}`);
		};
		try {
			const { config, sources } = await session.loadConfig(ctx);
			ok(sources.length === 0 ? "configuration: built-in defaults" : `configuration: ${sources.join(" <- ")}`);
			if (!ctx.isProjectTrusted()) lines.push("note  the project is not trusted, so its configuration file is ignored");
			const available = new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`));
			const roles = enabledRoles(config);
			if (roles.length === 0) ok("phases: specification only");
			for (const role of roles) {
				const model = config.roles[role].model;
				if (model && !available.has(model)) bad(`${role}: model "${model}" is not available in Pi`);
				else if (!model && !ctx.model) bad(`${role}: inherits the session model, but none is selected`);
				else ok(describeRole(config, role));
			}
			const git = config.git.checkpoints ? await GitWorkspace.open(ctx.cwd, [config.directory]) : undefined;
			if (git) ok(`git: checkpoints enabled (repository ${git.root})`);
			else if (!config.git.checkpoints) lines.push("note  git checkpoints are disabled: no change lists, no read-only enforcement for auditors, no rollback, no refinement");
			else lines.push("note  no git repository here: no change lists, no read-only enforcement for auditors, no rollback, no refinement");
			if (config.checks.length === 0) lines.push("note  no project checks configured; only agents verify the work");
			for (const check of config.checks) ok(`check ${check.name}: ${check.run} (limit ${check.timeoutSeconds}s)`);
			const engine = await session.engine(ctx);
			ok(`charters: ${(await engine.store.list()).length} in ${engine.store.relativeRoot}/`);
		} catch (error) {
			bad(errorMessage(error));
		}
		lines.push("", problems === 0 ? "No problems found." : `${problems} problem(s) found.`);
		show(lines.join("\n"));
	};

	const handlers: Record<string, Handler> = {
		async on(_argument, ctx) {
			await enable(ctx);
		},
		async off(_argument, ctx) {
			session.setMode(false);
			await session.refreshStatus(ctx);
			say(ctx, "Charter mode off. Charters on disk are untouched; /charter resume continues one.");
		},
		async new(argument, ctx) {
			if (argument.trim() === "") throw new Error("Usage: /charter new <title>");
			const engine = await session.engine(ctx);
			const state = await engine.create(argument, await session.templates());
			session.setMode(true, state.id);
			await session.refreshStatus(ctx);
			instruct(ctx, `I created charter ${state.id} ("${state.title}"). Help me draft its brief and spec: ask me what you need to know, one question at a time.`);
		},
		async resume(argument, ctx) {
			const engine = await session.engine(ctx);
			let id: string | undefined;
			if (argument.trim() !== "") id = await resolveId(engine, argument);
			else {
				const charters = await engine.store.list();
				if (charters.length === 0) throw new Error("There are no charters yet. Use /charter new <title>.");
				if (!ctx.hasUI) throw new Error(`Usage: /charter resume <id>. Available: ${charters.map((entry) => entry.id).join(", ")}`);
				const choice = await ctx.ui.select("Resume charter", charters.map((entry) => `${entry.id} — ${entry.stage} — ${entry.title}`));
				id = choice?.split(" — ")[0];
			}
			if (!id) return;
			const state = await engine.store.charter(id).load();
			session.setMode(true, id);
			await session.refreshStatus(ctx);
			show(describeStatus(state, { config: engine.config, directory: engine.store.relativeRoot, pendingText: await engine.describePending(id) }));
		},
		async list(_argument, ctx) {
			const engine = await session.engine(ctx);
			const charters = await engine.store.list();
			show(charters.length === 0 ? "No charters yet." : charters.map((entry) => `${entry.id === session.activeId ? "*" : " "} ${entry.id}  ${entry.stage.padEnd(9)}  ${entry.title}`).join("\n"));
		},
		async status(_argument, ctx) {
			const engine = await session.engine(ctx);
			const id = session.requireActive();
			const state = await engine.store.charter(id).load();
			show(describeStatus(state, { config: engine.config, directory: engine.store.relativeRoot, pendingText: await engine.describePending(id) }));
		},
		async lint(argument, ctx) {
			const engine = await session.engine(ctx);
			const lint = await engine.lint(await resolveId(engine, argument));
			show(`${lint.errors} error(s), ${lint.warnings} warning(s)\n${formatDiagnostics(lint.diagnostics)}`);
		},
		async approve(argument, ctx) {
			const engine = await session.engine(ctx);
			const id = await resolveId(engine, argument);
			const preview = await engine.previewApproval(id);
			if (preview.lint.errors > 0) {
				show(`Charter ${id} cannot be approved yet:\n${formatDiagnostics(preview.lint.diagnostics.filter((d) => d.severity === "error"))}`);
				return;
			}
			// Typing the command is the approval; with a UI, show what is being approved first.
			if (ctx.hasUI && !(await ctx.ui.confirm(`Approve charter ${id}?`, approvalMessage(preview, engine)))) return;
			const state = await engine.approve(id);
			session.setMode(true, id);
			await session.refreshStatus(ctx);
			instruct(
				ctx,
				state.stage === "done"
					? `I approved charter ${id}. Call charter_advance to produce the final report.`
					: `I approved charter ${id} (revision ${state.revision}). Call charter_advance to run the pipeline.`,
			);
		},
		async decide(argument, ctx) {
			const engine = await session.engine(ctx);
			const id = session.requireActive();
			const decisions = parseDecisions(argument);
			const state = await engine.resolve(id, decisions);
			await session.refreshStatus(ctx);
			say(ctx, `Recorded ${decisions.length} decision(s) for ${id}.`);
			instruct(
				ctx,
				state.stage === "drafting"
					? `I recorded my decisions for charter ${id}; the spec has to change. Revise the documents with me accordingly, then lint and request approval again.`
					: `I recorded my decisions for charter ${id}. Call charter_advance to continue.`,
			);
		},
		async go(argument, ctx) {
			const engine = await session.engine(ctx);
			const id = await resolveId(engine, argument);
			const state = await engine.grantCycle(id);
			session.setMode(true, id);
			if (!isRunnable(state.stage) && state.stage !== "done") {
				show(describeStatus(state, { config: engine.config, directory: engine.store.relativeRoot, pendingText: await engine.describePending(id) }));
				return;
			}
			instruct(ctx, `Continue charter ${id}: call charter_advance.`);
		},
		async reopen(argument, ctx) {
			const engine = await session.engine(ctx);
			const id = await resolveId(engine, argument);
			await engine.reopen(id);
			session.setMode(true, id);
			await session.refreshStatus(ctx);
			instruct(ctx, `I reopened charter ${id} for revision. The documents are editable again. Ask me what should change, then revise them with me.`);
		},
		async skip(argument, ctx) {
			const engine = await session.engine(ctx);
			const id = session.requireActive();
			const before = await engine.store.charter(id).load();
			const state = await engine.skip(id, argument);
			await session.refreshStatus(ctx);
			say(ctx, `Skipped "${before.stage}" for ${id}; it will be listed as not performed in the final report.`, "warning");
			if (isRunnable(state.stage) || state.stage === "done") instruct(ctx, `I skipped the ${before.stage} step of charter ${id}. Call charter_advance to continue.`);
		},
		async rollback(argument, ctx) {
			const engine = await session.engine(ctx);
			const id = session.requireActive();
			const label = argument.trim() || "baseline";
			if (ctx.hasUI && !(await ctx.ui.confirm(`Roll back charter ${id}?`, `Project files are restored to checkpoint "${label}". Changes made since then, by agents or by you, are lost. Charter documents and reports are kept.`))) return;
			const { restored } = await engine.rollback(id, label);
			await session.refreshStatus(ctx);
			show(`Rolled back to checkpoint "${label}": ${restored.length} file(s) restored or removed. Charter ${id} is back in drafting.${restored.length > 0 ? `\n${restored.slice(0, 40).join("\n")}` : ""}`);
		},
		async prune(argument, ctx) {
			const engine = await session.engine(ctx);
			const id = await resolveId(engine, argument);
			const removed = await engine.prune(id);
			say(ctx, removed === 0 ? `Charter ${id} has no checkpoints to delete.` : `Deleted ${removed} checkpoint(s) of charter ${id}. Rollback is no longer possible for it.`);
		},
		async log(argument, ctx) {
			const engine = await session.engine(ctx);
			const events = await engine.store.charter(session.requireActive()).readJournal(Number.parseInt(argument, 10) || 20);
			show(events.map(({ at, event, ...data }) => `${at}  ${event}${Object.keys(data).length > 0 ? `  ${JSON.stringify(data)}` : ""}`).join("\n") || "The journal is empty.");
		},
		async report(argument, ctx) {
			const engine = await session.engine(ctx);
			const charter = engine.store.charter(await resolveId(engine, argument));
			const state = await charter.load();
			if (state.stage !== "done") throw new Error(`Charter ${charter.id} is not finished (stage "${state.stage}"). Use /charter status.`);
			show((await readTextIfExists(charter.summaryPath)) ?? (await engine.finalize(charter, state)));
		},
		async setup(_argument, ctx) {
			await setup(ctx);
		},
		async doctor(_argument, ctx) {
			await doctor(ctx);
		},
		async help() {
			show(["/charter commands:", ...SUBCOMMANDS.map(([name, help]) => `  /charter ${name} ${help}`)].join("\n"));
		},
	};

	return { handlers, enable, show };
}

const built = new WeakMap<CharterSession, ReturnType<typeof buildHandlers>>();

/** Run `/charter <subcommand> [argument]`. */
export async function runCommand(session: CharterSession, args: string, ctx: ExtensionCommandContext): Promise<void> {
	session.touch(ctx);
	let entry = built.get(session);
	if (!entry) {
		entry = buildHandlers(session);
		built.set(session, entry);
	}
	const { handlers, enable, show } = entry;
	const trimmed = args.trim();
	const space = trimmed.search(/\s/);
	const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
	const argument = space === -1 ? "" : trimmed.slice(space + 1);
	try {
		if (name === "") {
			if (!session.enabled) await enable(ctx);
			else if (session.activeId) await handlers.status?.("", ctx);
			else await handlers.help?.("", ctx);
			return;
		}
		const handler = handlers[name];
		if (!handler) throw new Error(`Unknown subcommand "${name}". Try /charter help.`);
		await handler(argument, ctx);
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(errorMessage(error), "error");
		else show(`Charter: ${errorMessage(error)}`);
	}
}
