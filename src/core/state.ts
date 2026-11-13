/**
 * The persisted state of one charter (`charter.json`) and its validation.
 */

import { CharterError, isRecord, type Role, STAGES, type Stage, type UsageTotals, ZERO_USAGE } from "./types.ts";

export const STATE_SCHEMA = 1;

export interface Approval {
	revision: number;
	at: string;
	/** Relative document path -> SHA-256 of its content at approval. */
	documents: Record<string, string>;
	/** Acceptance-criterion ids of the approved spec, in natural order. */
	criteria: string[];
}

export type RunOutcome = "reported" | "no-report" | "failed" | "aborted" | "timeout" | "passed" | "check-failed";

export interface RunRecord {
	seq: number;
	step: Role | "gate";
	/** Report or shard label, such as `impl-2` or `audit-1#3`. */
	label: string;
	startedAt: string;
	durationMs: number;
	outcome: RunOutcome;
	model?: string;
	usage: UsageTotals;
	/** Saved child session file, when the host persisted one. */
	transcript?: string;
	error?: string;
}

export interface Checkpoint {
	label: string;
	commit: string;
	at: string;
}

export interface SkippedStep {
	step: string;
	reason: string;
}

export interface CharterState {
	schema: typeof STATE_SCHEMA;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	stage: Stage;
	/** Number of approvals recorded so far. */
	revision: number;
	/** The approval the pipeline is working under; `null` while drafting. */
	approval: Approval | null;
	/** Checkpoint commit taken at the first approval; the diff base for audit and refinement. */
	baseline: string | null;
	/** Implementation cycles opened under the current approval (automatic check repairs do not count). */
	cycle: number;
	/** Extra cycles the developer granted beyond `limits.cycles`. */
	cycleGrant: number;
	/** Automatic repair attempts used in the current cycle. */
	gateAttempts: number;
	counters: { impl: number; audit: number; gate: number; refine: number };
	latest: { impl?: string; audit?: string; gate?: string; refine?: string };
	/** Report awaiting developer decisions (stages `questions` and `triage`). */
	pending: string | null;
	/** Reports whose open items the next implementer run must address. */
	fixFrom: string[];
	/** A run in flight. Stale after a crash; cleared on the next advance. */
	active: { step: string; startedAt: string; pid: number } | null;
	runs: RunRecord[];
	skipped: SkippedStep[];
	checkpoints: Checkpoint[];
	usage: UsageTotals;
	/** Facts the final report must mention (reverted refinement, restored documents, ...). */
	notes: string[];
}

export function newState(id: string, title: string, at: string): CharterState {
	return {
		schema: STATE_SCHEMA,
		id,
		title,
		createdAt: at,
		updatedAt: at,
		stage: "drafting",
		revision: 0,
		approval: null,
		baseline: null,
		cycle: 0,
		cycleGrant: 0,
		gateAttempts: 0,
		counters: { impl: 0, audit: 0, gate: 0, refine: 0 },
		latest: {},
		pending: null,
		fixFrom: [],
		active: null,
		runs: [],
		skipped: [],
		checkpoints: [],
		usage: { ...ZERO_USAGE },
		notes: [],
	};
}

/**
 * Check the invariants the pipeline relies on. This is deliberately not a full
 * schema walk: the file is written only by this package, so the goal is to
 * catch hand edits and version skew with a useful message.
 */
export function parseState(raw: unknown, source: string): CharterState {
	const problems: string[] = [];
	if (!isRecord(raw)) throw new CharterError(`${source} is not a charter state file.`);
	if (raw.schema !== STATE_SCHEMA) {
		throw new CharterError(`${source} uses state schema ${JSON.stringify(raw.schema)}; this release reads schema ${STATE_SCHEMA}.`);
	}
	if (typeof raw.id !== "string" || raw.id === "") problems.push("id: missing");
	if (typeof raw.title !== "string") problems.push("title: missing");
	if (typeof raw.stage !== "string" || !(STAGES as readonly string[]).includes(raw.stage)) {
		problems.push(`stage: ${JSON.stringify(raw.stage)} is not one of ${STAGES.join(", ")}`);
	}
	for (const key of ["revision", "cycle", "cycleGrant", "gateAttempts"]) {
		if (typeof raw[key] !== "number" || !Number.isInteger(raw[key]) || (raw[key] as number) < 0) problems.push(`${key}: must be a non-negative whole number`);
	}
	for (const key of ["runs", "skipped", "checkpoints", "fixFrom", "notes"]) {
		if (!Array.isArray(raw[key])) problems.push(`${key}: must be a list`);
	}
	for (const key of ["counters", "latest", "usage"]) {
		if (!isRecord(raw[key])) problems.push(`${key}: must be an object`);
	}
	if (raw.approval !== null && !isRecord(raw.approval)) problems.push("approval: must be an object or null");
	if (raw.stage !== "drafting" && raw.stage !== "done" && raw.approval === null) {
		problems.push(`approval: stage "${String(raw.stage)}" requires a recorded approval`);
	}
	if ((raw.stage === "questions" || raw.stage === "triage") && typeof raw.pending !== "string") {
		problems.push(`pending: stage "${String(raw.stage)}" requires the report awaiting decisions`);
	}
	if (problems.length > 0) throw new CharterError(`${source} is inconsistent:`, problems);
	return raw as unknown as CharterState;
}
