import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { CharterState } from "../../src/core/state.ts";
import { BRIEF, specWith } from "../support/fixtures.ts";
import { briefOf, call, calls, declaredTools, piHarness, say, transcript } from "../support/pi.ts";

const ID = "001-greeting";
const criteria = (text: string): string[] => [...(text.split("\n").findLast((line) => line.includes("result and evidence for each of:")) ?? "").matchAll(/AC\d+/g)].map((match) => match[0]);
const passing = (ids: string[]) => ids.map((id) => ({ id, result: "pass", evidence: `verified ${id} by running it` }));
const readState = (dir: string): CharterState => JSON.parse(readFileSync(join(dir, "charter.json"), "utf8")) as CharterState;

test("a whole charter runs through real Pi sessions: draft, approve, implement, audit, report", async () => {
	const h = await piHarness();
	try {
		// Before the mode is on, the model is not offered any charter tool.
		h.script("main", say("hello"));
		await h.prompt("hi");
		assert.equal(declaredTools(h.seen.main?.[0] ?? []).some((name) => name.startsWith("charter_")), false);

		await h.prompt("/charter");
		assert.match(h.ui.notifications.at(-1)?.message ?? "", /Charter mode on\.[\s\S]*implementer \(faux\/impl[\s\S]*auditor \(faux\/audit/);
		assert.equal(h.ui.status.get("charter"), "charter · no active charter");

		h.script(
			"main",
			call("charter_new", { title: "Greeting" }),
			calls(["write", { path: `.charter/${ID}/brief.md`, content: BRIEF }], ["write", { path: `.charter/${ID}/spec.md`, content: specWith(2) }]),
			call("charter_lint"),
			call("charter_approve"),
			say("All done: the greeting is implemented and audited."),
		);
		h.script(
			"impl",
			call("write", { path: "src/greet.js", content: "export const greet = (name) => `Hello, ${name}`;\n" }),
			(context) => call("charter_report", { status: "done", summary: "Added greet().", criteria: passing(criteria(briefOf(context.messages))), filesChanged: ["src/greet.js"] }),
		);
		h.script("audit", (context) => call("charter_report", { criteria: passing(criteria(briefOf(context.messages))) }));

		await h.prompt("Add a greet function.");

		// The developer was asked, in a dialog, with the facts of what they approve.
		const approval = h.ui.dialogs.find((dialog) => dialog.kind === "confirm");
		assert.equal(approval?.title, `Approve charter ${ID}?`);
		assert.match(approval?.message ?? "", /2 requirement\(s\), 2 acceptance criteria[\s\S]*Lint: clean[\s\S]*implementer \(faux\/impl.*-> auditor \(faux\/audit/);

		const state = readState(h.charterDir(ID));
		assert.equal(state.stage, "done");
		assert.deepEqual(state.runs.map((run) => `${run.label}:${run.outcome}:${run.model}`), ["impl-1:reported:faux/impl", "audit-1:reported:faux/audit"]);
		assert.ok(state.usage.output > 0, "agent token usage is accounted");
		assert.match(h.project.read("src/greet.js"), /Hello, /);

		const results = h.toolResults();
		assert.match(results[0] ?? "", /Created charter 001-greeting/);
		assert.match(results[3] ?? "", /0 error\(s\), 0 warning\(s\); 2 requirement\(s\), 2 acceptance criteria/);
		const final = results.at(-1) ?? "";
		assert.match(final, /The developer approved charter 001-greeting \(revision 1\)[\s\S]*is complete[\s\S]*\| AC1 \| pass \| pass \| verified AC1 by running it \|/);
		assert.equal(readFileSync(join(h.charterDir(ID), "report.md"), "utf8").trim(), final.slice(final.indexOf("# Charter"), final.lastIndexOf("\n\nPresent this report")).trim());
		assert.equal(h.session.getLastAssistantText(), "All done: the greeting is implemented and audited.");
		assert.equal(h.ui.status.get("charter"), `charter ${ID} · done`);

		// What the coordinating model saw: the long instructions exactly once, and a small state
		// section that is patched at the start of the next run.
		h.script("main", say("You're welcome."));
		await h.prompt("thanks");
		const lastRequest = h.seen.main?.at(-1) ?? [];
		const sectionUpdates = lastRequest.flatMap((message) => Object.keys((message as { sections?: Record<string, unknown> }).sections ?? {}));
		assert.equal(sectionUpdates.filter((name) => name === "charter").length, 1, "the instructions are sent once and stay cached");
		assert.equal(sectionUpdates.filter((name) => name === "charter_state").length, 2);
		assert.match(transcript(lastRequest), /# Charter mode/);
		assert.match(transcript(lastRequest), /Active charter: 001-greeting[\s\S]{0,160}Stage: done/);
		assert.ok(declaredTools(lastRequest).includes("charter_approve"));

		// What the agents saw: their role, the approved documents inline, their report tool, and none of the coordinator's tools.
		const implRequest = h.seen.impl?.[0] ?? [];
		assert.match(transcript(implRequest), /# Role: implementer/);
		assert.match(briefOf(implRequest), /# Implement charter 001-greeting \(cycle 1\)[\s\S]*<document name=\\?"spec\.md\\?">/);
		assert.deepEqual(declaredTools(implRequest).filter((name) => name.startsWith("charter_")), ["charter_report"]);
		assert.equal(h.seen.impl?.length, 2, "the report ends the run: no closing model call");
		const auditRequest = h.seen.audit?.[0] ?? [];
		assert.match(transcript(auditRequest), /# Role: auditor/);
		assert.match(briefOf(auditRequest), /A src\/greet\.js/);
		assert.equal(h.seen.audit?.length, 1);
	} finally {
		await h.dispose();
	}
});

test("guards: frozen documents, workflow files, and read-only auditors", async () => {
	const h = await piHarness();
	try {
		await h.prompt("/charter");
		h.script(
			"main",
			call("charter_new", { title: "Greeting" }),
			calls(["write", { path: `.charter/${ID}/brief.md`, content: BRIEF }], ["write", { path: `.charter/${ID}/spec.md`, content: specWith(1) }]),
			// The model may not touch workflow files even while drafting.
			call("write", { path: `.charter/${ID}/charter.json`, content: "{}" }),
			call("charter_approve"),
			// After approval the documents are frozen for the model.
			call("edit", { path: `.charter/${ID}/spec.md`, edits: [{ oldText: "greeting 1", newText: "anything" }] }),
			say("done"),
		);
		h.script(
			"impl",
			calls(["write", { path: `.charter/${ID}/spec.md`, content: "# easier spec\n" }], ["write", { path: "src/greet.js", content: "ok\n" }]),
			(context) => call("charter_report", { status: "done", summary: "s", criteria: passing(criteria(briefOf(context.messages))) }),
		);
		h.script(
			"audit",
			(context) => {
				const scratch = /Scratch directory for throwaway scripts and fixtures: (\S+)/.exec(briefOf(context.messages))?.[1] ?? "";
				return calls(["write", { path: "src/greet.js", content: "auditor rewrite\n" }], ["write", { path: join(scratch, "probe.js"), content: "console.log(1)\n" }]);
			},
			(context) => call("charter_report", { criteria: passing(criteria(briefOf(context.messages))) }),
		);
		await h.prompt("go");

		const results = h.toolResults().join("\n---\n");
		assert.match(results, /charter\.json is maintained by the Charter pipeline and must not be edited/);
		assert.match(results, /was approved and its documents are frozen \(stage "done"\)/);
		assert.equal(readState(h.charterDir(ID)).stage, "done");
		assert.equal(h.project.read(`.charter/${ID}/spec.md`), specWith(1));
		assert.equal(h.project.read("src/greet.js"), "ok\n");

		const implSecond = transcript(h.seen.impl?.[1] ?? []);
		assert.match(implSecond, /Charter documents, reports and state are frozen/);
		const auditSecond = transcript(h.seen.audit?.[1] ?? []);
		assert.match(auditSecond, /This role is read-only for project files/);
		assert.match(auditSecond, /Successfully wrote|probe\.js/);
	} finally {
		await h.dispose();
	}
});

test("approval belongs to the developer: a declined dialog changes nothing, and without a UI only the command approves", async () => {
	const h = await piHarness();
	try {
		await h.prompt("/charter new Greeting");
		assert.ok(existsSync(join(h.charterDir(ID), "spec.md")));
		h.project.write(`.charter/${ID}/brief.md`, BRIEF);
		h.project.write(`.charter/${ID}/spec.md`, specWith(1));

		h.ui.confirms.push(false);
		h.script("main", call("charter_approve"), say("ok, what should change?"));
		await h.prompt("approve it");
		assert.match(h.toolResults().at(-1) ?? "", /The developer did not approve/);
		assert.equal(readState(h.charterDir(ID)).stage, "drafting");
		assert.equal(h.seen.impl, undefined);
	} finally {
		await h.dispose();
	}

	const headless = await piHarness({ ui: false });
	try {
		await headless.prompt("/charter new Greeting");
		headless.project.write(`.charter/${ID}/brief.md`, BRIEF);
		headless.project.write(`.charter/${ID}/spec.md`, specWith(1));
		headless.script("main", call("charter_approve"), say("Please run /charter approve."));
		await headless.prompt("approve it");
		assert.match(headless.toolResults().at(-1) ?? "", /Approval has to come from the developer[\s\S]*\/charter approve 001-greeting/);
		assert.equal(readState(headless.charterDir(ID)).stage, "drafting");

		// The developer types the command; the model is then told to advance.
		headless.script("main", call("charter_advance"), say("finished"));
		headless.script("impl", (context) => call("charter_report", { status: "done", summary: "s", criteria: passing(criteria(briefOf(context.messages))) }));
		headless.script("audit", (context) => call("charter_report", { criteria: passing(criteria(briefOf(context.messages))) }));
		await headless.prompt("/charter approve");
		assert.equal(readState(headless.charterDir(ID)).stage, "done");
		assert.match(transcript(headless.seen.main?.at(-1) ?? []), /I approved charter 001-greeting \(revision 1\)\. Call charter_advance/);
	} finally {
		await headless.dispose();
	}
});
