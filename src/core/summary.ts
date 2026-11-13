/**
 * Text rendered from recorded facts: the status line, the status report, the
 * list of pending decisions and the final summary. None of it is written by a
 * model, so it cannot claim work that did not happen.
 */

import type { CharterConfig } from "./config.ts";
import { type AuditReport, type GateReport, type ImplementerReport, openFindings, openQuestions, type RefineReport } from "./reports.ts";
import type { CharterState } from "./state.ts";
import type { Stage, UsageTotals } from "./types.ts";

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function compact(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 10_000) return `${Math.round(value / 1000)}k`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

export function formatUsage(usage: UsageTotals): string {
	const tokens = `${compact(usage.input + usage.cacheRead + usage.cacheWrite)} in / ${compact(usage.output)} out`;
	return usage.cost > 0 ? `${tokens}, $${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}` : tokens;
}

const STAGE_LABEL: Record<Stage, string> = {
	drafting: "drafting",
	implement: "ready to implement",
	questions: "waiting for answers",
	gate: "ready to run checks",
	audit: "ready to audit",
	triage: "waiting for triage",
	refine: "ready to refine",
	done: "done",
};

/** Short text for the footer. */
export function statusLine(state: CharterState, live?: string): string {
	const cycle = state.cycle > 1 ? ` · cycle ${state.cycle}` : "";
	return `charter ${state.id} · ${live ?? STAGE_LABEL[state.stage]}${cycle}`;
}

/** What has to happen next, addressed to the coordinating model. */
export function nextAction(state: CharterState): string {
	switch (state.stage) {
		case "drafting":
			return state.revision === 0
				? "Draft brief.md and spec.md with the developer, run charter_lint until it is clean, then call charter_approve (the developer confirms in a dialog)."
				: "Revise the documents with the developer, run charter_lint until it is clean, then call charter_approve for renewed approval.";
		case "implement":
		case "gate":
		case "audit":
		case "refine":
			return "Call charter_advance to continue the pipeline.";
		case "questions":
			return `The implementer needs decisions (${state.pending}). Present every open question to the developer, collect each answer, then call charter_resolve.`;
		case "triage":
			return `Findings await triage (${state.pending}). Present every open finding to the developer, collect a decision (fix / waive / revise) and reason for each, then call charter_resolve.`;
		case "done":
			return "The charter is complete. Present the final report to the developer; the developer owns review, commits and merging.";
	}
}

export function describeQuestions(report: ImplementerReport): string {
	const lines: string[] = [`Open questions from ${report.name}:`];
	for (const question of openQuestions(report)) {
		lines.push("", `${report.name}/${question.id}: ${question.title}`, question.detail);
		question.options.forEach((option, index) => lines.push(`  option ${index + 1}: ${option.label} -> ${option.consequence}`));
		if (question.recommendation) lines.push(`  implementer recommends: ${question.recommendation}`);
	}
	return lines.join("\n");
}

export function describeFindings(report: AuditReport | GateReport, evidenceLimit = 1200): string {
	const lines: string[] = [`Open findings from ${report.name}:`];
	for (const finding of openFindings(report)) {
		const evidence = finding.evidence.length > evidenceLimit ? `${finding.evidence.slice(0, evidenceLimit)}\n[... truncated; full text in the report file ...]` : finding.evidence;
		lines.push(
			"",
			`${report.name}/${finding.id} [${finding.severity}${finding.criterion ? `, ${finding.criterion}` : ""}]: ${finding.title}`,
			finding.detail,
			`  evidence: ${evidence}`,
		);
		if (finding.suggestion) lines.push(`  suggestion: ${finding.suggestion}`);
	}
	return lines.join("\n");
}

export interface StatusExtras {
	config: CharterConfig;
	directory: string;
	pendingText?: string;
}

/** Multi-line status for `/charter status` and the `charter_status` tool. */
export function describeStatus(state: CharterState, extras: StatusExtras): string {
	const lines = [
		`Charter ${state.id}: ${state.title}`,
		`Location: ${extras.directory}/${state.id}/`,
		`Stage: ${state.stage} (${STAGE_LABEL[state.stage]})`,
		state.approval
			? `Approval: revision ${state.approval.revision}, ${state.approval.criteria.length} acceptance criteria, approved ${state.approval.at}`
			: state.revision > 0
				? `Approval: none in force (reopened after revision ${state.revision})`
				: "Approval: not yet approved",
	];
	if (state.approval && state.stage !== "done") {
		lines.push(`Cycle: ${state.cycle} of ${extras.config.limits.cycles + state.cycleGrant}`);
	}
	if (state.active) lines.push(`Interrupted run: ${state.active.step} started ${state.active.startedAt} never finished; advancing will retry it.`);
	const last = state.runs.at(-1);
	if (last) lines.push(`Last run: ${last.label} -> ${last.outcome}${last.error ? ` (${last.error})` : ""}, ${formatDuration(last.durationMs)}`);
	if (state.runs.length > 0) lines.push(`Agent usage so far: ${formatUsage(state.usage)} across ${state.runs.filter((run) => run.step !== "gate").length} agent run(s)`);
	if (state.checkpoints.length > 0) lines.push(`Checkpoints: ${state.checkpoints.map((checkpoint) => checkpoint.label).join(", ")}`);
	for (const skipped of state.skipped) lines.push(`Skipped: ${skipped.step} (${skipped.reason})`);
	lines.push("", `Next: ${nextAction(state)}`);
	if (extras.pendingText) lines.push("", extras.pendingText);
	return lines.join("\n");
}

export interface FinalReportInput {
	state: CharterState;
	config: CharterConfig;
	implementer?: ImplementerReport;
	audits: AuditReport[];
	gates: GateReport[];
	refine?: RefineReport;
}

function table(header: string[], rows: string[][]): string[] {
	const escape = (cell: string): string => cell.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
	return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`)];
}

/** The closing summary, generated from the saved reports. */
export function buildFinalReport(input: FinalReportInput): string {
	const { state, config } = input;
	const lines: string[] = [`# Charter ${state.id}: ${state.title}`, ""];
	const audit = input.audits.at(-1);
	const gate = input.gates.at(-1);

	if (!config.roles.implementer.enabled || !input.implementer) {
		lines.push(
			"**Result: specification approved; nothing was implemented by this pipeline.**",
			"",
			`The implementer is disabled, so the approved documents (revision ${state.revision}) are the deliverable. No code was written, checked or audited here.`,
		);
	} else {
		const independent = audit !== undefined && !state.skipped.some((skipped) => skipped.step === "audit");
		lines.push(
			`**Result: implementation ready for your review** (approved revision ${state.revision}, ${state.cycle} implementation cycle${state.cycle === 1 ? "" : "s"}).`,
			"",
			independent
				? "Every acceptance criterion was checked by an auditor that did not write the code."
				: "No independent audit ran. The criterion results below are the implementer's own claims.",
			"",
			"## What was built",
			"",
			input.implementer.summary,
		);
		if (input.implementer.notes.length > 0) lines.push("", ...input.implementer.notes.map((note) => `- ${note}`));

		lines.push("", "## Acceptance criteria", "");
		const auditResults = new Map((independent ? audit?.criteria : undefined)?.map((outcome) => [outcome.id, outcome]) ?? []);
		lines.push(
			...table(
				independent ? ["Criterion", "Implementer", "Auditor", "Auditor evidence"] : ["Criterion", "Implementer", "Implementer evidence"],
				input.implementer.criteria.map((outcome) => {
					const audited = auditResults.get(outcome.id);
					return independent ? [outcome.id, outcome.result, audited?.result ?? "not audited", audited?.evidence ?? ""] : [outcome.id, outcome.result, outcome.evidence];
				}),
			),
		);

		if (gate) {
			lines.push("", "## Project checks", "", ...table(["Check", "Command", "Result", "Time"], gate.checks.map((check) => [check.name, `\`${check.command}\``, check.passed ? "pass" : check.timedOut ? "TIMEOUT" : `FAIL (exit ${check.exitCode ?? "?"})`, formatDuration(check.durationMs)])));
		}

		const decided = [...input.audits, ...input.gates].flatMap((report) => report.findings.filter((finding) => finding.resolution).map((finding) => ({ report: report.name, finding })));
		if (decided.length > 0) {
			lines.push("", "## Findings and decisions", "");
			lines.push(...table(["Finding", "Severity", "Title", "Decision", "Reason"], decided.map(({ report, finding }) => [`${report}/${finding.id}`, finding.severity, finding.title, finding.resolution?.decision ?? "", finding.resolution?.reason ?? ""])));
			const waived = decided.filter(({ finding }) => finding.resolution?.decision === "waive");
			if (waived.length > 0) lines.push("", `${waived.length} finding${waived.length === 1 ? " was" : "s were"} waived: the behavior they describe is still present.`);
		}

		if (input.refine) {
			lines.push("", "## Refinement", "");
			if (input.refine.outcome === "kept") lines.push(input.refine.summary, "", `Files refined: ${input.refine.filesChanged.join(", ") || "(none listed)"}`, "", "Refinement ran after the audit; it is protected by scope enforcement and the project checks, not by a second audit.");
			else if (input.refine.outcome === "reverted") lines.push(`The refinement was discarded and the accepted code restored: ${input.refine.revertReason ?? "unknown reason"}.`);
			else lines.push("The refiner found nothing worth changing.");
		}
	}

	if (state.skipped.length > 0) {
		lines.push("", "## Not performed", "", ...state.skipped.map((skipped) => `- ${skipped.step}: ${skipped.reason}`));
	}
	if (state.notes.length > 0) lines.push("", "## Notes", "", ...state.notes.map((note) => `- ${note}`));

	if (state.runs.length > 0) {
		lines.push("", "## Runs", "");
		lines.push(...table(["Run", "Outcome", "Model", "Time", "Usage"], state.runs.map((run) => [run.label, run.outcome, run.model ?? "", formatDuration(run.durationMs), run.step === "gate" ? "" : formatUsage(run.usage)])));
		lines.push("", `Total agent usage: ${formatUsage(state.usage)}.`);
	}

	lines.push("", "## Your turn", "", "Review the changes, then commit and merge as you see fit. Nothing was committed, pushed or staged by the pipeline.");
	if (state.baseline) lines.push("", `Everything changed since approval: \`git diff ${state.baseline.slice(0, 12)}\` (untracked files: \`git status\`).`);
	return `${lines.join("\n")}\n`;
}
