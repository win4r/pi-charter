/**
 * Recording developer decisions on open questions and findings.
 *
 * A batch must cover every open item exactly once; nothing is saved from a
 * partial or contradictory batch.
 */

import {
	type AuditReport,
	type FindingDecision,
	type GateReport,
	type ImplementerReport,
	openFindings,
	openQuestions,
} from "./reports.ts";
import { CharterError } from "./types.ts";

export type DecisionKind = "answer" | FindingDecision;

export interface DecisionInput {
	/** `Q1` / `F2`, optionally qualified with the report: `impl-1/Q1`. */
	ref: string;
	decision: DecisionKind;
	/** The answer (questions) or the reason (findings), in the developer's words. */
	text: string;
}

function normalizeRef(ref: string, reportName: string, problems: string[]): string | undefined {
	const trimmed = ref.trim();
	const slash = trimmed.lastIndexOf("/");
	if (slash === -1) return trimmed.toUpperCase();
	const report = trimmed.slice(0, slash);
	if (report !== reportName) {
		problems.push(`${trimmed}: decisions are open on ${reportName}, not on ${report}`);
		return undefined;
	}
	return trimmed.slice(slash + 1).toUpperCase();
}

function coverage(inputs: readonly DecisionInput[], openIds: readonly string[], reportName: string): { byId: Map<string, DecisionInput>; problems: string[] } {
	const problems: string[] = [];
	const byId = new Map<string, DecisionInput>();
	for (const input of inputs) {
		const id = normalizeRef(input.ref, reportName, problems);
		if (id === undefined) continue;
		if (!openIds.includes(id)) problems.push(`${reportName}/${id}: not an open item (open: ${openIds.map((open) => `${reportName}/${open}`).join(", ") || "none"})`);
		else if (byId.has(id)) problems.push(`${reportName}/${id}: decided more than once`);
		else byId.set(id, input);
		if (typeof input.text !== "string" || input.text.trim() === "") problems.push(`${reportName}/${id}: the developer's answer or reason is required`);
	}
	const missing = openIds.filter((id) => !byId.has(id));
	if (missing.length > 0) problems.push(`every open item needs a decision; missing: ${missing.map((id) => `${reportName}/${id}`).join(", ")}`);
	return { byId, problems };
}

export interface QuestionOutcome {
	report: ImplementerReport;
	revise: boolean;
}

/** `answer` keeps the approved spec; `revise` sends the charter back to drafting. */
export function resolveQuestions(report: ImplementerReport, inputs: readonly DecisionInput[], at: string): QuestionOutcome {
	const open = openQuestions(report).map((question) => question.id);
	const { byId, problems } = coverage(inputs, open, report.name);
	for (const [id, input] of byId) {
		if (input.decision !== "answer" && input.decision !== "revise") {
			problems.push(`${report.name}/${id}: a question takes "answer" (spec unchanged) or "revise" (spec must change), not "${input.decision}"`);
		}
	}
	if (problems.length > 0) throw new CharterError("The decisions cannot be recorded:", problems);

	let revise = false;
	const questions = report.questions.map((question) => {
		const input = byId.get(question.id);
		if (!input) return question;
		const reviseSpec = input.decision === "revise";
		revise ||= reviseSpec;
		return { ...question, resolution: { answer: input.text.trim(), reviseSpec, at } };
	});
	return { report: { ...report, questions }, revise };
}

export interface FindingOutcome<T extends AuditReport | GateReport> {
	report: T;
	/** `revise` outranks `fix`, which outranks `waived`. */
	outcome: "waived" | "fix" | "revise";
}

export function resolveFindings<T extends AuditReport | GateReport>(report: T, inputs: readonly DecisionInput[], at: string): FindingOutcome<T> {
	const open = openFindings(report).map((finding) => finding.id);
	const { byId, problems } = coverage(inputs, open, report.name);
	for (const [id, input] of byId) {
		if (input.decision !== "fix" && input.decision !== "waive" && input.decision !== "revise") {
			problems.push(`${report.name}/${id}: a finding takes "fix", "waive" or "revise", not "${input.decision}"`);
		}
	}
	if (problems.length > 0) throw new CharterError("The decisions cannot be recorded:", problems);

	let outcome: "waived" | "fix" | "revise" = "waived";
	const findings = report.findings.map((finding) => {
		const input = byId.get(finding.id);
		if (!input) return finding;
		const decision = input.decision as FindingDecision;
		if (decision === "revise") outcome = "revise";
		else if (decision === "fix" && outcome !== "revise") outcome = "fix";
		return { ...finding, resolution: { decision, reason: input.text.trim(), at } };
	});
	return { report: { ...report, findings }, outcome };
}
