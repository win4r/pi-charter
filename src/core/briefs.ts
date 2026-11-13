/**
 * Task briefs: the first (and normally only) user message each agent receives.
 *
 * A brief carries everything the agent would otherwise spend turns
 * discovering: the approved documents, the exact criteria to report on, what
 * changed so far, and the decisions already taken. Fewer discovery turns means
 * faster and cheaper runs.
 */

import type { CheckConfig } from "./config.ts";
import type { FileChange } from "./git.ts";
import type { AuditReport, GateReport, ImplementerReport } from "./reports.ts";

/** Documents larger than this are referenced by path instead of being inlined. */
export const INLINE_DOCUMENT_LIMIT = 32_000;
const FILE_LIST_LIMIT = 150;

export interface BriefDocuments {
	/** Charter directory relative to the project root. */
	directory: string;
	files: Array<{ name: string; content: string }>;
	/** Approved supporting files (mock-ups, samples), relative to the charter directory. */
	attachments?: string[];
}

function documentsBlock(documents: BriefDocuments): string {
	const total = documents.files.reduce((sum, file) => sum + file.content.length, 0);
	const attachments =
		documents.attachments && documents.attachments.length > 0
			? ["", "Approved supporting files, part of the contract (read the ones you need):", ...documents.attachments.map((name) => `- ${documents.directory}/${name}`)]
			: [];
	if (total > INLINE_DOCUMENT_LIMIT) {
		return [
			"## Approved documents",
			"",
			"Read these files completely before anything else:",
			...documents.files.map((file) => `- ${documents.directory}/${file.name}`),
			...attachments,
		].join("\n");
	}
	return [
		"## Approved documents",
		"",
		`These are the complete, approved contents of \`${documents.directory}/\`. You do not need to re-read them from disk.`,
		"",
		...documents.files.map((file) => `<document name="${file.name}">\n${file.content.trimEnd()}\n</document>`),
		...attachments,
	].join("\n");
}

function changesBlock(title: string, changes: readonly FileChange[] | undefined): string[] {
	if (changes === undefined) return [];
	if (changes.length === 0) return [`## ${title}`, "", "No project files have changed."];
	const shown = changes.slice(0, FILE_LIST_LIMIT).map((change) => `${change.status} ${change.path}`);
	if (changes.length > FILE_LIST_LIMIT) shown.push(`... and ${changes.length - FILE_LIST_LIMIT} more`);
	return [`## ${title}`, "", "```text", ...shown, "```"];
}

function checksBlock(checks: readonly CheckConfig[], lead: string): string[] {
	if (checks.length === 0) return [];
	return ["## Project checks", "", lead, ...checks.map((check) => `- ${check.name}: \`${check.run}\``)];
}

function answersBlock(reports: readonly ImplementerReport[]): string[] {
	const lines: string[] = [];
	for (const report of reports) {
		for (const question of report.questions) {
			if (!question.resolution) continue;
			lines.push(`- ${report.name}/${question.id} "${question.title}" -> ${question.resolution.answer}`);
		}
	}
	return lines.length === 0 ? [] : ["## Developer decisions", "", "These answers are binding and override your own preference:", ...lines];
}

export interface ImplementerBriefInput {
	id: string;
	cycle: number;
	documents: BriefDocuments;
	criteria: readonly string[];
	checks: readonly CheckConfig[];
	changes?: readonly FileChange[];
	/** Earlier implementer reports whose answered questions still apply. */
	answered: readonly ImplementerReport[];
	/** Failed gate to repair, if this run is an automatic repair. */
	failedGate?: GateReport;
	/** Reports with findings the developer decided to have fixed. */
	toFix: ReadonlyArray<AuditReport | GateReport>;
}

export function implementerBrief(input: ImplementerBriefInput): string {
	const parts: string[] = [`# Implement charter ${input.id} (cycle ${input.cycle})`, ""];

	const fixes: string[] = [];
	if (input.failedGate) {
		fixes.push("The project checks fail after your previous run. Make them pass without weakening or deleting them:", "");
		for (const check of input.failedGate.checks.filter((entry) => !entry.passed)) {
			fixes.push(`### Check "${check.name}" (\`${check.command}\`) ${check.timedOut ? "timed out" : `exit ${check.exitCode ?? "?"}`}`, "", "```text", check.output || "(no output)", "```", "");
		}
	}
	for (const report of input.toFix) {
		for (const finding of report.findings) {
			if (finding.resolution?.decision !== "fix") continue;
			fixes.push(
				`### ${report.name}/${finding.id} (${finding.severity}${finding.criterion ? `, ${finding.criterion}` : ""}): ${finding.title}`,
				"",
				finding.detail,
				"",
				`Evidence: ${finding.evidence}`,
				...(finding.suggestion ? [`Suggestion: ${finding.suggestion}`] : []),
				`Developer: ${finding.resolution.reason}`,
				"",
			);
		}
	}
	if (fixes.length > 0) {
		parts.push("## What to fix in this run", "", "The implementation exists already. Do not start over; address exactly these items, then re-check every criterion.", "", ...fixes);
	}

	parts.push(documentsBlock(input.documents), "");
	const answers = answersBlock(input.answered);
	if (answers.length > 0) parts.push(...answers, "");
	const changes = changesBlock("Files changed since approval", input.changes);
	if (changes.length > 0) parts.push(...changes, "");
	const checks = checksBlock(input.checks, "These commands run automatically after you report. A failure sends the work straight back to you, so run them yourself first:");
	if (checks.length > 0) parts.push(...checks, "");

	parts.push(
		"## Report",
		"",
		`Finish by calling \`charter_report\` exactly once with a result and evidence for each of: ${input.criteria.join(", ")}.`,
	);
	return parts.join("\n");
}

export interface AuditorBriefInput {
	id: string;
	documents: BriefDocuments;
	/** Criteria this auditor must verify. */
	assigned: readonly string[];
	/** Every criterion of the spec, for context. */
	allCriteria: readonly string[];
	shard?: { index: number; total: number };
	changes?: readonly FileChange[];
	answered: readonly ImplementerReport[];
	/** Earlier audit/gate reports with waived findings, so they are not raised again. */
	waivedFrom: ReadonlyArray<AuditReport | GateReport>;
	scratchDir: string;
}

export function auditorBrief(input: AuditorBriefInput): string {
	const parts: string[] = [`# Audit charter ${input.id}`, ""];
	if (input.shard && input.shard.total > 1) {
		parts.push(
			`You are auditor ${input.shard.index} of ${input.shard.total} working in parallel. Verify only your assigned criteria; the others are covered by your peers.`,
			"",
		);
	}
	parts.push(`Assigned criteria: ${input.assigned.join(", ")}`, "");
	parts.push(documentsBlock(input.documents), "");

	const answers = answersBlock(input.answered);
	if (answers.length > 0) parts.push(...answers, "");

	const waived: string[] = [];
	for (const report of input.waivedFrom) {
		for (const finding of report.findings) {
			if (finding.resolution?.decision === "waive") waived.push(`- ${report.name}/${finding.id} "${finding.title}" -> waived: ${finding.resolution.reason}`);
		}
	}
	if (waived.length > 0) parts.push("## Already decided", "", "The developer accepted these earlier findings. Do not raise them again unless the behavior got worse:", ...waived, "");

	const changes = changesBlock("Files changed since approval", input.changes);
	if (changes.length > 0) parts.push(...changes, "");

	parts.push(
		"## Working rules for this run",
		"",
		"- The project files are read-only for you: `edit` and `write` are refused outside your scratch directory.",
		`- Scratch directory for throwaway scripts and fixtures: ${input.scratchDir}`,
		"- Any project file you change through the shell is detected and restored when you finish.",
		"",
		"## Report",
		"",
		`Finish by calling \`charter_report\` exactly once with a result and evidence for each of: ${input.assigned.join(", ")}.`,
	);
	return parts.join("\n");
}

export interface RefinerBriefInput {
	id: string;
	documents: BriefDocuments;
	/** Files you may modify: those the implementation touched. */
	scope: readonly string[];
	checks: readonly CheckConfig[];
}

export function refinerBrief(input: RefinerBriefInput): string {
	const shown = input.scope.slice(0, FILE_LIST_LIMIT);
	const parts: string[] = [
		`# Refine the implementation of charter ${input.id}`,
		"",
		"The implementation below was accepted. Make it simpler and clearer without changing what it does.",
		"",
		"## Files in scope",
		"",
		"You may modify only these files (and add new files if an extraction needs one):",
		"",
		"```text",
		...shown,
		...(input.scope.length > shown.length ? [`... and ${input.scope.length - shown.length} more`] : []),
		"```",
		"",
		"A change to any other existing file causes your whole refinement to be discarded.",
		"",
	];
	const checks = checksBlock(input.checks, "These commands run after you report. If one that passed before now fails, your whole refinement is discarded:");
	if (checks.length > 0) parts.push(...checks, "");
	parts.push(documentsBlock(input.documents), "", "## Report", "", "Finish by calling `charter_report` exactly once, even if you decided nothing should change.");
	return parts.join("\n");
}

/** Sent when an agent stops without filing its report. */
export const REPORT_NUDGE =
	"You stopped without calling `charter_report`, so nothing was recorded and your work cannot be used. Call `charter_report` now with your results. If you are blocked, say so in the report instead of in prose.";

/**
 * Split criteria into at most `shards` contiguous, balanced groups.
 * Contiguity keeps criteria of the same requirement together, so an auditor
 * builds context once per requirement.
 */
export function partitionCriteria(ids: readonly string[], shards: number): string[][] {
	const count = Math.max(1, Math.min(Math.floor(shards), ids.length));
	const groups: string[][] = [];
	let start = 0;
	for (let index = 0; index < count; index++) {
		const size = Math.ceil((ids.length - start) / (count - index));
		groups.push(ids.slice(start, start + size));
		start += size;
	}
	return groups.filter((group) => group.length > 0);
}
