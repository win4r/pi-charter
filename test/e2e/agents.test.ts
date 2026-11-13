import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { AuditReport } from "../../src/core/reports.ts";
import type { CharterState } from "../../src/core/state.ts";
import { PiRoleRunner } from "../../src/pi/child.ts";
import { BRIEF, specWith } from "../support/fixtures.ts";
import { briefOf, call, declaredTools, piHarness, type PiHarness, say, transcript } from "../support/pi.ts";

const ID = "001-greeting";
const criteria = (text: string): string[] => [...(text.split("\n").findLast((line) => line.includes("result and evidence for each of:")) ?? "").matchAll(/AC\d+/g)].map((match) => match[0]);
const passing = (ids: string[], result = "pass") => ids.map((id) => ({ id, result, evidence: `verified ${id}` }));
const readState = (h: PiHarness): CharterState => JSON.parse(readFileSync(join(h.charterDir(ID), "charter.json"), "utf8")) as CharterState;
const implDone = (context: { messages: Parameters<typeof briefOf>[0] }) => call("charter_report", { status: "done", summary: "implemented", criteria: passing(criteria(briefOf(context.messages))) });
const auditClean = (context: { messages: Parameters<typeof briefOf>[0] }) => call("charter_report", { criteria: passing(criteria(briefOf(context.messages))) });

/** A drafted, lint-clean charter that is active in the session. */
async function drafted(h: PiHarness, acceptanceCriteria = 2): Promise<void> {
	await h.prompt("/charter new Greeting");
	h.project.write(`.charter/${ID}/brief.md`, BRIEF);
	h.project.write(`.charter/${ID}/spec.md`, specWith(acceptanceCriteria));
}

test("an agent that stops without reporting is reminded; a rejected report can be corrected", async () => {
	const h = await piHarness();
	try {
		await drafted(h);
		h.script("main", call("charter_approve"), say("done"));
		h.script(
			"impl",
			say("I have implemented everything, all good!"),
			call("charter_report", { status: "done", summary: "implemented", criteria: [{ id: "AC1", result: "pass", evidence: "ran it" }] }),
			implDone,
		);
		h.script("audit", auditClean);
		await h.prompt("approve");

		assert.equal(readState(h).stage, "done");
		const impl = h.seen.impl ?? [];
		assert.equal(impl.length, 3);
		assert.match(transcript(impl[1] ?? []), /You stopped without calling `charter_report`/);
		assert.match(transcript(impl[2] ?? []), /Report rejected\. Fix these and call charter_report again:[\s\S]*missing a result for AC2/);
		assert.deepEqual(readState(h).runs.map((run) => run.outcome), ["reported", "reported"]);
	} finally {
		await h.dispose();
	}
});

test("a failing agent halts the pipeline with its reason, and advancing retries it", async () => {
	const h = await piHarness({ config: { roles: { auditor: { enabled: false } } } });
	try {
		await drafted(h);
		h.script("main", call("charter_approve"), say("The implementer failed; shall I retry?"), call("charter_advance"), say("done"));
		h.script("impl", fauxAssistantMessage("", { stopReason: "error", errorMessage: "authentication_error: invalid x-api-key" }), implDone);
		await h.prompt("approve");

		const halted = h.session.messages.findLast((message) => message.role === "toolResult");
		assert.equal(halted?.role === "toolResult" && halted.isError, true);
		assert.match(h.toolResults().at(-1) ?? "", /The pipeline stopped: impl-1 failed: authentication_error: invalid x-api-key[\s\S]*stays at "implement"/);
		assert.equal(readState(h).stage, "implement");
		assert.equal(h.ui.status.get("charter"), `charter ${ID} · ready to implement`);

		await h.prompt("yes, retry");
		assert.equal(readState(h).stage, "done");
		assert.deepEqual(readState(h).runs.map((run) => `${run.label}:${run.outcome}`), ["impl-1:failed", "impl-1:reported"]);
		assert.match(h.toolResults().at(-1) ?? "", /No independent audit ran/);
	} finally {
		await h.dispose();
	}
});

test("findings are triaged by the developer through the tool, and the pipeline resumes in the same call", async () => {
	const h = await piHarness({ config: { roles: { auditor: { shards: 2 } } } });
	try {
		await drafted(h, 4);
		h.script("main", call("charter_approve"), say("The auditor found a problem with AC3. Fix, waive or revise?"));
		h.script("impl", implDone, implDone);
		// Two auditors run concurrently in the first audit; the one holding AC3 objects.
		const firstAudit = (context: { messages: Parameters<typeof briefOf>[0] }) => {
			const ids = criteria(briefOf(context.messages));
			if (!ids.includes("AC3")) return call("charter_report", { criteria: passing(ids) });
			return call("charter_report", {
				criteria: ids.map((id) => ({ id, result: id === "AC3" ? "fail" : "pass", evidence: id === "AC3" ? "returned Hello 1, Ada" : "ok" })),
				findings: [{ title: "Greeting 3 is wrong", severity: "critical", criterion: "AC3", detail: "Returns the first greeting.", evidence: "node -e \"...\" printed Hello 1, Ada" }],
			});
		};
		h.script("audit", firstAudit, firstAudit);
		await h.prompt("approve");

		assert.equal(readState(h).stage, "triage");
		const waiting = h.toolResults().at(-1) ?? "";
		assert.match(waiting, /findings that need the developer's decision[\s\S]*audit-1\/F1 \[critical, AC3\]: Greeting 3 is wrong[\s\S]*call charter_resolve/);
		const auditors = (h.seen.audit ?? []).map((request) => criteria(briefOf(request))).sort();
		assert.deepEqual(auditors, [["AC1", "AC2"], ["AC3", "AC4"]]);
		assert.match(briefOf(h.seen.audit?.[0] ?? []), /You are auditor \d of 2 working in parallel/);
		const audit = JSON.parse(readFileSync(join(h.charterDir(ID), "reports/audit-1.json"), "utf8")) as AuditReport;
		assert.equal(audit.shards, 2);

		h.script("main", call("charter_resolve", { decisions: [{ ref: "audit-1/F1", decision: "fix", text: "It must return greeting 3." }] }), say("Fixed and re-audited."));
		h.fallback("audit", auditClean);
		await h.prompt("fix it");

		const confirm = h.ui.dialogs.findLast((dialog) => dialog.kind === "confirm");
		assert.equal(confirm?.title, `Record these decisions for ${ID}?`);
		assert.match(confirm?.message ?? "", /audit-1\/F1: fix — It must return greeting 3\./);
		assert.equal(readState(h).stage, "done");
		assert.match(briefOf(h.seen.impl?.[1] ?? []), /## What to fix in this run[\s\S]*audit-1\/F1 \(critical, AC3\): Greeting 3 is wrong[\s\S]*Developer: It must return greeting 3\./);
		assert.match(h.toolResults().at(-1) ?? "", /Decisions recorded\.[\s\S]*is complete[\s\S]*audit-1\/F1 \| critical \| Greeting 3 is wrong \| fix/);
		assert.equal(readState(h).cycle, 2);
	} finally {
		await h.dispose();
	}
});

test("decisions the developer does not confirm are not recorded", async () => {
	const h = await piHarness();
	try {
		await drafted(h, 1);
		h.script("main", call("charter_approve"), say("Question for you."), call("charter_resolve", { decisions: [{ ref: "impl-1/Q1", decision: "answer", text: "Use UTC." }] }), say("ok"));
		h.script("impl", (context) =>
			call("charter_report", { status: "blocked", summary: "blocked", criteria: passing(criteria(briefOf(context.messages)), "untested"), questions: [{ title: "Which time zone?", detail: "The spec is silent.", options: [{ label: "UTC", consequence: "stable" }] }] }),
		);
		await h.prompt("approve");
		assert.equal(readState(h).stage, "questions");
		assert.match(h.toolResults().at(-1) ?? "", /impl-1\/Q1: Which time zone\?[\s\S]*do not answer on their behalf/);

		h.ui.confirms.push(false);
		await h.prompt("hm");
		assert.match(h.toolResults().at(-1) ?? "", /did not confirm these decisions[\s\S]*nothing was recorded/);
		assert.equal(readState(h).stage, "questions");
	} finally {
		await h.dispose();
	}
});

test("without a dialog, decisions are refused from the model and recorded by the developer's command", async () => {
	const h = await piHarness({ ui: false });
	try {
		await drafted(h, 1);
		h.script("main", call("charter_advance"), say("The auditor has a finding."));
		h.script("impl", implDone, implDone);
		h.script("audit", (context) =>
			call("charter_report", { criteria: passing(criteria(briefOf(context.messages)), "fail"), findings: [{ title: "wrong", severity: "major", criterion: "AC1", detail: "d", evidence: "e" }] }),
		);
		await h.prompt("/charter approve");
		assert.equal(readState(h).stage, "triage");

		h.script("main", call("charter_resolve", { decisions: [{ ref: "audit-1/F1", decision: "waive", text: "The developer surely does not mind." }] }), say("Please decide yourself."));
		await h.prompt("just waive it for me");
		assert.match(h.toolResults().at(-1) ?? "", /Decisions have to come from the developer[\s\S]*\/charter decide audit-1\/F1 waive/);
		assert.equal(readState(h).stage, "triage", "nothing was recorded");

		h.script("main", call("charter_advance"), say("done"));
		h.fallback("audit", auditClean);
		await h.prompt("/charter decide audit-1/F1 fix It has to pass.");
		assert.equal(readState(h).stage, "done");
		assert.match(briefOf(h.seen.impl?.[1] ?? []), /Developer: It has to pass\./);

		await h.prompt("/charter decide F1 fix again");
		assert.match(transcript(h.session.messages as never), /Nothing is waiting for a decision/);
	} finally {
		await h.dispose();
	}
});

test("project checks run for real between agents, and a failure is repaired without an audit", async () => {
	const check = `node -e "if (!require('fs').existsSync('ok.txt')) { console.error('ok.txt missing'); process.exit(1) }"`;
	const h = await piHarness({ config: { checks: [{ name: "marker", run: check }] } });
	try {
		await drafted(h, 1);
		h.script("main", call("charter_approve"), say("done"));
		h.script("impl", implDone, call("write", { path: "ok.txt", content: "ok\n" }), implDone);
		h.script("audit", auditClean);
		await h.prompt("approve");
		const state = readState(h);
		assert.equal(state.stage, "done");
		assert.deepEqual(state.runs.map((run) => `${run.label}:${run.outcome}`), ["impl-1:reported", "gate-1:check-failed", "impl-2:reported", "gate-2:passed", "audit-1:reported"]);
		assert.match(briefOf(h.seen.impl?.[1] ?? []), /Check "marker"[\s\S]*ok\.txt missing/);
		assert.equal(h.seen.audit?.length, 1, "no audit tokens were spent on code that fails its checks");
		assert.match(h.toolResults().at(-1) ?? "", /Note: Checks failed \(marker\); sending them back to the implementer/);
	} finally {
		await h.dispose();
	}
});

test("roles without a model inherit the session model; mode and active charter survive a resumed session", async () => {
	const sessionDir = join(process.env.TMPDIR ?? "/tmp", `pi-charter-sessions-${process.pid}-${Date.now()}`);
	const first = await piHarness({ config: { roles: { implementer: { model: null }, auditor: { enabled: false } } }, ui: false });
	const sessionManager = SessionManager.create(first.project.root, sessionDir);
	first.session.dispose();
	const h = await piHarness({ project: first.project, sessionManager });
	try {
		await drafted(h, 1);
		// Main session and inheriting implementer share the "main" script, in call order.
		h.script("main", call("charter_approve"), implDone, say("done"));
		await h.prompt("approve");
		const state = readState(h);
		assert.equal(state.stage, "done");
		assert.equal(state.runs[0]?.model, "faux/main");
		assert.ok(state.runs[0]?.transcript?.includes("charter-agents"), "child transcripts are saved next to the main session");
		assert.ok(existsSync(state.runs[0]?.transcript ?? ""));
		assert.equal(h.seen.impl, undefined);

		// A new runtime over the same session file: no /charter needed, the tools are back.
		const sessionFile = sessionManager.getSessionFile();
		assert.ok(sessionFile);
		h.session.dispose();
		const resumed = await piHarness({ project: h.project, sessionManager: SessionManager.open(sessionFile) });
		resumed.script("main", call("charter_status"), say("ok"));
		await resumed.prompt("where are we?");
		assert.ok(declaredTools(resumed.seen.main?.[0] ?? []).includes("charter_status"));
		assert.match(resumed.toolResults().at(-1) ?? "", /Charter 001-greeting: Greeting[\s\S]*Stage: done[\s\S]*Last run: impl-1 -> reported/);
		assert.equal(resumed.ui.status.get("charter"), `charter ${ID} · done`);
		resumed.session.dispose();
	} finally {
		await h.dispose();
	}
});

test("the role runner enforces time limits and cancellation on a live session", async () => {
	const h = await piHarness();
	try {
		const host = { agentDir: h.agentDir, modelRuntime: h.modelRuntime, sessionModel: () => undefined, sessionDir: () => undefined, rolePrompt: async () => "# Role: implementer" };
		const runner = new PiRoleRunner(host);
		const base = { role: "implementer" as const, cwd: h.project.root, prompt: "work", thinking: "off" as const, nudges: 1, protectedPaths: [], submit: () => undefined };
		/** A provider call that takes 20 s unless its request is aborted. */
		const slow = (_context: unknown, options: { signal?: AbortSignal }): Promise<ReturnType<typeof say>> =>
			new Promise((resolve) => {
				const timer = setTimeout(() => resolve(say("too late")), 20_000);
				options.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
				});
			});
		/** A provider that ignores cancellation entirely. */
		const deaf = async (): Promise<ReturnType<typeof say>> => {
			await new Promise((resolve) => setTimeout(resolve, 8000).unref());
			return say("too late");
		};

		h.script("impl", slow);
		let started = Date.now();
		const timedOut = await runner.run({ ...base, label: "impl-1", model: "faux/impl", timeoutMs: 300 });
		assert.equal(timedOut.outcome, "timeout");
		assert.ok(Date.now() - started < 10_000, "the run is stopped, not awaited");

		h.script("impl", slow);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		assert.equal((await runner.run({ ...base, label: "impl-1", model: "faux/impl", timeoutMs: 0, signal: controller.signal })).outcome, "aborted");

		// Even a provider that never honours the abort cannot hold the pipeline beyond the grace period.
		h.script("impl", deaf);
		started = Date.now();
		const abandoned = await new PiRoleRunner({ ...host, abortGraceMs: 200 }).run({ ...base, label: "impl-1", model: "faux/impl", timeoutMs: 200 });
		assert.equal(abandoned.outcome, "timeout");
		assert.ok(Date.now() - started < 6000, `abandoned after the grace period (took ${Date.now() - started} ms)`);

		const unknown = await runner.run({ ...base, label: "impl-1", model: "faux/does-not-exist", timeoutMs: 0 });
		assert.equal(unknown.outcome, "failed");
		assert.match(unknown.error ?? "", /model "faux\/does-not-exist" is not available/);
		const none = await runner.run({ ...base, label: "impl-1", model: null, timeoutMs: 0 });
		assert.match(none.error ?? "", /no model is configured for the implementer/);

		h.script("impl", say("no report"), say("still no report"));
		const silent = await runner.run({ ...base, label: "impl-1", model: "faux/impl", timeoutMs: 0 });
		assert.equal(silent.outcome, "no-report");
		assert.ok(silent.usage.output > 0);
	} finally {
		await h.dispose();
	}
});
