/**
 * The pipeline engine. It owns every state change of a charter and drives the
 * steps (implement -> checks -> audit -> refine) until the work is done or a
 * developer decision is needed.
 *
 * The engine knows nothing about Pi: agents are reached through `RoleRunner`,
 * so the whole workflow runs in tests with a scripted runner.
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditorBrief, type BriefDocuments, implementerBrief, partitionCriteria, refinerBrief } from "../core/briefs.ts";
import type { CharterConfig } from "../core/config.ts";
import { type DecisionInput, resolveFindings, resolveQuestions } from "../core/decisions.ts";
import { readJsonIfExists, readTextIfExists, writeJsonAtomic, writeTextAtomic } from "../core/fsx.ts";
import { runChecks } from "../core/gate.ts";
import { type FileChange, GitWorkspace } from "../core/git.ts";
import { transition } from "../core/machine.ts";
import {
	type AuditReport,
	type AuditSubmission,
	buildImplementerReport,
	type GateReport,
	gateFindings,
	type ImplementerReport,
	type ImplementerSubmission,
	mergeAuditSubmissions,
	type RefineReport,
	type RefinerSubmission,
	validateAuditSubmission,
	validateImplementerSubmission,
	validateRefinerSubmission,
} from "../core/reports.ts";
import { criterionIds, formatDiagnostics, lintDocuments, type LintResult, readDocuments } from "../core/spec/lint.ts";
import type { CharterState, RunOutcome, RunRecord } from "../core/state.ts";
import type { Charter, CharterStore } from "../core/store.ts";
import { buildFinalReport, describeFindings, describeQuestions } from "../core/summary.ts";
import { addUsage, CharterError, errorMessage, isRecord, type Role, type ThinkingLevel, type UsageTotals, ZERO_USAGE } from "../core/types.ts";

// ------------------------------------------------------------------ contracts

export interface RoleRunRequest {
	role: Role;
	/** Report or shard label, e.g. `impl-2` or `audit-1#3`. */
	label: string;
	cwd: string;
	prompt: string;
	/** `null` means "use the main session's model". */
	model: string | null;
	thinking: ThinkingLevel;
	/** `0` disables the limit. */
	timeoutMs: number;
	/** Reminders to send if the agent stops without reporting. */
	nudges: number;
	/**
	 * Accept the agent's report. Throws `CharterError` listing what is wrong,
	 * which the agent sees and can correct in the same session.
	 */
	submit(submission: unknown): void;
	/** Absolute paths the agent's file tools must refuse to modify. */
	protectedPaths: string[];
	/** When set, file-writing tools are refused everywhere except below this directory. */
	writableOnly?: string;
	signal?: AbortSignal;
	onActivity?(text: string): void;
}

export interface RoleRunResult {
	outcome: "reported" | "no-report" | "failed" | "aborted" | "timeout";
	error?: string;
	model?: string;
	usage: UsageTotals;
	transcript?: string;
	durationMs: number;
}

export interface RoleRunner {
	run(request: RoleRunRequest): Promise<RoleRunResult>;
}

export interface PipelineObserver {
	/** A step started or changed, e.g. `implementer impl-2` or `check test (2/3)`. */
	onStep?(step: string): void;
	/** Latest activity of one agent, keyed by its label. */
	onActivity?(label: string, text: string): void;
	/** Something the developer should know now (a restore, a skipped step, ...). */
	onNotice?(text: string): void;
}

export interface EngineOptions {
	projectRoot: string;
	config: CharterConfig;
	store: CharterStore;
	runner: RoleRunner;
	/** `null` disables git features; `undefined` detects the repository. */
	git?: GitWorkspace | null;
	now?: () => Date;
	scratchRoot?: string;
}

export interface AdvanceOptions extends PipelineObserver {
	signal?: AbortSignal;
	/** Ask the developer for one more implementation cycle once the budget is spent. */
	confirmExtraCycle?(state: CharterState): Promise<boolean>;
}

export type AdvanceResult =
	| { status: "done"; state: CharterState; report: string }
	| { status: "waiting"; state: CharterState; waitingFor: "approval" | "answers" | "triage"; text: string }
	| { status: "halted"; state: CharterState; reason: string };

export interface ApprovalPreview {
	state: CharterState;
	lint: LintResult;
	documents: string[];
}

class Halt extends Error {}

/** What a partly failed audit attempt leaves behind for its retry. */
interface PartialAudit {
	/** Work tree the finished auditors examined. */
	tree: string;
	revision: number;
	groups: string[][];
	submissions: Array<AuditSubmission | null>;
	drift: string[];
}

async function readPartialAudit(path: string): Promise<PartialAudit | undefined> {
	try {
		const raw = await readJsonIfExists(path);
		if (!isRecord(raw) || typeof raw.tree !== "string" || !Array.isArray(raw.groups) || !Array.isArray(raw.submissions) || !Array.isArray(raw.drift)) return undefined;
		return raw as unknown as PartialAudit;
	} catch {
		// A damaged leftover only costs a full re-audit.
		return undefined;
	}
}

/**
 * Charters with a step in flight in this process (the lock file covers other
 * processes). Kept on `globalThis` because a host may evaluate this module
 * more than once, and every copy must see the same set.
 */
const BUSY_KEY = Symbol.for("pi-charter.busy");
const registry = globalThis as { [BUSY_KEY]?: Set<string> };
const busy: Set<string> = (registry[BUSY_KEY] ??= new Set<string>());

// --------------------------------------------------------------------- engine

export class Engine {
	readonly config: CharterConfig;
	readonly store: CharterStore;
	private readonly projectRoot: string;
	private readonly runner: RoleRunner;
	private readonly now: () => Date;
	private readonly scratchRoot: string;
	private gitPromise: Promise<GitWorkspace | undefined> | undefined;

	constructor(options: EngineOptions) {
		this.config = options.config;
		this.store = options.store;
		this.projectRoot = options.projectRoot;
		this.runner = options.runner;
		this.now = options.now ?? (() => new Date());
		this.scratchRoot = options.scratchRoot ?? join(tmpdir(), "pi-charter");
		if (options.git === null) this.gitPromise = Promise.resolve(undefined);
		else if (options.git) this.gitPromise = Promise.resolve(options.git);
	}

	private stamp(): string {
		return this.now().toISOString();
	}

	/** The repository, if checkpoints are enabled and one exists. */
	async git(): Promise<GitWorkspace | undefined> {
		if (this.gitPromise) return this.gitPromise;
		if (!this.config.git.checkpoints) return undefined;
		const opening = GitWorkspace.open(this.projectRoot, [this.store.relativeRoot]);
		this.gitPromise = opening;
		const workspace = await opening;
		// "No repository" is not remembered: the developer may run `git init` at any time.
		if (!workspace && this.gitPromise === opening) this.gitPromise = undefined;
		return workspace;
	}

	/**
	 * Delete the checkpoint refs of a finished charter. The snapshots become
	 * unreachable and git's own garbage collection reclaims them.
	 */
	async prune(id: string): Promise<number> {
		const git = await this.git();
		if (!git) return 0;
		return this.exclusive(id, async (charter) => {
			const state = await charter.load();
			if (state.stage !== "done") throw new CharterError(`Charter "${id}" is not finished (stage "${state.stage}"); its checkpoints are still needed.`);
			const removed = await git.deleteCheckpoints(id);
			state.checkpoints = [];
			await charter.save(state, this.stamp());
			await charter.journal("pruned", { refs: removed }, this.stamp());
			return removed;
		});
	}

	private async exclusive<T>(id: string, work: (charter: Charter) => Promise<T>): Promise<T> {
		const charter = this.store.charter(id);
		if (busy.has(charter.dir)) throw new CharterError(`Charter "${id}" is busy with another step in this session.`);
		busy.add(charter.dir);
		try {
			const lock = await charter.lock();
			try {
				return await work(charter);
			} finally {
				await lock.release();
			}
		} finally {
			busy.delete(charter.dir);
		}
	}

	// --------------------------------------------------------------- lifecycle

	async create(title: string, templates: { brief: string; spec: string }): Promise<CharterState> {
		const { state } = await this.store.create(title, templates, this.stamp());
		return state;
	}

	async lint(id: string): Promise<LintResult> {
		return lintDocuments(await readDocuments(this.store.charter(id).dir), { projectRoot: this.projectRoot });
	}

	/** Everything the developer should see before confirming an approval. */
	async previewApproval(id: string): Promise<ApprovalPreview> {
		const charter = this.store.charter(id);
		const state = await charter.load();
		if (state.stage !== "drafting") throw new CharterError(`Charter "${id}" is at stage "${state.stage}"; only a charter in drafting can be approved. Use /charter reopen to revise an approved one.`);
		const lint = await this.lint(id);
		return { state, lint, documents: await charter.documentFiles() };
	}

	/**
	 * Record the developer's approval. The caller is responsible for having
	 * obtained it from a human; this method only refuses documents that fail lint.
	 */
	async approve(id: string): Promise<CharterState> {
		return this.exclusive(id, async (charter) => {
			const { state, lint } = await this.previewApproval(id);
			if (lint.errors > 0) {
				throw new CharterError(`The charter cannot be approved while lint reports errors:\n${formatDiagnostics(lint.diagnostics.filter((d) => d.severity === "error"))}`);
			}
			const at = this.stamp();
			const documents = await charter.hashDocuments();
			const revision = state.revision + 1;
			await charter.archiveApproved(revision, Object.keys(documents));

			const git = await this.git();
			if (git && !state.baseline && this.config.roles.implementer.enabled) {
				try {
					const { commit } = await git.checkpoint(`${id}/baseline`, `charter ${id}: baseline at approval`);
					state.baseline = commit;
					state.checkpoints.push({ label: "baseline", commit, at });
				} catch (error) {
					state.notes.push(`No baseline checkpoint could be taken (${errorMessage(error)}); change lists and rollback are unavailable.`);
				}
			}

			state.revision = revision;
			state.approval = { revision, at, documents, criteria: criterionIds(lint.spec) };
			state.stage = transition(state.stage, { type: "approve" }, this.config);
			state.cycle = state.stage === "implement" ? 1 : 0;
			state.cycleGrant = 0;
			state.gateAttempts = 0;
			state.fixFrom = [];
			state.pending = null;
			state.active = null;
			// What an earlier revision skipped, noted or produced says nothing about this one.
			// The journal and the numbered reports keep the history.
			state.latest = {};
			state.skipped = [];
			state.notes = state.notes.filter((note) => note.startsWith("No baseline checkpoint"));
			await charter.save(state, at);
			await charter.journal("approved", { revision, criteria: state.approval.criteria.length, documents }, at);
			return state;
		});
	}

	/** Return an approved charter to drafting. Documents become editable again; reports are kept. */
	async reopen(id: string): Promise<CharterState> {
		return this.exclusive(id, async (charter) => {
			const state = await charter.load();
			const at = this.stamp();
			const from = state.stage;
			state.stage = transition(state.stage, { type: "reopen" }, this.config);
			state.approval = null;
			state.pending = null;
			state.fixFrom = [];
			state.active = null;
			await charter.save(state, at);
			await charter.journal("reopened", { from }, at);
			return state;
		});
	}

	/** Developer decision to allow one more implementation cycle after the budget is spent. */
	async grantCycle(id: string): Promise<CharterState> {
		return this.exclusive(id, async (charter) => {
			const state = await charter.load();
			const needed = state.cycle - this.config.limits.cycles;
			if (state.stage === "implement" && needed > state.cycleGrant) {
				state.cycleGrant = needed;
				await charter.save(state, this.stamp());
				await charter.journal("cycle-granted", { cycle: state.cycle }, this.stamp());
			}
			return state;
		});
	}

	/** Developer decision to skip the checks, the audit or the refinement the charter is waiting to run. */
	async skip(id: string, reason?: string): Promise<CharterState> {
		return this.exclusive(id, async (charter) => {
			const state = await charter.load();
			const at = this.stamp();
			const step = state.stage;
			state.stage = transition(state.stage, { type: "skip" }, this.config);
			state.active = null;
			state.skipped.push({ step, reason: `skipped by the developer${reason?.trim() ? `: ${reason.trim()}` : ""}` });
			await charter.save(state, at);
			await charter.journal("skipped", { step, reason: reason ?? null }, at);
			return state;
		});
	}

	/**
	 * Restore the project files to a checkpoint (default: the baseline taken at
	 * approval) and reopen the charter. Charter documents and reports are kept.
	 */
	async rollback(id: string, label = "baseline"): Promise<{ state: CharterState; restored: string[] }> {
		const git = await this.git();
		if (!git) throw new CharterError("Rollback needs a git repository with checkpoints enabled.");
		const restored = await this.exclusive(id, async (charter) => {
			const state = await charter.load();
			const checkpoint = state.checkpoints.findLast((entry) => entry.label === label);
			if (!checkpoint) {
				throw new CharterError(`No checkpoint "${label}". Available: ${state.checkpoints.map((entry) => entry.label).join(", ") || "none"}.`);
			}
			// A rollback must itself be undoable: keep what is about to be overwritten.
			await this.checkpoint(state, `before-rollback-${state.checkpoints.filter((entry) => entry.label.startsWith("before-rollback-")).length + 1}`);
			const files = await git.restore(checkpoint.commit);
			await charter.save(state, this.stamp());
			await charter.journal("rolled-back", { checkpoint: label, files: files.length }, this.stamp());
			return files;
		});
		let state = await this.store.charter(id).load();
		if (state.stage !== "drafting") state = await this.reopen(id);
		return { state, restored };
	}

	/** Record developer decisions for every open question or finding, then move on. */
	async resolve(id: string, inputs: readonly DecisionInput[]): Promise<CharterState> {
		return this.exclusive(id, async (charter) => {
			const state = await charter.load();
			const at = this.stamp();
			if (state.stage !== "questions" && state.stage !== "triage") {
				throw new CharterError(`Nothing is waiting for a decision: charter "${id}" is at stage "${state.stage}".`);
			}
			const pending = state.pending;
			if (!pending) throw new CharterError(`Charter "${id}" has no pending report.`);

			if (state.stage === "questions") {
				const { report, revise } = resolveQuestions(await charter.readReport<ImplementerReport>(pending, "implementer"), inputs, at);
				await charter.writeReport(report);
				state.stage = transition(state.stage, { type: "answered", revise }, this.config);
				if (revise) state.approval = null;
				else this.openCycle(state);
				await charter.journal("answered", { report: pending, revise }, at);
			} else {
				const origin = pending.startsWith("gate-") ? "gate" : "audit";
				const current = origin === "gate" ? await charter.readReport<GateReport>(pending, "gate") : await charter.readReport<AuditReport>(pending, "audit");
				const { report, outcome } = resolveFindings(current, inputs, at);
				await charter.writeReport(report);
				state.stage = transition(state.stage, { type: "triaged", outcome, origin }, this.config);
				if (outcome === "revise") state.approval = null;
				if (outcome === "fix") {
					state.fixFrom = [pending];
					this.openCycle(state);
				}
				await charter.journal("triaged", { report: pending, outcome }, at);
			}
			state.pending = null;
			await charter.save(state, at);
			return state;
		});
	}

	private openCycle(state: CharterState): void {
		state.cycle += 1;
		state.gateAttempts = 0;
	}

	/** Text describing the items that await a decision, for presentation to the developer. */
	async describePending(id: string): Promise<string | undefined> {
		const charter = this.store.charter(id);
		const state = await charter.load();
		if (!state.pending) return undefined;
		if (state.stage === "questions") return describeQuestions(await charter.readReport<ImplementerReport>(state.pending, "implementer"));
		if (state.stage === "triage") {
			return describeFindings(
				state.pending.startsWith("gate-") ? await charter.readReport<GateReport>(state.pending, "gate") : await charter.readReport<AuditReport>(state.pending, "audit"),
			);
		}
		return undefined;
	}

	// ----------------------------------------------------------------- advance

	/** Run every step that needs no developer input. */
	async advance(id: string, options: AdvanceOptions = {}): Promise<AdvanceResult> {
		return this.exclusive(id, async (charter) => {
			let state = await charter.load();
			if (state.active) {
				await charter.journal("recovered", { interrupted: state.active.step }, this.stamp());
				state.active = null;
				await charter.save(state, this.stamp());
			}
			try {
				for (;;) {
					if (options.signal?.aborted) throw new Halt("Cancelled. Advance again to continue from this stage.");
					switch (state.stage) {
						case "drafting":
							return { status: "waiting", state, waitingFor: "approval", text: "The charter is in drafting and needs the developer's approval." };
						case "questions":
							return { status: "waiting", state, waitingFor: "answers", text: (await this.describePending(id)) ?? "" };
						case "triage":
							return { status: "waiting", state, waitingFor: "triage", text: (await this.describePending(id)) ?? "" };
						case "implement":
							await this.stepImplement(charter, state, options);
							break;
						case "gate":
							await this.stepGate(charter, state, options);
							break;
						case "audit":
							await this.stepAudit(charter, state, options);
							break;
						case "refine":
							await this.stepRefine(charter, state, options);
							break;
						case "done":
							return { status: "done", state, report: await this.finalize(charter, state) };
					}
					state = await charter.load();
				}
			} catch (error) {
				// Whatever happened, never leave a run marked as live.
				const latest = await charter.load();
				if (latest.active) {
					latest.active = null;
					await charter.save(latest, this.stamp());
				}
				if (error instanceof Halt) {
					await charter.journal("halted", { stage: latest.stage, reason: error.message }, this.stamp());
					return { status: "halted", state: latest, reason: error.message };
				}
				throw error;
			}
		});
	}

	// ------------------------------------------------------------------ helpers

	private async briefDocuments(charter: Charter): Promise<BriefDocuments> {
		const all = await charter.documentFiles();
		const names = all.filter((name) => !name.includes("/"));
		const files = await Promise.all(names.map(async (name) => ({ name, content: (await readTextIfExists(charter.document(name))) ?? "" })));
		return { directory: `${this.store.relativeRoot}/${charter.id}`, files, attachments: all.filter((name) => name.includes("/")) };
	}

	private requireApproval(state: CharterState): NonNullable<CharterState["approval"]> {
		if (!state.approval) throw new CharterError(`Charter "${state.id}" has no approval in force.`);
		return state.approval;
	}

	/** Before a run: refuse to work from documents that no longer match the approval. */
	private async assertFrozen(charter: Charter, state: CharterState): Promise<void> {
		const drift = await charter.documentDrift(this.requireApproval(state).documents);
		if (drift.length > 0) {
			throw new Halt(
				`The approved documents were changed after approval (${drift.join(", ")}). Run /charter reopen to review the edits and approve again; agents only work from approved documents.`,
			);
		}
	}

	/** After a run: an agent must not have altered the contract. Undo it if one did. */
	private async undoDocumentDrift(charter: Charter, state: CharterState, culprit: string, observer: PipelineObserver): Promise<void> {
		const approval = this.requireApproval(state);
		const drift = await charter.documentDrift(approval.documents);
		if (drift.length === 0) return;
		await charter.restoreApproved(approval.revision, approval.documents);
		const note = `${culprit} modified approved documents (${drift.join(", ")}); they were restored to the approved text.`;
		state.notes.push(note);
		observer.onNotice?.(note);
		await charter.journal("documents-restored", { culprit, files: drift }, this.stamp());
	}

	private async checkpoint(state: CharterState, label: string): Promise<{ commit: string; tree: string } | undefined> {
		const git = await this.git();
		if (!git) return undefined;
		try {
			// A `pre-` checkpoint means "before this step was first attempted". A retry must not
			// move it, or the partial work of the failed attempt would become the new "before".
			const existing = state.checkpoints.find((entry) => entry.label === label);
			if (existing && label.startsWith("pre-")) return { commit: existing.commit, tree: await git.snapshot() };
			const checkpoint = await git.checkpoint(`${state.id}/${label}`, `charter ${state.id}: ${label}`);
			state.checkpoints = state.checkpoints.filter((entry) => entry.label !== label);
			state.checkpoints.push({ label, commit: checkpoint.commit, at: this.stamp() });
			return checkpoint;
		} catch (error) {
			state.notes.push(`Checkpoint ${label} could not be taken: ${errorMessage(error)}`);
			return undefined;
		}
	}

	private async changesSinceBaseline(state: CharterState, currentTree?: string): Promise<FileChange[] | undefined> {
		const git = await this.git();
		if (!git || !state.baseline) return undefined;
		try {
			return await git.changes(await git.treeOf(state.baseline), currentTree ?? (await git.snapshot()));
		} catch {
			return undefined;
		}
	}

	private record(state: CharterState, step: RunRecord["step"], label: string, startedAt: string, result: { outcome: RunOutcome; durationMs: number; usage?: UsageTotals; model?: string; transcript?: string; error?: string }): void {
		const usage = result.usage ?? { ...ZERO_USAGE };
		state.runs.push({
			seq: state.runs.length + 1,
			step,
			label,
			startedAt,
			durationMs: result.durationMs,
			outcome: result.outcome,
			usage,
			...(result.model ? { model: result.model } : {}),
			...(result.transcript ? { transcript: result.transcript } : {}),
			...(result.error ? { error: result.error } : {}),
		});
		state.usage = addUsage(state.usage, usage);
	}

	private describeFailure(label: string, result: RoleRunResult): string {
		const where = result.transcript ? ` Transcript: ${result.transcript}` : "";
		switch (result.outcome) {
			case "no-report":
				return `${label} ended without filing its report, so nothing it did is accepted.${where}`;
			case "timeout":
				return `${label} exceeded its time limit and was stopped.${where}`;
			case "aborted":
				return `${label} was cancelled.${where}`;
			default:
				return `${label} failed: ${result.error ?? "unknown error"}.${where}`;
		}
	}

	private async previousImplementerReports(charter: Charter, state: CharterState): Promise<ImplementerReport[]> {
		const reports: ImplementerReport[] = [];
		for (let index = 1; index <= state.counters.impl; index++) {
			try {
				const report = await charter.readReport<ImplementerReport>(`impl-${index}`, "implementer");
				// Answers given under an earlier approval were folded into the revised spec.
				if (report.revision === state.revision && report.questions.some((question) => question.resolution)) reports.push(report);
			} catch {
				// A missing historical report only costs context, never correctness.
			}
		}
		return reports;
	}

	private async decidedReports(charter: Charter, state: CharterState): Promise<Array<AuditReport | GateReport>> {
		const reports: Array<AuditReport | GateReport> = [];
		for (let index = 1; index <= state.counters.audit; index++) {
			try {
				const report = await charter.readReport<AuditReport>(`audit-${index}`, "audit");
				if (report.revision === state.revision) reports.push(report);
			} catch {
				// See above.
			}
		}
		return reports;
	}

	// -------------------------------------------------------------------- steps

	private async stepImplement(charter: Charter, state: CharterState, options: AdvanceOptions): Promise<void> {
		const approval = this.requireApproval(state);
		if (!this.config.roles.implementer.enabled) {
			throw new Halt('The implementer was disabled in the configuration while this charter still needs implementation work. Enable it again, or run /charter reopen.');
		}
		const budget = this.config.limits.cycles + state.cycleGrant;
		if (state.cycle > budget) {
			const granted = (await options.confirmExtraCycle?.(state)) ?? false;
			if (!granted) {
				throw new Halt(
					`The implementation budget of ${budget} cycle${budget === 1 ? "" : "s"} is spent without reaching a clean result. Run /charter go to grant one more cycle, or /charter reopen to rethink the spec.`,
				);
			}
			state.cycleGrant = state.cycle - this.config.limits.cycles;
			await charter.journal("cycle-granted", { cycle: state.cycle }, this.stamp());
		}
		await this.assertFrozen(charter, state);

		const name = `impl-${state.counters.impl + 1}`;
		const settings = this.config.roles.implementer;
		const checkpoint = await this.checkpoint(state, `pre-${name}`);

		let failedGate: GateReport | undefined;
		const toFix: Array<AuditReport | GateReport> = [];
		for (const source of state.fixFrom) {
			const report = source.startsWith("gate-") ? await charter.readReport<GateReport>(source, "gate") : await charter.readReport<AuditReport>(source, "audit");
			if (report.kind === "gate" && report.findings.length === 0) failedGate = report;
			else toFix.push(report);
		}

		const prompt = implementerBrief({
			id: state.id,
			cycle: state.cycle,
			documents: await this.briefDocuments(charter),
			criteria: approval.criteria,
			checks: this.config.checks,
			changes: await this.changesSinceBaseline(state, checkpoint?.tree),
			answered: await this.previousImplementerReports(charter, state),
			failedGate,
			toFix,
		});

		let submission: ImplementerSubmission | undefined;
		const startedAt = this.stamp();
		state.active = { step: name, startedAt, pid: process.pid };
		await charter.save(state, startedAt);
		await charter.journal("run-started", { label: name, model: settings.model ?? "session" }, startedAt);
		options.onStep?.(`implementer ${name}${failedGate ? " (repairing failed checks)" : ""}`);

		const result = await this.runner.run({
			role: "implementer",
			label: name,
			cwd: this.projectRoot,
			prompt,
			model: settings.model,
			thinking: settings.thinking,
			timeoutMs: settings.timeoutMinutes * 60_000,
			nudges: this.config.limits.reportNudges,
			protectedPaths: [charter.dir],
			signal: options.signal,
			onActivity: (text) => options.onActivity?.(name, text),
			submit: (raw) => {
				const candidate = raw as ImplementerSubmission;
				const problems = validateImplementerSubmission(candidate, approval.criteria);
				if (problems.length > 0) throw new CharterError("Report rejected. Fix these and call charter_report again:", problems);
				submission = candidate;
			},
		});

		state.active = null;
		this.record(state, "implementer", name, startedAt, result);
		await this.undoDocumentDrift(charter, state, name, options);
		const at = this.stamp();

		if (result.outcome !== "reported" || !submission) {
			await charter.save(state, at);
			await charter.journal("run-failed", { label: name, outcome: result.outcome, error: result.error ?? null }, at);
			throw new Halt(`${this.describeFailure(name, result)} The charter stays at "implement"; advance again to retry. Work already written to disk is kept (checkpoint pre-${name} holds the state before this run).`);
		}

		const report = buildImplementerReport(submission, { name, revision: state.revision, cycle: state.cycle, at });
		await charter.writeReport(report);
		state.counters.impl += 1;
		state.latest.impl = name;
		state.fixFrom = [];
		if (report.status === "done") {
			state.stage = transition(state.stage, { type: "implemented" }, this.config);
		} else {
			state.stage = transition(state.stage, { type: "blocked" }, this.config);
			state.pending = name;
		}
		await charter.save(state, at);
		await charter.journal("run-reported", { label: name, status: report.status, questions: report.questions.length }, at);
	}

	private async stepGate(charter: Charter, state: CharterState, options: AdvanceOptions): Promise<void> {
		const at = this.stamp();
		if (this.config.checks.length === 0) {
			state.stage = transition(state.stage, { type: "gate-passed" }, this.config);
			await charter.save(state, at);
			return;
		}
		const name = `gate-${state.counters.gate + 1}`;
		const checks = await runChecks(this.config.checks, this.projectRoot, {
			signal: options.signal,
			onStart: (check, index) => options.onStep?.(`check ${check.name} (${index + 1}/${this.config.checks.length})`),
		});
		if (options.signal?.aborted) throw new Halt("Cancelled while running the project checks. Advance again to rerun them.");

		const passed = checks.every((check) => check.passed);
		const report: GateReport = { kind: "gate", name, createdAt: this.stamp(), phase: "implementation", passed, checks, findings: [] };
		state.counters.gate += 1;
		state.latest.gate = name;
		this.record(state, "gate", name, at, { outcome: passed ? "passed" : "check-failed", durationMs: checks.reduce((sum, check) => sum + check.durationMs, 0) });

		if (passed) {
			state.stage = transition(state.stage, { type: "gate-passed" }, this.config);
		} else if (state.gateAttempts < this.config.limits.gateRetries) {
			state.gateAttempts += 1;
			state.fixFrom = [name];
			state.stage = transition(state.stage, { type: "gate-repair" }, this.config);
			options.onNotice?.(`Checks failed (${checks.filter((check) => !check.passed).map((check) => check.name).join(", ")}); sending them back to the implementer (repair ${state.gateAttempts}/${this.config.limits.gateRetries}).`);
		} else {
			report.findings = gateFindings(checks);
			state.pending = name;
			state.stage = transition(state.stage, { type: "gate-escalated" }, this.config);
		}
		await charter.writeReport(report);
		await charter.save(state, this.stamp());
		await charter.journal("gate", { label: name, passed, failed: checks.filter((check) => !check.passed).map((check) => check.name), next: state.stage }, this.stamp());
	}

	/** A phase switched off in the configuration after approval is passed over, and that is recorded. */
	private async skipDisabled(charter: Charter, state: CharterState, role: Role, options: AdvanceOptions): Promise<void> {
		const at = this.stamp();
		const step = state.stage;
		state.skipped.push({ step, reason: `the ${role} was disabled in the configuration after approval` });
		state.stage = transition(state.stage, { type: "skip" }, this.config);
		options.onNotice?.(`The ${role} is disabled in the configuration; skipping "${step}".`);
		await charter.save(state, at);
		await charter.journal("skipped", { step, reason: "disabled" }, at);
	}

	private async stepAudit(charter: Charter, state: CharterState, options: AdvanceOptions): Promise<void> {
		const approval = this.requireApproval(state);
		if (!this.config.roles.auditor.enabled) return this.skipDisabled(charter, state, "auditor", options);
		await this.assertFrozen(charter, state);
		const settings = this.config.roles.auditor;
		const name = `audit-${state.counters.audit + 1}`;
		const groups = partitionCriteria(approval.criteria, settings.shards);
		if (groups.length === 0) throw new CharterError(`Charter "${state.id}" has no acceptance criteria to audit.`);

		const git = await this.git();
		let before: string | undefined;
		try {
			before = git ? await git.snapshot() : undefined;
		} catch (error) {
			options.onNotice?.(`Could not snapshot the work tree before the audit (${errorMessage(error)}); auditor changes will not be detected.`);
		}
		const [documents, changes, answered, decided] = await Promise.all([
			this.briefDocuments(charter),
			this.changesSinceBaseline(state, before),
			this.previousImplementerReports(charter, state),
			this.decidedReports(charter, state),
		]);

		const startedAt = this.stamp();
		state.active = { step: name, startedAt, pid: process.pid };
		await charter.save(state, startedAt);
		await charter.journal("run-started", { label: name, shards: groups.length, model: settings.model ?? "session" }, startedAt);
		options.onStep?.(groups.length > 1 ? `auditors ${name} (${groups.length} in parallel)` : `auditor ${name}`);

		// If an earlier attempt at this audit failed in part, the auditors that did finish are not
		// paid for twice: their results are reused as long as the project is byte-for-byte the same.
		const partialPath = charter.partialAuditPath(name);
		const submissions: Array<AuditSubmission | undefined> = groups.map(() => undefined);
		let earlierDrift: string[] = [];
		if (before) {
			const partial = await readPartialAudit(partialPath);
			if (partial && partial.tree === before && partial.revision === state.revision && JSON.stringify(partial.groups) === JSON.stringify(groups)) {
				partial.submissions.forEach((submission, index) => {
					const assigned = groups[index];
					if (submission && assigned && validateAuditSubmission(submission, assigned, approval.criteria).length === 0) submissions[index] = submission;
				});
				earlierDrift = partial.drift;
			}
		}
		const reused = submissions.map((submission) => submission !== undefined);

		// Without a snapshot nothing can be reused later, so one failing shard stops the others
		// instead of letting them bill for an audit that has to be repeated in full anyway.
		const stopOthers = new AbortController();
		const forward = (): void => stopOthers.abort();
		options.signal?.addEventListener("abort", forward, { once: true });
		if (options.signal?.aborted) stopOthers.abort();

		const scratchDirs: string[] = [];
		let results: Array<RoleRunResult | undefined>;
		try {
			results = await Promise.all(
				groups.map(async (assigned, index) => {
					const label = groups.length > 1 ? `${name}#${index + 1}` : name;
					if (reused[index]) {
						options.onNotice?.(`Reusing the result of ${label} from the previous attempt; the project has not changed since.`);
						return undefined;
					}
					const scratchDir = join(this.scratchRoot, state.id, label.replace("#", "-"));
					scratchDirs.push(scratchDir);
					await mkdir(scratchDir, { recursive: true });
					const result = await this.runner.run({
						role: "auditor",
						label,
						cwd: this.projectRoot,
						prompt: auditorBrief({
							id: state.id,
							documents,
							assigned,
							allCriteria: approval.criteria,
							shard: { index: index + 1, total: groups.length },
							changes,
							answered,
							waivedFrom: decided,
							scratchDir,
						}),
						model: settings.model,
						thinking: settings.thinking,
						timeoutMs: settings.timeoutMinutes * 60_000,
						nudges: this.config.limits.reportNudges,
						protectedPaths: [charter.dir],
						writableOnly: scratchDir,
						signal: stopOthers.signal,
						onActivity: (text) => options.onActivity?.(label, text),
						submit: (raw) => {
							const candidate = raw as AuditSubmission;
							const problems = validateAuditSubmission(candidate, assigned, approval.criteria);
							if (problems.length > 0) throw new CharterError("Report rejected. Fix these and call charter_report again:", problems);
							submissions[index] = candidate;
						},
					});
					if (result.outcome !== "reported" && !before) stopOthers.abort();
					return result;
				}),
			);
		} finally {
			options.signal?.removeEventListener("abort", forward);
			await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
		}

		state.active = null;
		const labelOf = (index: number): string => (groups.length > 1 ? `${name}#${index + 1}` : name);
		results.forEach((result, index) => {
			if (result) this.record(state, "auditor", labelOf(index), startedAt, result);
		});

		// An auditor is read-only. Whatever it left behind in the project is undone.
		let drift: string[] = [];
		let pristine = before !== undefined;
		if (git && before) {
			try {
				if ((await git.snapshot()) !== before) {
					// Nothing is thrown away: if the developer edited a file during the audit, it is in this checkpoint.
					const kept = await this.checkpoint(state, `after-${name}`);
					drift = await git.restore(before);
					const note = `${name} left ${drift.length} project file(s) changed (${drift.slice(0, 5).join(", ")}${drift.length > 5 ? ", ..." : ""}); they were restored${kept ? ` (the changed versions are kept in checkpoint after-${name})` : ""}.`;
					state.notes.push(note);
					options.onNotice?.(note);
				}
			} catch (error) {
				pristine = false;
				state.notes.push(`Could not verify that ${name} left the project untouched: ${errorMessage(error)}`);
			}
		}
		await this.undoDocumentDrift(charter, state, name, options);
		const at = this.stamp();
		drift = [...new Set([...earlierDrift, ...drift])].sort();

		const failures = results.flatMap((result, index) => (result && (result.outcome !== "reported" || !submissions[index]) ? [{ result, label: labelOf(index) }] : []));
		if (failures.length > 0) {
			const finished = submissions.filter((submission) => submission !== undefined).length;
			const keep = pristine && before !== undefined && finished > 0;
			if (keep) {
				const partial: PartialAudit = { tree: before as string, revision: state.revision, groups, submissions: submissions.map((submission) => submission ?? null), drift };
				await writeJsonAtomic(partialPath, partial);
			}
			await charter.save(state, at);
			await charter.journal("run-failed", { label: name, kept: keep ? finished : 0, failures: failures.map(({ label, result }) => ({ label, outcome: result.outcome, error: result.error ?? null })) }, at);
			// Prefer the root cause over the shards that were merely stopped because of it.
			const primary = failures.find(({ result }) => result.outcome !== "aborted") ?? failures[0];
			const retry = keep ? `The ${finished} auditor(s) that finished are kept; advancing again re-runs only the rest.` : "Advance again to retry.";
			throw new Halt(`${primary ? this.describeFailure(primary.label, primary.result) : "The audit failed."} The charter stays at "audit". ${retry}`);
		}

		await rm(partialPath, { force: true });
		const report = mergeAuditSubmissions(submissions as AuditSubmission[], { name, revision: state.revision, at, drift });
		await charter.writeReport(report);
		state.counters.audit += 1;
		state.latest.audit = name;
		if (report.findings.length === 0) {
			state.stage = transition(state.stage, { type: "audit-clean" }, this.config);
		} else {
			state.stage = transition(state.stage, { type: "audit-findings" }, this.config);
			state.pending = name;
		}
		await charter.save(state, at);
		await charter.journal("run-reported", { label: name, findings: report.findings.length, shards: groups.length }, at);
	}

	private async skipRefine(charter: Charter, state: CharterState, reason: string, options: AdvanceOptions): Promise<void> {
		const at = this.stamp();
		state.skipped.push({ step: "refine", reason });
		state.stage = transition(state.stage, { type: "skip" }, this.config);
		options.onNotice?.(`Refinement skipped: ${reason}.`);
		await charter.save(state, at);
		await charter.journal("skipped", { step: "refine", reason }, at);
	}

	private async stepRefine(charter: Charter, state: CharterState, options: AdvanceOptions): Promise<void> {
		this.requireApproval(state);
		if (!this.config.roles.refiner.enabled) return this.skipDisabled(charter, state, "refiner", options);
		const git = await this.git();
		if (!git || !state.baseline) {
			await this.skipRefine(charter, state, "no git checkpoint is available, so a refinement could be neither scoped nor undone", options);
			return;
		}
		await this.assertFrozen(charter, state);
		const name = `refine-${state.counters.refine + 1}`;
		const before = await this.checkpoint(state, `pre-${name}`);
		if (!before) {
			await this.skipRefine(charter, state, "the work tree could not be checkpointed", options);
			return;
		}
		const scope = ((await this.changesSinceBaseline(state, before.tree)) ?? []).filter((change) => change.status !== "D").map((change) => change.path);
		if (scope.length === 0) {
			await this.skipRefine(charter, state, "the implementation changed no files", options);
			return;
		}

		const settings = this.config.roles.refiner;
		let submission: RefinerSubmission | undefined;
		const startedAt = this.stamp();
		state.active = { step: name, startedAt, pid: process.pid };
		await charter.save(state, startedAt);
		await charter.journal("run-started", { label: name, model: settings.model ?? "session" }, startedAt);
		options.onStep?.(`refiner ${name}`);

		const result = await this.runner.run({
			role: "refiner",
			label: name,
			cwd: this.projectRoot,
			prompt: refinerBrief({ id: state.id, documents: await this.briefDocuments(charter), scope, checks: this.config.checks }),
			model: settings.model,
			thinking: settings.thinking,
			timeoutMs: settings.timeoutMinutes * 60_000,
			nudges: this.config.limits.reportNudges,
			protectedPaths: [charter.dir],
			signal: options.signal,
			onActivity: (text) => options.onActivity?.(name, text),
			submit: (raw) => {
				const candidate = raw as RefinerSubmission;
				const problems = validateRefinerSubmission(candidate);
				if (problems.length > 0) throw new CharterError("Report rejected. Fix these and call charter_report again:", problems);
				submission = candidate;
			},
		});

		state.active = null;
		this.record(state, "refiner", name, startedAt, result);
		await this.undoDocumentDrift(charter, state, name, options);

		if (result.outcome !== "reported" || !submission) {
			// A half-finished refactoring is worse than none, but it is kept for inspection.
			if ((await git.snapshot()) !== before.tree) await this.checkpoint(state, `discarded-${name}`);
			const undone = await git.restore(before.commit);
			const at = this.stamp();
			await charter.save(state, at);
			await charter.journal("run-failed", { label: name, outcome: result.outcome, error: result.error ?? null, restored: undone.length }, at);
			throw new Halt(`${this.describeFailure(name, result)} Its partial changes were undone. Advance again to retry the refinement, or run /charter skip to finish without it.`);
		}

		const changed = await git.changes(before.tree, await git.snapshot());
		const inScope = new Set(scope);
		const outside = changed.filter((change) => change.status !== "A" && !inScope.has(change.path)).map((change) => change.path);
		let outcome: RefineReport["outcome"] = changed.length === 0 ? "no-changes" : "kept";
		let revertReason: string | undefined;

		if (outside.length > 0) {
			outcome = "reverted";
			revertReason = `it modified files outside the implementation's scope (${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", ..." : ""})`;
		} else if (changed.length > 0 && this.config.checks.length > 0) {
			const gateName = `gate-${state.counters.gate + 1}`;
			const gateStarted = this.stamp();
			const checks = await runChecks(this.config.checks, this.projectRoot, {
				signal: options.signal,
				onStart: (check, index) => options.onStep?.(`check ${check.name} after refinement (${index + 1}/${this.config.checks.length})`),
			});
			if (options.signal?.aborted) {
				await this.checkpoint(state, `discarded-${name}`);
				await git.restore(before.commit);
				await charter.save(state, this.stamp());
				throw new Halt("Cancelled while checking the refinement; its changes were undone. Advance again to retry, or run /charter skip.");
			}
			// Only a check that passed on the accepted code can condemn the refinement.
			const previous = state.latest.gate ? await charter.readReport<GateReport>(state.latest.gate, "gate") : undefined;
			const passedBefore = new Set(previous ? previous.checks.filter((check) => check.passed).map((check) => check.name) : checks.map((check) => check.name));
			const broken = checks.filter((check) => !check.passed && passedBefore.has(check.name)).map((check) => check.name);
			await charter.writeReport({ kind: "gate", name: gateName, createdAt: this.stamp(), phase: "refinement", passed: broken.length === 0, checks, findings: [] });
			state.counters.gate += 1;
			this.record(state, "gate", gateName, gateStarted, { outcome: broken.length === 0 ? "passed" : "check-failed", durationMs: checks.reduce((sum, check) => sum + check.durationMs, 0) });
			if (broken.length > 0) {
				outcome = "reverted";
				revertReason = `it broke the project check${broken.length === 1 ? "" : "s"} ${broken.join(", ")}`;
			} else {
				state.latest.gate = gateName;
			}
		}

		if (outcome === "reverted") {
			const kept = await this.checkpoint(state, `discarded-${name}`);
			await git.restore(before.commit);
			const note = `The refinement was discarded because ${revertReason}; the accepted code was restored${kept ? ` (inspect it with \`git diff ${before.commit.slice(0, 12)} ${kept.commit.slice(0, 12)}\`)` : ""}.`;
			state.notes.push(note);
			options.onNotice?.(note);
		}

		const at = this.stamp();
		const report: RefineReport = {
			kind: "refine",
			name,
			createdAt: at,
			summary: submission.summary.trim(),
			filesChanged: changed.map((change) => change.path),
			notes: (submission.notes ?? []).map((note) => note.trim()).filter(Boolean),
			outcome,
			...(revertReason ? { revertReason } : {}),
		};
		await charter.writeReport(report);
		state.counters.refine += 1;
		state.latest.refine = name;
		state.stage = transition(state.stage, { type: "refined" }, this.config);
		await charter.save(state, at);
		await charter.journal("run-reported", { label: name, outcome, files: changed.length }, at);
	}

	// ---------------------------------------------------------------- finalize

	/** Build (or rebuild) `report.md` from the saved reports. */
	async finalize(charter: Charter, state: CharterState): Promise<string> {
		const read = async <T extends ImplementerReport | AuditReport | GateReport | RefineReport>(name: string | undefined, kind: T["kind"]): Promise<T | undefined> => {
			if (!name) return undefined;
			try {
				return await charter.readReport<T>(name, kind);
			} catch {
				return undefined;
			}
		};
		const audits: AuditReport[] = [];
		for (let index = 1; index <= state.counters.audit; index++) {
			const report = await read<AuditReport>(`audit-${index}`, "audit");
			if (report && report.revision === state.revision) audits.push(report);
		}
		const gates: GateReport[] = [];
		for (let index = 1; index <= state.counters.gate; index++) {
			const report = await read<GateReport>(`gate-${index}`, "gate");
			if (report) gates.push(report);
		}
		const latestGate = await read<GateReport>(state.latest.gate, "gate");
		const implementer = await read<ImplementerReport>(state.latest.impl, "implementer");

		// Phases switched off in configuration are stated, never silently absent.
		const view: CharterState = { ...state, skipped: [...state.skipped] };
		const off = (role: Role): boolean => !this.config.roles[role].enabled || !this.config.roles.implementer.enabled;
		if (off("implementer")) view.skipped.push({ step: "implementation", reason: "the implementer is disabled in the configuration" });
		if (off("auditor")) view.skipped.push({ step: "independent audit", reason: "the auditor is disabled in the configuration" });
		if (off("refiner")) view.skipped.push({ step: "refinement", reason: "the refiner is disabled in the configuration" });
		if (this.config.roles.implementer.enabled && this.config.checks.length === 0) view.skipped.push({ step: "project checks", reason: "no checks are configured" });

		const markdown = buildFinalReport({
			state: view,
			config: this.config,
			implementer: implementer && implementer.revision === state.revision ? implementer : undefined,
			audits,
			gates: [...gates.filter((gate) => gate.findings.length > 0 && gate.name !== latestGate?.name), ...(latestGate ? [latestGate] : [])],
			refine: await read<RefineReport>(state.latest.refine, "refine"),
		});
		await writeTextAtomic(charter.summaryPath, markdown);
		if (!(await charter.readJournal(1)).some((event) => event.event === "completed")) await charter.journal("completed", { runs: state.runs.length }, this.stamp());
		return markdown;
	}
}
