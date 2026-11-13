/**
 * Shared vocabulary for the whole package. Everything in `src/core` is free of
 * Pi imports so it can be unit-tested and benchmarked without a host.
 */

export const ROLES = ["implementer", "auditor", "refiner"] as const;
export type Role = (typeof ROLES)[number];

/**
 * A stage names the step the charter needs next. Nothing is ever "running" in
 * the saved stage: a live run is recorded separately in `CharterState.active`,
 * so a crashed or cancelled run leaves the charter exactly where a retry has
 * to start.
 */
export const STAGES = [
	"drafting",
	"implement",
	"questions",
	"gate",
	"audit",
	"triage",
	"refine",
	"done",
] as const;
export type Stage = (typeof STAGES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export const ZERO_USAGE: Readonly<UsageTotals> = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
});

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

/** An error whose message is safe and useful to show to the developer or the model verbatim. */
export class CharterError extends Error {
	override name = "CharterError";
	readonly problems: readonly string[];

	constructor(message: string, problems: readonly string[] = []) {
		super(problems.length > 0 ? `${message}\n${problems.map((p) => `- ${p}`).join("\n")}` : message);
		this.problems = problems;
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
