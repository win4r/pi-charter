import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveFindings, resolveQuestions } from "../../src/core/decisions.ts";
import {
	type AuditReport,
	buildImplementerReport,
	gateFindings,
	type ImplementerSubmission,
	mergeAuditSubmissions,
	openFindings,
	validateAuditSubmission,
	validateImplementerSubmission,
	validateRefinerSubmission,
} from "../../src/core/reports.ts";
import { CharterError } from "../../src/core/types.ts";
import { passAll } from "../support/fixtures.ts";

const IDS = ["AC1", "AC2"];
const AT = "2026-01-01T00:00:00.000Z";

test("implementer: done requires every criterion, passing, with evidence", () => {
	assert.deepEqual(validateImplementerSubmission({ status: "done", summary: "built", criteria: passAll(IDS) }, IDS), []);
	const problems = validateImplementerSubmission(
		{ status: "done", summary: " ", criteria: [{ id: "AC1", result: "fail", evidence: "" }, { id: "AC1", result: "pass", evidence: "x" }, { id: "AC9", result: "pass", evidence: "x" }], questions: [{ title: "q", detail: "d", options: [] }] },
		IDS,
	).join("\n");
	for (const fragment of ["AC1 is reported more than once", "AC9 is not one of", "AC1 needs evidence", "missing a result for AC2", "summary:", "requires every criterion to pass", "cannot carry questions"]) {
		assert.ok(problems.includes(fragment), `${fragment}\n---\n${problems}`);
	}
});

test("implementer: blocked requires a well-formed question and keeps honest results", () => {
	assert.match(validateImplementerSubmission({ status: "blocked", summary: "s", criteria: passAll(IDS, "untested") }, IDS).join(), /needs at least one question/);
	const submission: ImplementerSubmission = {
		status: "blocked",
		summary: "stopped",
		criteria: [{ id: "AC2", result: "untested", evidence: "not reached" }, { id: "AC1", result: "pass", evidence: "ran test" }],
		questions: [{ title: "Which rounding?", detail: "Spec is silent.", options: [{ label: "half-up", consequence: "matches invoices" }], recommendation: " half-up " }],
		notes: [" a ", "", "a"],
	};
	assert.deepEqual(validateImplementerSubmission(submission, IDS), []);
	const report = buildImplementerReport(submission, { name: "impl-1", revision: 1, cycle: 1, at: AT });
	assert.deepEqual(report.criteria.map((c) => c.id), ["AC1", "AC2"]);
	assert.deepEqual(report.notes, ["a"]);
	assert.deepEqual(report.questions[0], { id: "Q1", title: "Which rounding?", detail: "Spec is silent.", options: [{ label: "half-up", consequence: "matches invoices" }], recommendation: "half-up" });
});

test("auditor: every non-pass needs a finding, and a finding cannot contradict a pass", () => {
	assert.deepEqual(validateAuditSubmission({ criteria: passAll(["AC1"]) }, ["AC1"], IDS), []);
	const problems = validateAuditSubmission(
		{
			criteria: [{ id: "AC1", result: "pass", evidence: "e" }, { id: "AC2", result: "fail", evidence: "e" }],
			findings: [{ title: "t", severity: "major", criterion: "AC1", detail: "d", evidence: "e" }, { title: "", severity: "major", criterion: "AC7", detail: "", evidence: "" }],
		},
		IDS,
		IDS,
	).join("\n");
	for (const fragment of ["marked AC1 as pass but filed a finding", "AC7 is not a criterion", "findings[1].title", "findings[1].evidence", 'AC2 is "fail" but no finding']) {
		assert.ok(problems.includes(fragment), `${fragment}\n---\n${problems}`);
	}
	// A shard may only report on its own criteria, but may link a finding to any criterion of the spec.
	assert.match(validateAuditSubmission({ criteria: passAll(IDS) }, ["AC1"], IDS).join(), /AC2 is not one of the criteria you were asked/);
	assert.deepEqual(validateAuditSubmission({ criteria: passAll(["AC1"]), findings: [{ title: "regression", severity: "minor", detail: "d", evidence: "e" }] }, ["AC1"], IDS), []);
});

test("shard submissions merge into one report with stable finding ids", () => {
	const report = mergeAuditSubmissions(
		[
			{ criteria: [{ id: "AC2", result: "fail", evidence: "e" }], findings: [{ title: "b", severity: "major", criterion: "AC2", detail: "d", evidence: "e" }], notes: ["n"] },
			{ criteria: passAll(["AC1"]), findings: [{ title: "a", severity: "minor", detail: "d", evidence: "e", suggestion: " s " }], notes: ["n"] },
		],
		{ name: "audit-1", revision: 2, at: AT },
	);
	assert.deepEqual(report.criteria.map((c) => c.id), ["AC1", "AC2"]);
	assert.deepEqual(report.findings.map((f) => [f.id, f.title, f.suggestion]), [["F1", "b", undefined], ["F2", "a", "s"]]);
	assert.equal(report.shards, 2);
	assert.deepEqual(report.notes, ["n"]);
});

test("failed checks become findings; refiner needs a summary", () => {
	const findings = gateFindings([
		{ name: "lint", command: "npm run lint", passed: true, exitCode: 0, timedOut: false, durationMs: 1, output: "" },
		{ name: "test", command: "npm test", passed: false, exitCode: 1, timedOut: false, durationMs: 1, output: "1 failing" },
		{ name: "slow", command: "sleep 9", passed: false, exitCode: null, timedOut: true, durationMs: 1, output: "" },
	]);
	assert.deepEqual(findings.map((f) => [f.id, f.title]), [["F1", 'Check "test" fails'], ["F2", 'Check "slow" fails']]);
	assert.match(findings[1]?.detail ?? "", /time limit/);
	assert.equal(findings[1]?.evidence, "(no output)");
	assert.equal(validateRefinerSubmission({ summary: "" }).length, 1);
	assert.equal(validateRefinerSubmission({ summary: "nothing to change" }).length, 0);
});

test("question decisions must cover every open question exactly once", () => {
	const report = buildImplementerReport(
		{ status: "blocked", summary: "s", criteria: passAll(IDS, "untested"), questions: [{ title: "a", detail: "d", options: [] }, { title: "b", detail: "d", options: [] }] },
		{ name: "impl-1", revision: 1, cycle: 1, at: AT },
	);
	assert.throws(
		() => resolveQuestions(report, [{ ref: "impl-1/Q1", decision: "fix", text: "x" }, { ref: "Q1", decision: "answer", text: "y" }, { ref: "impl-2/Q2", decision: "answer", text: "z" }, { ref: "Q9", decision: "answer", text: "" }], AT),
		(error: unknown) => {
			assert.ok(error instanceof CharterError);
			const joined = error.problems.join("\n");
			for (const fragment of ["decided more than once", "open on impl-1, not on impl-2", "Q9: not an open item", "answer or reason is required", "missing: impl-1/Q2", 'not "fix"']) assert.ok(joined.includes(fragment), `${fragment}\n---\n${joined}`);
			return true;
		},
	);
	const kept = resolveQuestions(report, [{ ref: "q1", decision: "answer", text: " yes " }, { ref: "impl-1/Q2", decision: "answer", text: "no" }], AT);
	assert.equal(kept.revise, false);
	assert.deepEqual(kept.report.questions[0]?.resolution, { answer: "yes", reviseSpec: false, at: AT });
	assert.equal(resolveQuestions(report, [{ ref: "Q1", decision: "answer", text: "a" }, { ref: "Q2", decision: "revise", text: "b" }], AT).revise, true);
	// Once answered, nothing is open any more.
	assert.throws(() => resolveQuestions(kept.report, [{ ref: "Q1", decision: "answer", text: "again" }], AT), /not an open item/);
});

test("finding decisions: revise outranks fix outranks waive", () => {
	const report: AuditReport = mergeAuditSubmissions(
		[{ criteria: passAll(IDS, "fail"), findings: ["AC1", "AC2"].map((criterion) => ({ title: criterion, severity: "major" as const, criterion, detail: "d", evidence: "e" })) }],
		{ name: "audit-1", revision: 1, at: AT },
	);
	const decide = (a: "fix" | "waive" | "revise", b: "fix" | "waive" | "revise") =>
		resolveFindings(report, [{ ref: "audit-1/F1", decision: a, text: "r" }, { ref: "F2", decision: b, text: "r" }], AT);
	assert.equal(decide("waive", "waive").outcome, "waived");
	assert.equal(decide("waive", "fix").outcome, "fix");
	assert.equal(decide("revise", "fix").outcome, "revise");
	assert.equal(decide("fix", "revise").outcome, "revise");
	assert.equal(openFindings(decide("waive", "fix").report).length, 0);
	assert.throws(() => resolveFindings(report, [{ ref: "F1", decision: "answer", text: "r" }], AT), /"fix", "waive" or "revise"/);
});
