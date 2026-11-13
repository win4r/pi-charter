/**
 * Report shapes and the semantic validation applied to what agents submit.
 *
 * The JSON shape of a submission is checked by the host against the tool
 * schema; the rules here are the ones a schema cannot express (coverage of
 * every acceptance criterion, consistency between results and findings, ...).
 * Problems are phrased so an agent can correct its submission and resend it.
 */

import { compareIds } from "./spec/parse.ts";

export type CriterionResult = "pass" | "fail" | "untested";

export interface CriterionOutcome {
	id: string;
	result: CriterionResult;
	evidence: string;
}

// ---------------------------------------------------------------- implementer

export interface QuestionOption {
	label: string;
	consequence: string;
}

export interface QuestionResolution {
	answer: string;
	/** The answer changes the contract, so the charter returns to drafting. */
	reviseSpec: boolean;
	at: string;
}

export interface Question {
	id: string;
	title: string;
	detail: string;
	options: QuestionOption[];
	recommendation?: string;
	resolution?: QuestionResolution;
}

export interface ImplementerSubmission {
	status: "done" | "blocked";
	summary: string;
	criteria: CriterionOutcome[];
	filesChanged?: string[];
	notes?: string[];
	questions?: Array<Omit<Question, "id" | "resolution">>;
}

export interface ImplementerReport {
	kind: "implementer";
	name: string;
	createdAt: string;
	revision: number;
	cycle: number;
	status: "done" | "blocked";
	summary: string;
	criteria: CriterionOutcome[];
	filesChanged: string[];
	notes: string[];
	questions: Question[];
}

// -------------------------------------------------------------------- auditor

export type FindingSeverity = "critical" | "major" | "minor";
export type FindingDecision = "fix" | "waive" | "revise";

export interface FindingResolution {
	decision: FindingDecision;
	reason: string;
	at: string;
}

export interface Finding {
	id: string;
	title: string;
	severity: FindingSeverity;
	/** Acceptance criterion the finding is about, when it is about one. */
	criterion?: string;
	detail: string;
	evidence: string;
	suggestion?: string;
	resolution?: FindingResolution;
}

export interface AuditSubmission {
	criteria: CriterionOutcome[];
	findings?: Array<Omit<Finding, "id" | "resolution">>;
	notes?: string[];
}

export interface AuditReport {
	kind: "audit";
	name: string;
	createdAt: string;
	revision: number;
	shards: number;
	criteria: CriterionOutcome[];
	findings: Finding[];
	notes: string[];
	/** Project files an auditor left modified; they were restored by the pipeline. */
	drift: string[];
}

// ----------------------------------------------------------------------- gate

export interface CheckOutcome {
	name: string;
	command: string;
	passed: boolean;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	/** Tail of combined stdout/stderr. */
	output: string;
}

export interface GateReport {
	kind: "gate";
	name: string;
	createdAt: string;
	phase: "implementation" | "refinement";
	passed: boolean;
	checks: CheckOutcome[];
	/** Present only when the failure was escalated to the developer. */
	findings: Finding[];
}

// -------------------------------------------------------------------- refiner

export interface RefinerSubmission {
	summary: string;
	filesChanged?: string[];
	notes?: string[];
}

export interface RefineReport {
	kind: "refine";
	name: string;
	createdAt: string;
	summary: string;
	filesChanged: string[];
	notes: string[];
	outcome: "kept" | "reverted" | "no-changes";
	revertReason?: string;
}

export type Report = ImplementerReport | AuditReport | GateReport | RefineReport;

// ----------------------------------------------------------------- validation

function blank(value: unknown): boolean {
	return typeof value !== "string" || value.trim() === "";
}

function cleanList(values: readonly string[] | undefined): string[] {
	return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value !== ""))];
}

/** Every expected id exactly once, nothing else. */
function coverageProblems(outcomes: readonly CriterionOutcome[], expected: readonly string[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	const wanted = new Set(expected);
	for (const outcome of outcomes) {
		if (seen.has(outcome.id)) problems.push(`criteria: ${outcome.id} is reported more than once`);
		else if (!wanted.has(outcome.id)) problems.push(`criteria: ${outcome.id} is not one of the criteria you were asked to report (${expected.join(", ")})`);
		seen.add(outcome.id);
		if (blank(outcome.evidence)) problems.push(`criteria: ${outcome.id} needs evidence (what you ran or inspected, and what you observed)`);
	}
	const missing = expected.filter((id) => !seen.has(id));
	if (missing.length > 0) problems.push(`criteria: missing a result for ${missing.join(", ")}`);
	return problems;
}

export function validateImplementerSubmission(submission: ImplementerSubmission, criterionIds: readonly string[]): string[] {
	const problems = coverageProblems(submission.criteria ?? [], criterionIds);
	if (blank(submission.summary)) problems.push("summary: describe what you changed");
	const questions = submission.questions ?? [];

	if (submission.status === "done") {
		const failing = (submission.criteria ?? []).filter((outcome) => outcome.result !== "pass").map((outcome) => outcome.id);
		if (failing.length > 0) {
			problems.push(`status "done" requires every criterion to pass, but these do not: ${failing.join(", ")}. Keep working, or report status "blocked" with a question.`);
		}
		if (questions.length > 0) problems.push('status "done" cannot carry questions; use status "blocked" when a decision is needed');
	} else if (submission.status === "blocked") {
		if (questions.length === 0) problems.push('status "blocked" needs at least one question for the developer');
	} else {
		problems.push('status: must be "done" or "blocked"');
	}

	questions.forEach((question, index) => {
		const at = `questions[${index}]`;
		if (blank(question.title)) problems.push(`${at}.title: required`);
		if (blank(question.detail)) problems.push(`${at}.detail: explain what you found and why you cannot decide it yourself`);
		(question.options ?? []).forEach((option, optionIndex) => {
			if (blank(option.label) || blank(option.consequence)) problems.push(`${at}.options[${optionIndex}]: needs both label and consequence`);
		});
	});
	return problems;
}

export function buildImplementerReport(
	submission: ImplementerSubmission,
	meta: { name: string; revision: number; cycle: number; at: string },
): ImplementerReport {
	return {
		kind: "implementer",
		name: meta.name,
		createdAt: meta.at,
		revision: meta.revision,
		cycle: meta.cycle,
		status: submission.status,
		summary: submission.summary.trim(),
		criteria: [...submission.criteria].sort((a, b) => compareIds(a.id, b.id)),
		filesChanged: cleanList(submission.filesChanged),
		notes: cleanList(submission.notes),
		questions: (submission.questions ?? []).map((question, index) => ({
			id: `Q${index + 1}`,
			title: question.title.trim(),
			detail: question.detail.trim(),
			options: question.options ?? [],
			...(question.recommendation?.trim() ? { recommendation: question.recommendation.trim() } : {}),
		})),
	};
}

export function validateAuditSubmission(
	submission: AuditSubmission,
	assigned: readonly string[],
	allCriteria: readonly string[],
): string[] {
	const problems = coverageProblems(submission.criteria ?? [], assigned);
	const findings = submission.findings ?? [];
	const results = new Map((submission.criteria ?? []).map((outcome) => [outcome.id, outcome.result]));
	const known = new Set(allCriteria);
	const withFinding = new Set<string>();

	findings.forEach((finding, index) => {
		const at = `findings[${index}]`;
		if (blank(finding.title)) problems.push(`${at}.title: required`);
		if (blank(finding.detail)) problems.push(`${at}.detail: describe the defect and its practical effect`);
		if (blank(finding.evidence)) problems.push(`${at}.evidence: cite what you ran or read (command and output, or file:line)`);
		if (!["critical", "major", "minor"].includes(finding.severity)) problems.push(`${at}.severity: must be critical, major or minor`);
		if (finding.criterion !== undefined) {
			if (!known.has(finding.criterion)) problems.push(`${at}.criterion: ${finding.criterion} is not a criterion of this spec`);
			else {
				withFinding.add(finding.criterion);
				if (results.get(finding.criterion) === "pass") {
					problems.push(`${at}: you marked ${finding.criterion} as pass but filed a finding against it; set its result to fail, or drop the criterion link if the finding is about something else`);
				}
			}
		}
	});

	for (const outcome of submission.criteria ?? []) {
		if (outcome.result !== "pass" && !withFinding.has(outcome.id)) {
			problems.push(`criteria: ${outcome.id} is "${outcome.result}" but no finding explains it; add a finding with criterion "${outcome.id}"`);
		}
	}
	return problems;
}

/** Combine the submissions of every shard into one report with stable finding ids. */
export function mergeAuditSubmissions(
	submissions: readonly AuditSubmission[],
	meta: { name: string; revision: number; at: string; drift?: string[] },
): AuditReport {
	const criteria = submissions.flatMap((submission) => submission.criteria).sort((a, b) => compareIds(a.id, b.id));
	const findings: Finding[] = [];
	for (const submission of submissions) {
		for (const finding of submission.findings ?? []) {
			findings.push({
				id: `F${findings.length + 1}`,
				title: finding.title.trim(),
				severity: finding.severity,
				...(finding.criterion ? { criterion: finding.criterion } : {}),
				detail: finding.detail.trim(),
				evidence: finding.evidence.trim(),
				...(finding.suggestion?.trim() ? { suggestion: finding.suggestion.trim() } : {}),
			});
		}
	}
	return {
		kind: "audit",
		name: meta.name,
		createdAt: meta.at,
		revision: meta.revision,
		shards: submissions.length,
		criteria,
		findings,
		notes: cleanList(submissions.flatMap((submission) => submission.notes ?? [])),
		drift: meta.drift ?? [],
	};
}

export function validateRefinerSubmission(submission: RefinerSubmission): string[] {
	return blank(submission.summary) ? ["summary: describe what you simplified, or say that nothing needed to change"] : [];
}

/** Turn failed checks into findings so the developer can triage them like audit findings. */
export function gateFindings(checks: readonly CheckOutcome[]): Finding[] {
	return checks
		.filter((check) => !check.passed)
		.map((check, index) => ({
			id: `F${index + 1}`,
			title: `Check "${check.name}" fails`,
			severity: "major" as const,
			detail: check.timedOut
				? `\`${check.command}\` did not finish within its time limit.`
				: `\`${check.command}\` exits with code ${check.exitCode ?? "unknown"} and automatic repair attempts are exhausted.`,
			evidence: check.output.trim() === "" ? "(no output)" : check.output,
		}));
}

export function openQuestions(report: ImplementerReport): Question[] {
	return report.questions.filter((question) => !question.resolution);
}

export function openFindings(report: AuditReport | GateReport): Finding[] {
	return report.findings.filter((finding) => !finding.resolution);
}
