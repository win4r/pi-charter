/**
 * Runs one agent (implementer, auditor or refiner) as an in-process Pi SDK
 * session and reports how it ended.
 *
 * Design points that matter for speed and cost:
 * - one `ModelRuntime` is shared by every child, so credentials and model
 *   catalogs are loaded once per main session, not once per run;
 * - the report tool ends the run the moment a valid report is filed
 *   (`terminate: true`), saving the closing model round trip;
 * - an invalid report is rejected inside the same session, where the context
 *   is still cached, instead of failing the run.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	type ExtensionAPI,
	type InlineExtension,
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

import { REPORT_NUDGE } from "../core/briefs.ts";
import { isWithin, resolveToolPath } from "../core/fsx.ts";
import { errorMessage, type Role, type UsageTotals, ZERO_USAGE } from "../core/types.ts";
import type { RoleRunner, RoleRunRequest, RoleRunResult } from "../engine/pipeline.ts";

export const PACKAGE_NAME = "pi-charter";
export const REPORT_TOOL = "charter_report";

// -------------------------------------------------------------- report schemas

const criterionOutcome = (results: readonly string[]): TSchema =>
	Type.Object({
		id: Type.String({ description: "Acceptance criterion id exactly as in spec.md, e.g. AC3" }),
		result: StringEnum(results as readonly [string, ...string[]]),
		evidence: Type.String({ description: "What you ran or inspected and what you observed. Concrete: command + relevant output, or file:line." }),
	});

const REPORT_SCHEMAS: Record<Role, { description: string; parameters: TSchema }> = {
	implementer: {
		description:
			"File your implementation report. This is the only way your work is accepted; calling it ends your run. " +
			'Use status "done" only when every acceptance criterion passes. Use status "blocked" with questions when a decision belongs to the developer.',
		parameters: Type.Object({
			status: StringEnum(["done", "blocked"] as const),
			summary: Type.String({ description: "What you changed and how, in a few sentences." }),
			criteria: Type.Array(criterionOutcome(["pass", "fail", "untested"]), { description: "One entry per acceptance criterion of the spec." }),
			filesChanged: Type.Optional(Type.Array(Type.String(), { description: "Project-relative paths you created, modified or deleted." })),
			notes: Type.Optional(Type.Array(Type.String(), { description: "Things the developer should know: trade-offs, follow-ups, risks." })),
			questions: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String(),
						detail: Type.String({ description: "What you found, why it blocks you, and why you cannot decide it yourself." }),
						options: Type.Array(Type.Object({ label: Type.String(), consequence: Type.String() })),
						recommendation: Type.Optional(Type.String()),
					}),
					{ description: 'Required when status is "blocked".' },
				),
			),
		}),
	},
	auditor: {
		description:
			"File your audit report. This is the only way your audit is recorded; calling it ends your run. " +
			"Report a result with evidence for every assigned criterion, and a finding for everything that does not pass.",
		parameters: Type.Object({
			criteria: Type.Array(criterionOutcome(["pass", "fail", "untested"]), { description: 'One entry per assigned criterion. Use "untested" only when you could not verify it, and file a finding saying why.' }),
			findings: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String(),
						severity: StringEnum(["critical", "major", "minor"] as const),
						criterion: Type.Optional(Type.String({ description: "The acceptance criterion this finding is about, if any." })),
						detail: Type.String({ description: "The defect and its practical effect." }),
						evidence: Type.String({ description: "How to observe it: command + output, or file:line." }),
						suggestion: Type.Optional(Type.String()),
					}),
				),
			),
			notes: Type.Optional(Type.Array(Type.String())),
		}),
	},
	refiner: {
		description: "File your refinement report. Calling it ends your run. Call it even when you decided that nothing should change.",
		parameters: Type.Object({
			summary: Type.String({ description: "What you simplified, or why nothing needed to change." }),
			filesChanged: Type.Optional(Type.Array(Type.String())),
			notes: Type.Optional(Type.Array(Type.String())),
		}),
	},
};

// ------------------------------------------------------------------- helpers

const ownPackageCache = new Map<string, boolean>();

/** True when an extension path belongs to this package (any installed copy of it). */
export function isOwnExtension(path: string): boolean {
	if (path.startsWith("builtin:") || path.startsWith("<")) return false;
	const cached = ownPackageCache.get(path);
	if (cached !== undefined) return cached;
	let own = false;
	try {
		let dir = dirname(realpathSync(path));
		for (let depth = 0; depth < 6; depth++) {
			try {
				const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
				own = typeof manifest === "object" && manifest !== null && "name" in manifest && manifest.name === PACKAGE_NAME;
				break;
			} catch {
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		}
	} catch {
		own = false;
	}
	ownPackageCache.set(path, own);
	return own;
}

function firstLine(text: string, limit = 110): string {
	const line = text.split("\n").find((entry) => entry.trim() !== "") ?? "";
	const trimmed = line.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function describeToolCall(toolName: string, args: unknown): string {
	const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	for (const key of ["command", "path", "pattern", "query"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim() !== "") return `${toolName}: ${firstLine(value, 90)}`;
	}
	return toolName;
}

/** File tools that write, and the argument that names their target. */
const WRITE_TOOLS: Record<string, string> = { write: "path", edit: "path" };

export interface ChildHost {
	agentDir: string;
	/** Model of the main session, used when a role inherits it. */
	sessionModel(): { provider: string; id: string } | undefined;
	/** Directory of the main session's files; child transcripts are saved below it. */
	sessionDir(): string | undefined;
	/** Role instructions appended to the child's system prompt. */
	rolePrompt(role: Role): Promise<string>;
	/** Test seam: a ready model runtime. Production creates and caches one. */
	modelRuntime?: ModelRuntime;
	/** How long a stopped agent may take to wind down before it is abandoned. Default 10 s. */
	abortGraceMs?: number;
}

const DEFAULT_ABORT_GRACE_MS = 10_000;

/** Resolve with the promise, or with `undefined` once `ms` have passed. Never rejects. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}

/** The saved session file of an agent, once Pi has actually written it. */
function transcriptOf(sessionManager: SessionManager | undefined): string | undefined {
	const file = sessionManager?.getSessionFile();
	return file && existsSync(file) ? file : undefined;
}

export class PiRoleRunner implements RoleRunner {
	private readonly host: ChildHost;
	private runtime: ModelRuntime | undefined;

	constructor(host: ChildHost) {
		this.host = host;
		this.runtime = host.modelRuntime;
	}

	async run(request: RoleRunRequest): Promise<RoleRunResult> {
		const started = performance.now();
		const elapsed = (): number => Math.round(performance.now() - started);
		let session: AgentSession | undefined;
		let sessionManager: SessionManager | undefined;
		let usage: UsageTotals = { ...ZERO_USAGE };
		let modelName: string | undefined;
		let reported = false;
		let timedOut = false;

		const stop = new AbortController();
		const onParentAbort = (): void => stop.abort();
		request.signal?.addEventListener("abort", onParentAbort, { once: true });
		// Deliberately not unref'd: when a provider call hangs without keeping the event loop alive,
		// this timer is the only thing that still ends the run.
		const timer =
			request.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						stop.abort();
					}, request.timeoutMs)
				: undefined;

		const finish = (outcome: RoleRunResult["outcome"], error?: string): RoleRunResult => ({
			outcome,
			usage,
			durationMs: elapsed(),
			...(error ? { error } : {}),
			...(modelName ? { model: modelName } : {}),
			...(transcriptOf(sessionManager) ? { transcript: transcriptOf(sessionManager) } : {}),
		});

		try {
			if (request.signal?.aborted) return finish("aborted");

			const wanted = request.model ?? (() => {
				const inherited = this.host.sessionModel();
				return inherited ? `${inherited.provider}/${inherited.id}` : undefined;
			})();
			if (!wanted) return finish("failed", `no model is configured for the ${request.role} and the main session has none to inherit`);
			modelName = wanted;

			const schema = REPORT_SCHEMAS[request.role];
			const guard = (pi: ExtensionAPI): void => {
				pi.registerTool({
					name: REPORT_TOOL,
					label: "Charter report",
					description: schema.description,
					promptSnippet: "File the structured report that ends this run",
					parameters: schema.parameters,
					executionMode: "sequential",
					async execute(_toolCallId, params) {
						// Throws with the list of problems; the agent sees it and can resubmit.
						request.submit(params);
						reported = true;
						return { content: [{ type: "text", text: "Report recorded. Your run is complete." }], details: undefined, terminate: true };
					},
				});
				pi.on("tool_call", (event) => {
					const argument = WRITE_TOOLS[event.toolName];
					if (!argument) return undefined;
					const raw = (event.input as Record<string, unknown>)[argument];
					if (typeof raw !== "string") return undefined;
					const target = resolveToolPath(request.cwd, raw);
					if (request.protectedPaths.some((path) => isWithin(path, target))) {
						return { block: true, reason: "Charter documents, reports and state are frozen. Only the developer can change them; report a question instead." };
					}
					if (request.writableOnly && !isWithin(request.writableOnly, target)) {
						return { block: true, reason: `This role is read-only for project files. Write throwaway files below ${request.writableOnly} instead.` };
					}
					return undefined;
				});
			};

			const rolePrompt = await this.host.rolePrompt(request.role);
			const extensionFactories: InlineExtension[] = [
				// The CLI ships these as built-ins; SDK sessions have to ask for them.
				{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
				{ name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
				{ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
				{ name: "charter-agent", factory: guard, hidden: true },
			];
			const services = await createAgentSessionServices({
				cwd: request.cwd,
				agentDir: this.host.agentDir,
				...(this.runtime ? { modelRuntime: this.runtime } : {}),
				modelRuntimeSignal: stop.signal,
				resourceLoaderOptions: {
					extensionFactories,
					// An agent must never see the coordinator's tools or commands.
					extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((extension) => !isOwnExtension(extension.resolvedPath || extension.path)) }),
					appendSystemPromptOverride: (base) => [...base, rolePrompt],
				},
			});
			this.runtime ??= services.modelRuntime;

			// Pi itself keeps going when one of the user's extensions fails to load; so does an agent.
			// The problem is surfaced, because a missing extension can explain odd agent behavior.
			const loadErrors = services.resourceLoader.getExtensions().errors;
			if (loadErrors.length > 0) request.onActivity?.(`${loadErrors.length} extension(s) failed to load for this agent: ${loadErrors.map(({ path }) => path).join(", ")}`);

			const slash = wanted.indexOf("/");
			const provider = wanted.slice(0, slash);
			const modelId = wanted.slice(slash + 1);
			const model =
				services.modelRuntime.getModel(provider, modelId) ??
				(await services.modelRuntime.getAvailable()).find((entry) => entry.provider === provider && entry.id === modelId);
			if (!model) return finish("failed", `model "${wanted}" is not available in Pi (check the id and that the provider is authenticated)`);

			const sessionDir = this.host.sessionDir();
			sessionManager = sessionDir ? SessionManager.create(request.cwd, join(sessionDir, "charter-agents")) : SessionManager.inMemory(request.cwd);
			({ session } = await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: request.thinking }));
			const live = session;

			let lastSent = 0;
			const unsubscribe = live.subscribe((event: AgentSessionEvent) => {
				if (!request.onActivity) return;
				if (event.type === "tool_execution_start") {
					request.onActivity(describeToolCall(event.toolName, event.args));
					lastSent = performance.now();
				} else if (event.type === "message_end" && event.message.role === "assistant") {
					const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
					if (text.trim() !== "" && performance.now() - lastSent > 250) request.onActivity(firstLine(text));
				}
			});
			// A stop request aborts the session. A provider that ignores the abort must not be able
			// to hold the pipeline hostage, so after a grace period the run is abandoned.
			const grace = this.host.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
			let abandon: (() => void) | undefined;
			let graceTimer: NodeJS.Timeout | undefined;
			const abandoned = new Promise<void>((resolve) => {
				abandon = resolve;
			});
			const onStop = (): void => {
				void live.abort().catch(() => {});
				graceTimer = setTimeout(() => abandon?.(), grace);
			};
			stop.signal.addEventListener("abort", onStop, { once: true });
			const turn = (text: string): Promise<void> => Promise.race([live.prompt(text, { expandPromptTemplates: false }), abandoned]);

			try {
				await live.bindExtensions({ mode: "print" });
				if (stop.signal.aborted) return finish(timedOut ? "timeout" : "aborted");
				await turn(request.prompt);
				for (let nudge = 0; nudge < request.nudges && !reported && !stop.signal.aborted; nudge++) {
					const last = live.messages.findLast((message) => message.role === "assistant");
					if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) break;
					request.onActivity?.("reminding the agent to file its report");
					await turn(REPORT_NUDGE);
				}
			} finally {
				clearTimeout(graceTimer);
				unsubscribe();
				stop.signal.removeEventListener("abort", onStop);
				const stats = live.getSessionStats();
				usage = { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, cost: stats.cost };
			}

			if (reported) return finish("reported");
			if (timedOut) return finish("timeout");
			if (stop.signal.aborted) return finish("aborted");
			const last = live.messages.findLast((message) => message.role === "assistant");
			if (last?.role === "assistant" && last.stopReason === "error") return finish("failed", last.errorMessage || "the model request failed");
			if (last?.role === "assistant" && last.stopReason === "aborted") return finish("aborted");
			return finish("no-report");
		} catch (error) {
			if (timedOut) return finish("timeout");
			if (stop.signal.aborted) return finish("aborted");
			return finish("failed", errorMessage(error));
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onParentAbort);
			if (session) {
				const grace = this.host.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
				await within(session.abort(), grace);
				// dispose() does not announce shutdown; extensions such as MCP need it to close connections.
				// Shutdown handlers must not turn a finished run into a failure, nor stall it.
				await within(session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }), grace);
				session.dispose();
			}
		}
	}
}
