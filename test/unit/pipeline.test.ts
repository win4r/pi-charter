import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { AuditReport, GateReport, ImplementerReport, RefineReport } from "../../src/core/reports.ts";
import { CharterError } from "../../src/core/types.ts";
import type { RoleRunRequest } from "../../src/engine/pipeline.ts";
import { cloneConfig, DEFAULT_CONFIG } from "../../src/core/config.ts";
import { CharterStore } from "../../src/core/store.ts";
import { Engine } from "../../src/engine/pipeline.ts";
import { criteriaOf, harness, type Harness, passAll, ScriptedRunner, specWith, tempProject } from "../support/fixtures.ts";

const node = (script: string): string => `node -e ${JSON.stringify(script)}`;

/** An implementer that writes one file and reports every criterion as passing. */
const implement = (h: Harness, file = "src/greet.js", content = "export const greet = (n) => `Hello, ${n}`;\n") => (request: RoleRunRequest) => {
	h.project.write(file, content);
	request.submit({ status: "done", summary: `wrote ${file}`, criteria: passAll(criteriaOf(request)), filesChanged: [file] });
};
const auditClean = (request: RoleRunRequest): void => request.submit({ criteria: passAll(criteriaOf(request)) });

async function withHarness(options: Parameters<typeof harness>[0], body: (h: Harness) => Promise<void>): Promise<void> {
	const h = harness(options);
	try {
		await body(h);
		assert.equal(h.runner.pending(), 0, "every scripted step should have been used");
	} finally {
		h.project.cleanup();
	}
}

test("happy path: approve, implement, audit, done", () =>
	withHarness({}, async (h) => {
		const id = await h.draft(2);
		const preview = await h.engine.previewApproval(id);
		assert.equal(preview.lint.errors, 0);
		assert.deepEqual(preview.documents, ["brief.md", "spec.md"]);

		const approved = await h.engine.approve(id);
		assert.equal(approved.stage, "implement");
		assert.deepEqual(approved.approval?.criteria, ["AC1", "AC2"]);
		assert.ok(approved.baseline);

		h.runner.on("implementer", implement(h)).on("auditor", auditClean);
		const steps: string[] = [];
		const result = await h.engine.advance(id, { onStep: (step) => steps.push(step) });
		assert.equal(result.status, "done");
		assert.deepEqual(steps, ["implementer impl-1", "auditor audit-1"]);

		const state = result.state;
		assert.equal(state.stage, "done");
		assert.equal(state.active, null);
		assert.deepEqual(state.runs.map((run) => [run.label, run.outcome]), [["impl-1", "reported"], ["audit-1", "reported"]]);
		assert.equal(state.usage.input, 200);
		assert.deepEqual(state.checkpoints.map((checkpoint) => checkpoint.label), ["baseline", "pre-impl-1"]);

		const [implementer, auditor] = h.runner.requests;
		assert.match(implementer?.prompt ?? "", /<document name="spec\.md">[\s\S]*AC2: Greeting 2/);
		assert.match(implementer?.prompt ?? "", /No project files have changed/);
		assert.match(auditor?.prompt ?? "", /A src\/greet\.js/);
		assert.ok(auditor?.writableOnly, "auditors are confined to a scratch directory");
		assert.equal(implementer?.writableOnly, undefined);
		assert.deepEqual(implementer?.protectedPaths, [h.store.charter(id).dir]);

		if (result.status !== "done") return;
		assert.match(result.report, /implementation ready for your review/);
		assert.match(result.report, /checked by an auditor that did not write the code/);
		assert.match(result.report, /\| AC1 \| pass \| pass \| checked AC1 \|/);
		assert.match(result.report, /project checks: no checks are configured/);
		assert.match(result.report, /refinement: the refiner is disabled/);
		assert.equal(h.project.read(`.charter/${id}/report.md`), result.report);
		assert.deepEqual((await h.store.charter(id).readJournal()).map((event) => event.event), ["created", "approved", "run-started", "run-reported", "run-started", "run-reported", "completed"]);

		// Advancing a finished charter is idempotent.
		const again = await h.engine.advance(id);
		assert.equal(again.status, "done");
		assert.equal((await h.store.charter(id).readJournal()).filter((event) => event.event === "completed").length, 1);
	}));

test("approval is refused for documents that fail lint, and only from drafting", () =>
	withHarness({}, async (h) => {
		const state = await h.engine.create("Greeting", { brief: "# Brief: {{title}}\n", spec: "# Spec\n" });
		await assert.rejects(h.engine.approve(state.id), /cannot be approved while lint reports errors[\s\S]*no-criteria/);
		assert.equal((await h.store.charter(state.id).load()).stage, "drafting");

		const id = await h.draft();
		await h.engine.approve(id);
		await assert.rejects(h.engine.approve(id), /only a charter in drafting can be approved/);
		assert.equal((await h.engine.advance(state.id)).status, "waiting");
	}));

test("documents are frozen: edits after approval stop the pipeline until the charter is reopened", () =>
	withHarness({}, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.project.write(`.charter/${id}/spec.md`, specWith(3));
		const halted = await h.engine.advance(id);
		assert.equal(halted.status, "halted");
		assert.match(halted.status === "halted" ? halted.reason : "", /changed after approval \(spec\.md\)[\s\S]*\/charter reopen/);
		assert.equal(h.runner.requests.length, 0);

		const reopened = await h.engine.reopen(id);
		assert.equal(reopened.stage, "drafting");
		assert.equal(reopened.approval, null);
		const approved = await h.engine.approve(id);
		assert.equal(approved.revision, 2);
		assert.deepEqual(approved.approval?.criteria, ["AC1", "AC2", "AC3"]);
		assert.ok(existsSync(join(h.store.charter(id).approvedDir(1), "spec.md")) && existsSync(join(h.store.charter(id).approvedDir(2), "spec.md")));
	}));

test("an agent that edits approved documents is undone and named in the report", () =>
	withHarness({ config: (c) => void (c.roles.auditor.enabled = false) }, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		const original = h.project.read(`.charter/${id}/spec.md`);
		h.runner.on("implementer", (request) => {
			h.project.write(`.charter/${id}/spec.md`, "# rewritten to be easier\n");
			implement(h)(request);
		});
		const notices: string[] = [];
		const result = await h.engine.advance(id, { onNotice: (notice) => notices.push(notice) });
		assert.equal(result.status, "done");
		assert.equal(h.project.read(`.charter/${id}/spec.md`), original);
		assert.match(notices.join(), /impl-1 modified approved documents \(spec\.md\)/);
		assert.match(result.status === "done" ? result.report : "", /## Notes[\s\S]*impl-1 modified approved documents/);
		assert.match(result.status === "done" ? result.report : "", /No independent audit ran/);
	}));

test("an invalid report is rejected with reasons and can be resubmitted in the same run", () =>
	withHarness({ config: (c) => void (c.roles.auditor.enabled = false) }, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", (request) => {
			assert.throws(
				() => request.submit({ status: "done", summary: "x", criteria: [{ id: "AC1", result: "fail", evidence: "boom" }] }),
				(error: unknown) => error instanceof CharterError && /missing a result for AC2/.test(error.message) && /requires every criterion to pass/.test(error.message),
			);
			implement(h)(request);
		});
		assert.equal((await h.engine.advance(id)).status, "done");
	}));

test("blocked implementer: questions go to the developer and the answers reach the next run", () =>
	withHarness({}, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", (request) =>
			request.submit({
				status: "blocked",
				summary: "stopped at rounding",
				criteria: passAll(criteriaOf(request), "untested"),
				questions: [{ title: "Which greeting for empty names?", detail: "The spec does not say.", options: [{ label: "Hello, stranger", consequence: "friendly" }, { label: "throw", consequence: "strict" }], recommendation: "throw" }],
			}),
		);
		const waiting = await h.engine.advance(id);
		assert.equal(waiting.status, "waiting");
		assert.equal(waiting.status === "waiting" ? waiting.waitingFor : "", "answers");
		assert.match(waiting.status === "waiting" ? waiting.text : "", /impl-1\/Q1: Which greeting for empty names\?[\s\S]*option 2: throw -> strict[\s\S]*recommends: throw/);
		assert.equal(waiting.state.stage, "questions");

		await assert.rejects(h.engine.resolve(id, []), /missing: impl-1\/Q1/);
		const state = await h.engine.resolve(id, [{ ref: "impl-1/Q1", decision: "answer", text: "Throw a TypeError." }]);
		assert.equal(state.stage, "implement");
		assert.equal(state.cycle, 2);

		h.runner.on("implementer", implement(h)).on("auditor", auditClean);
		assert.equal((await h.engine.advance(id)).status, "done");
		const second = h.runner.requests[1]?.prompt ?? "";
		assert.match(second, /Implement charter .* \(cycle 2\)/);
		assert.match(second, /## Developer decisions[\s\S]*impl-1\/Q1 "Which greeting for empty names\?" -> Throw a TypeError\./);
		assert.match(h.runner.requests[2]?.prompt ?? "", /## Developer decisions/, "auditors see binding decisions too");
		assert.equal((await h.store.charter(id).readReport<ImplementerReport>("impl-1", "implementer")).questions[0]?.resolution?.reviseSpec, false);
	}));

test("a question answered with revise returns the charter to drafting for renewed approval", () =>
	withHarness({}, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", (request) => request.submit({ status: "blocked", summary: "s", criteria: passAll(criteriaOf(request), "untested"), questions: [{ title: "conflict", detail: "R1 contradicts R2", options: [] }] }));
		await h.engine.advance(id);
		const state = await h.engine.resolve(id, [{ ref: "Q1", decision: "revise", text: "Drop R2." }]);
		assert.equal(state.stage, "drafting");
		assert.equal(state.approval, null);
		assert.equal((await h.engine.advance(id)).status, "waiting");
		h.project.write(`.charter/${id}/spec.md`, specWith(1));
		const approved = await h.engine.approve(id);
		assert.equal(approved.revision, 2);
		assert.equal(approved.cycle, 1);
		assert.deepEqual(approved.approval?.criteria, ["AC1"]);
	}));

test("failing checks go straight back to the implementer without spending an audit", () =>
	withHarness({ config: (c) => void (c.checks = [{ name: "marker", run: node("if (!require('fs').existsSync('fixed.txt')) { console.error('fixed.txt is missing'); process.exit(1) }"), timeoutSeconds: 30 }]) }, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner
			.on("implementer", implement(h), (request) => {
				h.project.write("fixed.txt", "ok\n");
				request.submit({ status: "done", summary: "repaired", criteria: passAll(criteriaOf(request)) });
			})
			.on("auditor", auditClean);
		const notices: string[] = [];
		const result = await h.engine.advance(id, { onNotice: (notice) => notices.push(notice) });
		assert.equal(result.status, "done");
		assert.deepEqual(result.state.runs.map((run) => `${run.label}:${run.outcome}`), ["impl-1:reported", "gate-1:check-failed", "impl-2:reported", "gate-2:passed", "audit-1:reported"]);
		assert.equal(result.state.cycle, 1, "an automatic repair is not a new cycle");
		assert.match(notices.join(), /Checks failed \(marker\); sending them back to the implementer \(repair 1\/2\)/);
		const repair = h.runner.requests[1]?.prompt ?? "";
		assert.match(repair, /## What to fix in this run[\s\S]*Check "marker"[\s\S]*fixed\.txt is missing/);
		assert.match(repair, /## Project checks[\s\S]*- marker:/);
		assert.match(result.status === "done" ? result.report : "", /## Project checks[\s\S]*\| marker \|.*\| pass \|/);
	}));

test("checks that keep failing are escalated; waiving them still leads to the audit", () =>
	withHarness({ config: (c) => { c.checks = [{ name: "never", run: node("process.exit(2)"), timeoutSeconds: 30 }]; c.limits.gateRetries = 1; } }, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h), implement(h));
		const waiting = await h.engine.advance(id);
		assert.equal(waiting.status === "waiting" ? waiting.waitingFor : "", "triage");
		assert.equal(waiting.state.pending, "gate-2");
		assert.match(waiting.status === "waiting" ? waiting.text : "", /gate-2\/F1 \[major\]: Check "never" fails/);
		const gate = await h.store.charter(id).readReport<GateReport>("gate-2", "gate");
		assert.equal(gate.findings.length, 1);

		const state = await h.engine.resolve(id, [{ ref: "gate-2/F1", decision: "waive", text: "Known flaky check, tracked elsewhere." }]);
		assert.equal(state.stage, "audit");
		h.runner.on("auditor", auditClean);
		const result = await h.engine.advance(id);
		assert.equal(result.status, "done");
		assert.match(result.status === "done" ? result.report : "", /gate-2\/F1 \| major \| Check "never" fails \| waive \| Known flaky check[\s\S]*1 finding was waived/);
		assert.match(result.status === "done" ? result.report : "", /\| never \|.*FAIL \(exit 2\)/);
	}));

test("audit findings: fix sends them to the implementer, then everything is audited again", () =>
	withHarness({}, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h)).on("auditor", (request) =>
			request.submit({
				criteria: [{ id: "AC1", result: "pass", evidence: "ran it" }, { id: "AC2", result: "fail", evidence: "got Hello 1" }],
				findings: [
					{ title: "Wrong greeting number", severity: "critical", criterion: "AC2", detail: "Returns greeting 1 for case 2.", evidence: "node -e ... => Hello 1, Ada", suggestion: "Use the case index." },
					{ title: "Trailing space", severity: "minor", detail: "Output ends with a space.", evidence: "src/greet.js:1" },
				],
			}),
		);
		const waiting = await h.engine.advance(id);
		assert.equal(waiting.status === "waiting" ? waiting.waitingFor : "", "triage");
		assert.match(waiting.status === "waiting" ? waiting.text : "", /audit-1\/F1 \[critical, AC2\]: Wrong greeting number[\s\S]*audit-1\/F2 \[minor\]: Trailing space/);

		await assert.rejects(h.engine.resolve(id, [{ ref: "F1", decision: "fix", text: "yes" }]), /missing: audit-1\/F2/);
		const state = await h.engine.resolve(id, [{ ref: "audit-1/F1", decision: "fix", text: "Must match the spec." }, { ref: "audit-1/F2", decision: "waive", text: "Harmless." }]);
		assert.equal(state.stage, "implement");
		assert.equal(state.cycle, 2);
		assert.deepEqual(state.fixFrom, ["audit-1"]);

		h.runner.on("implementer", implement(h, "src/greet.js", "fixed\n")).on("auditor", auditClean);
		const result = await h.engine.advance(id);
		assert.equal(result.status, "done");
		const fix = h.runner.requests[2]?.prompt ?? "";
		assert.match(fix, /## What to fix in this run[\s\S]*audit-1\/F1 \(critical, AC2\): Wrong greeting number[\s\S]*Suggestion: Use the case index\.[\s\S]*Developer: Must match the spec\./);
		assert.doesNotMatch(fix, /Trailing space/, "waived findings are not work for the implementer");
		assert.match(fix, /M? ?src\/greet\.js/);
		const reaudit = h.runner.requests[3]?.prompt ?? "";
		assert.match(reaudit, /## Already decided[\s\S]*audit-1\/F2 "Trailing space" -> waived: Harmless\./);
		assert.deepEqual(criteriaOf(h.runner.requests[3] as RoleRunRequest), ["AC1", "AC2"], "the whole spec is audited again after a fix");
		assert.match(result.status === "done" ? result.report : "", /audit-1\/F2 \| minor \| Trailing space \| waive \| Harmless\./);
	}));

test("a finding decided as revise outranks fixes and reopens the spec", () =>
	withHarness({}, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h)).on("auditor", (request) =>
			request.submit({ criteria: passAll(criteriaOf(request)), findings: [{ title: "a", severity: "major", detail: "d", evidence: "e" }, { title: "b", severity: "major", detail: "d", evidence: "e" }] }),
		);
		await h.engine.advance(id);
		const state = await h.engine.resolve(id, [{ ref: "F1", decision: "fix", text: "r" }, { ref: "F2", decision: "revise", text: "The spec is wrong about b." }]);
		assert.equal(state.stage, "drafting");
		await assert.rejects(h.engine.resolve(id, [{ ref: "F1", decision: "fix", text: "r" }]), /Nothing is waiting for a decision/);
	}));

test("parallel auditors get disjoint criteria and their reports are merged", () =>
	withHarness({ config: (c) => void (c.roles.auditor.shards = 3) }, async (h) => {
		const id = await h.draft(5);
		await h.engine.approve(id);
		// A barrier instead of a sleep: no shard may finish before all three are running, so the
		// assertion holds on any machine. If shards ran one after another, this would never resolve.
		let peak = 0;
		let release: () => void = () => undefined;
		const allRunning = new Promise<void>((resolve) => {
			release = resolve;
		});
		const shard = async (request: RoleRunRequest): Promise<void> => {
			if (++peak === 3) release();
			await allRunning;
			const ids = criteriaOf(request);
			request.submit(ids.includes("AC3") ? { criteria: passAll(ids, "fail"), findings: ids.map((criterion) => ({ title: `bad ${criterion}`, severity: "major", criterion, detail: "d", evidence: "e" })) } : { criteria: passAll(ids) });
		};
		h.runner.on("implementer", implement(h)).on("auditor", shard, shard, shard);
		const steps: string[] = [];
		const waiting = await h.engine.advance(id, { onStep: (step) => steps.push(step) });
		assert.equal(peak, 3, "shards run concurrently");
		assert.ok(steps.includes("auditors audit-1 (3 in parallel)"));
		const auditors = h.runner.requests.filter((request) => request.role === "auditor").sort((a, b) => (a.label < b.label ? -1 : 1));
		assert.deepEqual(auditors.map(criteriaOf), [["AC1", "AC2"], ["AC3", "AC4"], ["AC5"]]);
		assert.deepEqual(auditors.map((request) => request.label), ["audit-1#1", "audit-1#2", "audit-1#3"]);
		assert.match(auditors[1]?.prompt ?? "", /You are auditor 2 of 3 working in parallel/);
		assert.equal(new Set(auditors.map((request) => request.writableOnly)).size, 3, "each shard has its own scratch directory");

		const report = await h.store.charter(id).readReport<AuditReport>("audit-1", "audit");
		assert.equal(report.shards, 3);
		assert.deepEqual(report.criteria.map((outcome) => outcome.id), ["AC1", "AC2", "AC3", "AC4", "AC5"]);
		assert.deepEqual(report.findings.map((finding) => [finding.id, finding.criterion]), [["F1", "AC3"], ["F2", "AC4"]]);
		assert.equal(waiting.state.runs.filter((run) => run.step === "auditor").length, 3);
	}));

test("without snapshots, one failing shard stops the others, halts the audit, and a retry starts clean", () =>
	withHarness({ git: false, config: (c) => void (c.roles.auditor.shards = 2) }, async (h) => {
		const id = await h.draft(2);
		await h.engine.approve(id);
		let peerAborted = false;
		h.runner.on("implementer", implement(h)).on(
			"auditor",
			() => ({ outcome: "failed", error: "provider returned 529" }),
			async (request) => {
				if (!request.signal?.aborted) await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
				peerAborted = true;
				return { outcome: "aborted" };
			},
		);
		const halted = await h.engine.advance(id);
		assert.equal(halted.status, "halted");
		assert.ok(peerAborted);
		assert.match(halted.status === "halted" ? halted.reason : "", /audit-1#\d failed: provider returned 529[\s\S]*stays at "audit"/);
		assert.equal(halted.state.stage, "audit");
		assert.equal(halted.state.active, null);
		assert.equal(halted.state.counters.audit, 0);

		h.runner.on("auditor", auditClean, auditClean);
		const result = await h.engine.advance(id);
		assert.equal(result.status, "done");
		assert.deepEqual(result.state.runs.filter((run) => run.step === "auditor").map((run) => run.outcome).sort(), ["aborted", "failed", "reported", "reported"]);
	}));

test("an auditor that changes project files is undone and reported", () =>
	withHarness({}, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h)).on("auditor", (request) => {
			h.project.write("src/greet.js", "auditor 'fixed' it\n");
			h.project.write("debug-output.txt", "left behind\n");
			auditClean(request);
		});
		const result = await h.engine.advance(id);
		assert.equal(result.status, "done");
		assert.match(h.project.read("src/greet.js"), /Hello, /);
		assert.equal(existsSync(join(h.project.root, "debug-output.txt")), false);
		assert.deepEqual((await h.store.charter(id).readReport<AuditReport>("audit-1", "audit")).drift, ["debug-output.txt", "src/greet.js"]);
		assert.match(result.status === "done" ? result.report : "", /audit-1 left 2 project file\(s\) changed/);
	}));

test("a run that fails or never reports halts in place and can be retried", () =>
	withHarness({ config: (c) => void (c.roles.auditor.enabled = false) }, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", () => ({ outcome: "timeout", transcript: "/tmp/session.jsonl" }), () => undefined, implement(h));

		const first = await h.engine.advance(id);
		assert.match(first.status === "halted" ? first.reason : "", /impl-1 exceeded its time limit[\s\S]*Transcript: \/tmp\/session\.jsonl[\s\S]*advance again to retry/);
		const second = await h.engine.advance(id);
		assert.match(second.status === "halted" ? second.reason : "", /impl-1 ended without filing its report/);
		assert.equal(second.state.stage, "implement");
		assert.equal(second.state.cycle, 1, "a retry is not a new cycle");

		assert.deepEqual(second.state.checkpoints.map((checkpoint) => checkpoint.label), ["baseline", "pre-impl-1"], "a retry does not stack checkpoints");

		// Simulate a crash that left a run marked as live.
		const charter = h.store.charter(id);
		const crashed = await charter.load();
		crashed.active = { step: "impl-1", startedAt: "x", pid: 1 };
		writeFileSync(charter.statePath, JSON.stringify(crashed));

		const third = await h.engine.advance(id);
		assert.equal(third.status, "done");
		assert.deepEqual(third.state.runs.map((run) => `${run.label}:${run.outcome}`), ["impl-1:timeout", "impl-1:no-report", "impl-1:reported"]);
		assert.ok((await charter.readJournal()).some((event) => event.event === "recovered"));
	}));

test("the cycle budget stops endless repair loops until the developer grants more", () =>
	withHarness({ config: (c) => void (c.limits.cycles = 1) }, async (h) => {
		const id = await h.draft(1);
		await h.engine.approve(id);
		const reject = (request: RoleRunRequest): void => request.submit({ criteria: passAll(criteriaOf(request), "fail"), findings: [{ title: "still wrong", severity: "major", criterion: "AC1", detail: "d", evidence: "e" }] });
		h.runner.on("implementer", implement(h)).on("auditor", reject);
		await h.engine.advance(id);
		await h.engine.resolve(id, [{ ref: "F1", decision: "fix", text: "fix it" }]);

		const halted = await h.engine.advance(id);
		assert.match(halted.status === "halted" ? halted.reason : "", /budget of 1 cycle is spent[\s\S]*\/charter go/);
		assert.equal(h.runner.requests.length, 2, "no run is started over budget");

		// Declining in a dialog keeps it halted; accepting grants exactly one more cycle.
		assert.equal((await h.engine.advance(id, { confirmExtraCycle: async () => false })).status, "halted");
		h.runner.on("implementer", implement(h)).on("auditor", reject);
		const waiting = await h.engine.advance(id, { confirmExtraCycle: async () => true });
		assert.equal(waiting.status === "waiting" ? waiting.waitingFor : "", "triage");
		await h.engine.resolve(id, [{ ref: "audit-2/F1", decision: "fix", text: "again" }]);
		assert.equal((await h.engine.advance(id)).status, "halted");

		// The developer command grants it explicitly.
		assert.equal((await h.engine.grantCycle(id)).cycleGrant, 2);
		h.runner.on("implementer", implement(h)).on("auditor", auditClean);
		assert.equal((await h.engine.advance(id)).status, "done");
	}));

test("refinement is kept when it stays in scope and the checks still pass", () =>
	withHarness({ config: (c) => { c.roles.refiner.enabled = true; c.checks = [{ name: "syntax", run: node("require('fs').readFileSync('src/greet.js','utf8').includes('BROKEN') && process.exit(1)"), timeoutSeconds: 30 }]; } }, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h)).on("auditor", auditClean).on("refiner", (request) => {
			assert.match(request.prompt, /## Files in scope[\s\S]*src\/greet\.js/);
			assert.doesNotMatch(request.prompt, /README\.md/);
			h.project.write("src/greet.js", "export const greet = (name) => `Hello, ${name}`;\n");
			h.project.write("src/format.js", "export const format = (s) => s;\n");
			request.submit({ summary: "Renamed a parameter and extracted a formatter.", notes: [" kept API "] });
		});
		const result = await h.engine.advance(id);
		assert.equal(result.status, "done");
		const refine = await h.store.charter(id).readReport<RefineReport>("refine-1", "refine");
		assert.equal(refine.outcome, "kept");
		assert.deepEqual(refine.filesChanged, ["src/format.js", "src/greet.js"]);
		assert.match(h.project.read("src/greet.js"), /\(name\)/);
		assert.deepEqual(result.state.runs.map((run) => run.label), ["impl-1", "gate-1", "audit-1", "refine-1", "gate-2"]);
		assert.match(result.status === "done" ? result.report : "", /## Refinement[\s\S]*Renamed a parameter[\s\S]*not by a second audit/);
	}));

test("refinement is discarded when it leaves its scope, breaks a check, or fails midway", () =>
	withHarness({ config: (c) => { c.roles.refiner.enabled = true; c.roles.auditor.enabled = false; c.checks = [{ name: "syntax", run: node("require('fs').readFileSync('src/greet.js','utf8').includes('BROKEN') && process.exit(1)"), timeoutSeconds: 30 }]; } }, async (h) => {
		const accepted = "export const greet = (n) => `Hello, ${n}`;\n";

		// 1. Touches a file the implementation never changed.
		let id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h)).on("refiner", (request) => {
			h.project.write("README.md", "# improved readme\n");
			h.project.write("src/greet.js", "// tidied\n");
			request.submit({ summary: "tidied" });
		});
		let result = await h.engine.advance(id);
		assert.equal(result.status, "done");
		assert.equal(h.project.read("README.md"), "# project\n");
		assert.equal(h.project.read("src/greet.js"), accepted);
		let refine = await h.store.charter(id).readReport<RefineReport>("refine-1", "refine");
		assert.equal(refine.outcome, "reverted");
		assert.match(refine.revertReason ?? "", /outside the implementation's scope \(README\.md\)/);
		assert.match(result.status === "done" ? result.report : "", /refinement was discarded and the accepted code restored/);

		// 2. Breaks a check that passed on the accepted code.
		id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h, "src/greet.js", `${accepted}// v2\n`)).on("refiner", (request) => {
			h.project.write("src/greet.js", "BROKEN\n");
			request.submit({ summary: "simplified" });
		});
		result = await h.engine.advance(id);
		refine = await h.store.charter(id).readReport<RefineReport>("refine-1", "refine");
		assert.equal(refine.outcome, "reverted");
		assert.match(refine.revertReason ?? "", /broke the project check syntax/);
		assert.equal(h.project.read("src/greet.js"), `${accepted}// v2\n`);
		assert.equal(result.state.latest.gate, "gate-1", "the failed post-refinement gate does not replace the accepted one");

		// 3. Dies halfway: partial changes are undone, and the developer may skip the step.
		id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h, "src/greet.js", `${accepted}// v3\n`)).on("refiner", () => {
			h.project.write("src/greet.js", "half a refactoring\n");
			return { outcome: "failed", error: "context overflow" };
		});
		const halted = await h.engine.advance(id);
		assert.match(halted.status === "halted" ? halted.reason : "", /refine-1 failed: context overflow[\s\S]*partial changes were undone[\s\S]*\/charter skip/);
		assert.equal(h.project.read("src/greet.js"), `${accepted}// v3\n`);
		const skipped = await h.engine.skip(id, "not worth it");
		assert.equal(skipped.stage, "done");
		result = await h.engine.advance(id);
		assert.match(result.status === "done" ? result.report : "", /refine: skipped by the developer: not worth it/);
	}));

test("a refiner that changes nothing is recorded as such; without git the step is skipped", async () => {
	await withHarness({ config: (c) => { c.roles.refiner.enabled = true; c.roles.auditor.enabled = false; } }, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h)).on("refiner", (request) => request.submit({ summary: "Already clear." }));
		const result = await h.engine.advance(id);
		assert.equal((await h.store.charter(id).readReport<RefineReport>("refine-1", "refine")).outcome, "no-changes");
		assert.match(result.status === "done" ? result.report : "", /The refiner found nothing worth changing/);
	});
	await withHarness({ git: false, config: (c) => { c.roles.refiner.enabled = true; c.roles.auditor.enabled = false; } }, async (h) => {
		const id = await h.draft();
		const approved = await h.engine.approve(id);
		assert.equal(approved.baseline, null);
		h.runner.on("implementer", implement(h));
		const notices: string[] = [];
		const result = await h.engine.advance(id, { onNotice: (notice) => notices.push(notice) });
		assert.equal(result.status, "done");
		assert.doesNotMatch(h.runner.requests[0]?.prompt ?? "", /Files changed since approval/);
		assert.match(notices.join(), /Refinement skipped: no git checkpoint is available/);
		assert.match(result.status === "done" ? result.report : "", /refine: no git checkpoint is available/);
	});
});

test("specification-only mode ends at approval and says that nothing was built", () =>
	withHarness({ config: (c) => void (c.roles.implementer.enabled = false) }, async (h) => {
		const id = await h.draft();
		const approved = await h.engine.approve(id);
		assert.equal(approved.stage, "done");
		assert.equal(approved.baseline, null);
		const result = await h.engine.advance(id);
		assert.equal(result.status, "done");
		assert.match(result.status === "done" ? result.report : "", /specification approved; nothing was implemented[\s\S]*implementation: the implementer is disabled/);
		assert.equal(h.runner.requests.length, 0);
	}));

test("rollback restores the project to the baseline and reopens the charter", () =>
	withHarness({ config: (c) => void (c.roles.auditor.enabled = false) }, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h));
		await h.engine.advance(id);
		assert.ok(existsSync(join(h.project.root, "src/greet.js")));

		await assert.rejects(h.engine.rollback(id, "nope"), /No checkpoint "nope"\. Available: baseline, pre-impl-1/);
		const { state, restored } = await h.engine.rollback(id);
		assert.deepEqual(restored, ["src/greet.js"]);
		assert.equal(existsSync(join(h.project.root, "src/greet.js")), false);
		assert.equal(state.stage, "drafting");
		assert.ok(existsSync(h.store.charter(id).reportPath("impl-1")), "reports survive a rollback");
	}));

test("cancellation halts between steps, and a busy charter refuses a second driver", () =>
	withHarness({}, async (h) => {
		const id = await h.draft();
		await h.engine.approve(id);
		const controller = new AbortController();
		let second: Promise<unknown> | undefined;
		h.runner.on("implementer", (request) => {
			second = h.engine.advance(id).catch((error: unknown) => error);
			implement(h)(request);
			controller.abort();
		});
		const halted = await h.engine.advance(id, { signal: controller.signal });
		assert.match(halted.status === "halted" ? halted.reason : "", /Cancelled/);
		assert.equal(halted.state.stage, "audit", "finished work is kept");
		assert.match(String(await second), /busy with another step/);

		h.runner.on("auditor", auditClean);
		assert.equal((await h.engine.advance(id)).status, "done");
	}));

test("nothing is destroyed by an automatic restore: overwritten work is kept in a checkpoint", () =>
	withHarness({ config: (c) => { c.roles.refiner.enabled = true; } }, async (h) => {
		const id = await h.draft(1);
		await h.engine.approve(id);
		h.runner
			.on("implementer", implement(h))
			.on("auditor", (request) => {
				// Stands in for a developer who edits a file while the audit runs.
				h.project.write("notes.txt", "developer note written during the audit\n");
				auditClean(request);
			})
			.on("refiner", (request) => {
				h.project.write("README.md", "# out of scope\n");
				h.project.write("src/greet.js", "// refined\n");
				request.submit({ summary: "tidied" });
			});
		const result = await h.engine.advance(id);
		assert.equal(result.status, "done");
		const labels = result.state.checkpoints.map((checkpoint) => checkpoint.label);
		assert.deepEqual(labels, ["baseline", "pre-impl-1", "after-audit-1", "pre-refine-1", "discarded-refine-1"]);

		// The audit restore removed the file, but its content is recoverable.
		assert.equal(existsSync(join(h.project.root, "notes.txt")), false);
		assert.equal(h.project.git("show", `refs/charter/${id}/after-audit-1:notes.txt`), "developer note written during the audit\n");
		assert.match(result.state.notes.join("\n"), /kept in checkpoint after-audit-1/);
		// So is the discarded refinement, with the command to look at it.
		assert.equal(h.project.git("show", `refs/charter/${id}/discarded-refine-1:src/greet.js`), "// refined\n");
		assert.match(result.status === "done" ? result.report : "", /inspect it with `git diff [0-9a-f]{12} [0-9a-f]{12}`/);

		// A rollback can itself be undone.
		const { state } = await h.engine.rollback(id);
		assert.equal(existsSync(join(h.project.root, "src/greet.js")), false);
		assert.equal(state.checkpoints.at(-1)?.label, "before-rollback-1");
		await h.engine.rollback(id, "before-rollback-1");
		assert.match(h.project.read("src/greet.js"), /Hello, /);
		assert.equal((await h.store.charter(id).load()).checkpoints.at(-1)?.label, "before-rollback-2");

		// Checkpoints of a finished charter can be deleted; an unfinished one keeps them.
		await assert.rejects(h.engine.prune(id), /is not finished \(stage "drafting"\)/);
		const other = await h.draft(1);
		h.config.roles.implementer.enabled = false;
		await h.engine.approve(other);
		assert.equal(await h.engine.prune(other), 0);
		assert.match(h.project.git("for-each-ref", "refs/charter/"), new RegExp(`refs/charter/${id}/baseline`));
	}));

test("pruning removes exactly one charter's checkpoint refs, and a repository created later is picked up", async () => {
	await withHarness({ config: (c) => void (c.roles.auditor.enabled = false) }, async (h) => {
		const first = await h.draft(1);
		const second = await h.draft(1);
		for (const id of [first, second]) {
			await h.engine.approve(id);
			h.runner.on("implementer", implement(h, `src/${id}.js`, "x\n"));
			assert.equal((await h.engine.advance(id)).status, "done");
		}
		assert.equal(await h.engine.prune(first), 2);
		const refs = h.project.git("for-each-ref", "--format=%(refname)", "refs/charter/");
		assert.doesNotMatch(refs, new RegExp(first));
		assert.match(refs, new RegExp(`refs/charter/${second}/baseline`));
		assert.deepEqual((await h.store.charter(first).load()).checkpoints, []);
		await assert.rejects(h.engine.rollback(first), /No checkpoint "baseline"\. Available: none/);
	});

	const project = tempProject({ git: false });
	try {
		const config = cloneConfig(DEFAULT_CONFIG);
		const engine = new Engine({ projectRoot: project.root, config, store: new CharterStore(project.root, config.directory), runner: new ScriptedRunner() });
		assert.equal(await engine.git(), undefined);
		project.git("init", "-q", "-b", "main");
		assert.ok(await engine.git(), "git init after the first look is noticed");
	} finally {
		project.cleanup();
	}
});

test("a renewed approval starts with a clean slate of skips, notes and latest reports", () =>
	withHarness({ config: (c) => { c.roles.refiner.enabled = true; c.roles.auditor.enabled = false; } }, async (h) => {
		const id = await h.draft(1);
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h)).on("refiner", (request) => {
			h.project.write("README.md", "# out of scope\n");
			request.submit({ summary: "tidied" });
		});
		const first = await h.engine.advance(id);
		assert.equal(first.state.latest.refine, "refine-1");
		assert.equal(first.state.notes.length, 1);

		await h.engine.reopen(id);
		const approved = await h.engine.approve(id);
		assert.deepEqual(approved.latest, {});
		assert.deepEqual(approved.notes, []);
		assert.deepEqual(approved.skipped, []);
		assert.equal(approved.baseline, first.state.baseline, "the baseline stays at the first approval");

		h.runner.on("implementer", implement(h, "src/greet.js", "v2\n")).on("refiner", (request) => request.submit({ summary: "Nothing to do." }));
		const second = await h.engine.advance(id);
		const report = second.status === "done" ? second.report : "";
		assert.match(report, /approved revision 2, 1 implementation cycle\)/);
		assert.match(report, /The refiner found nothing worth changing/);
		assert.doesNotMatch(report, /discarded/);
	}));

test("a retried step keeps its original 'before' checkpoint and tells the agent about the partial work", () =>
	withHarness({ config: (c) => void (c.roles.auditor.enabled = false) }, async (h) => {
		const id = await h.draft(1);
		await h.engine.approve(id);
		h.runner.on("implementer", () => {
			h.project.write("src/half.js", "partial work of the failed attempt\n");
			return { outcome: "failed", error: "connection reset" };
		});
		const halted = await h.engine.advance(id);
		assert.equal(halted.status, "halted");
		const before = halted.state.checkpoints.find((checkpoint) => checkpoint.label === "pre-impl-1")?.commit;

		h.runner.on("implementer", implement(h));
		const result = await h.engine.advance(id);
		assert.equal(result.status, "done");
		assert.equal(result.state.checkpoints.find((checkpoint) => checkpoint.label === "pre-impl-1")?.commit, before);
		assert.equal(h.project.git("ls-tree", "-r", "--name-only", `refs/charter/${id}/pre-impl-1`).includes("src/half.js"), false, "the checkpoint still shows the state before the first attempt");
		assert.match(h.runner.requests[1]?.prompt ?? "", /## Files changed since approval[\s\S]*A src\/half\.js/);
	}));

test("a partly failed audit keeps its finished auditors and re-runs only the rest, if the project is unchanged", () =>
	withHarness({ config: (c) => void (c.roles.auditor.shards = 2) }, async (h) => {
		const failsOn = (id: string) => (request: RoleRunRequest) => {
			if (criteriaOf(request).includes(id)) return { outcome: "failed" as const, error: "rate limited" };
			auditClean(request);
			return undefined;
		};

		// Attempt 1: the auditor holding AC3 fails; its peer is allowed to finish.
		const id = await h.draft(4);
		await h.engine.approve(id);
		h.runner.on("implementer", implement(h)).on("auditor", failsOn("AC3"), failsOn("AC3"));
		const halted = await h.engine.advance(id);
		assert.match(halted.status === "halted" ? halted.reason : "", /audit-1#2 failed: rate limited[\s\S]*The 1 auditor\(s\) that finished are kept; advancing again re-runs only the rest\./);
		assert.ok(existsSync(h.store.charter(id).partialAuditPath("audit-1")));

		// Attempt 2: one auditor, for the missing half only.
		h.runner.on("auditor", auditClean);
		const notices: string[] = [];
		const result = await h.engine.advance(id, { onNotice: (notice) => notices.push(notice) });
		assert.equal(result.status, "done");
		assert.match(notices.join(), /Reusing the result of audit-1#1 from the previous attempt/);
		const auditors = h.runner.requests.filter((request) => request.role === "auditor");
		assert.equal(auditors.length, 3);
		assert.deepEqual(criteriaOf(auditors[2] as RoleRunRequest), ["AC3", "AC4"]);
		const report = await h.store.charter(id).readReport<AuditReport>("audit-1", "audit");
		assert.deepEqual(report.criteria.map((outcome) => outcome.id), ["AC1", "AC2", "AC3", "AC4"]);
		assert.equal(report.shards, 2);
		assert.equal(existsSync(h.store.charter(id).partialAuditPath("audit-1")), false, "the leftover is removed once the audit is complete");

		// A changed project invalidates what the finished auditor saw: everything is audited again.
		const other = await h.draft(4);
		await h.engine.approve(other);
		h.runner.on("implementer", implement(h, "src/other.js", "v1\n")).on("auditor", failsOn("AC1"), failsOn("AC1"));
		assert.equal((await h.engine.advance(other)).status, "halted");
		h.project.write("src/other.js", "edited between the attempts\n");
		h.runner.on("auditor", auditClean, auditClean);
		assert.equal((await h.engine.advance(other)).status, "done");
		assert.equal(h.runner.requests.filter((request) => request.role === "auditor").length, 7);
	}));
