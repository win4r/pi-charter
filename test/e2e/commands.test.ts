import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { CharterState } from "../../src/core/state.ts";
import { BRIEF, specWith } from "../support/fixtures.ts";
import { briefOf, call, declaredTools, piHarness, type PiHarness, say } from "../support/pi.ts";

const ID = "001-greeting";
const criteria = (text: string): string[] => [...(text.split("\n").findLast((line) => line.includes("result and evidence for each of:")) ?? "").matchAll(/AC\d+/g)].map((match) => match[0]);
const passing = (ids: string[]) => ids.map((id) => ({ id, result: "pass", evidence: `verified ${id}` }));
const readState = (h: PiHarness, id = ID): CharterState => JSON.parse(readFileSync(join(h.charterDir(id), "charter.json"), "utf8")) as CharterState;

/** Text of the custom messages the command wrote into the transcript. */
const shown = (h: PiHarness): string[] =>
	h.session.messages.flatMap((message) => {
		const custom = message as { role: string; customType?: string; content?: unknown };
		return custom.role === "custom" && custom.customType === "charter" ? [String(custom.content)] : [];
	});
const lastError = (h: PiHarness): string => h.ui.notifications.findLast((entry) => entry.type === "error")?.message ?? "";

test("/charter: help, status without a charter, list, lint, log, off", async () => {
	const h = await piHarness();
	try {
		await h.prompt("/charter help");
		assert.match(shown(h).at(-1) ?? "", /\/charter approve \[id\][\s\S]*\/charter rollback/);
		await h.prompt("/charter bogus");
		assert.match(lastError(h), /Unknown subcommand "bogus"/);
		await h.prompt("/charter status");
		assert.match(lastError(h), /No charter is active/);
		await h.prompt("/charter list");
		assert.equal(shown(h).at(-1), "No charters yet.");
		await h.prompt("/charter resume");
		assert.match(lastError(h), /There are no charters yet/);

		await h.prompt("/charter new Greeting");
		await h.prompt("/charter new Second thing");
		await h.prompt("/charter list");
		assert.match(shown(h).at(-1) ?? "", /  001-greeting  drafting   Greeting\n\* 002-second-thing  drafting   Second thing/);
		await h.prompt("/charter lint");
		assert.match(shown(h).at(-1) ?? "", /error\(s\)[\s\S]*unresolved-placeholder/);
		await h.prompt("/charter approve");
		assert.match(shown(h).at(-1) ?? "", /Charter 002-second-thing cannot be approved yet/);

		// Resume by number shorthand, by picker, and reject ambiguity.
		await h.prompt("/charter resume 1");
		assert.match(shown(h).at(-1) ?? "", /Charter 001-greeting: Greeting[\s\S]*Stage: drafting[\s\S]*Next: Draft brief\.md/);
		h.ui.selects.push("002-second-thing — drafting — Second thing");
		await h.prompt("/charter resume");
		assert.equal(h.ui.status.get("charter"), "charter 002-second-thing · drafting");
		await h.prompt("/charter resume 00");
		assert.match(lastError(h), /matches several charters/);
		await h.prompt("/charter resume second");
		assert.equal(h.ui.status.get("charter"), "charter 002-second-thing · drafting");
		await h.prompt("/charter resume 7");
		assert.match(lastError(h), /No charter matches "7"/);

		await h.prompt("/charter log 5");
		assert.match(shown(h).at(-1) ?? "", /created  \{"title":"Second thing"\}/);
		await h.prompt("/charter report");
		assert.match(lastError(h), /is not finished \(stage "drafting"\)/);

		h.script("main", say("ready"), say("hi"));
		await h.prompt("where were we?");
		assert.ok(declaredTools(h.seen.main?.at(-1) ?? []).includes("charter_new"));

		await h.prompt("/charter off");
		assert.equal(h.ui.status.get("charter"), undefined);
		await h.prompt("hello");
		const patches = (h.seen.main?.at(-1) ?? []).flatMap((message) => {
			const sections = (message as { sections?: Record<string, unknown> }).sections;
			return sections && "charter" in sections ? [sections.charter] : [];
		});
		assert.equal(patches.length, 2);
		assert.equal(patches.at(-1), null, "the instructions are withdrawn when the mode is turned off");
		const removed = (h.seen.main?.at(-1) ?? []).flatMap((message) => (message as { toolsRemoved?: Array<{ name: string }> }).toolsRemoved ?? []).map((tool) => tool.name);
		assert.ok(removed.includes("charter_new"), "and so are the tools");
	} finally {
		await h.dispose();
	}
});

test("/charter on validates configured models and offers existing charters", async () => {
	const h = await piHarness({ config: { roles: { implementer: { model: "faux/missing" } } } });
	try {
		await h.prompt("/charter");
		assert.match(lastError(h), /implementer model "faux\/missing" is not available in Pi/);
		h.script("main", say("hi"));
		await h.prompt("hello");
		assert.equal(declaredTools(h.seen.main?.at(-1) ?? []).some((name) => name.startsWith("charter_")), false, "the mode stays off");
	} finally {
		await h.dispose();
	}

	const broken = await piHarness();
	try {
		broken.project.write(".pi/charter.json", JSON.stringify({ version: 1, limits: { cycles: 0 }, surprise: true }));
		await broken.prompt("/charter");
		assert.match(lastError(broken), /Invalid .*charter\.json:[\s\S]*surprise: unknown setting[\s\S]*limits\.cycles/);
		await broken.prompt("/charter doctor");
		assert.match(shown(broken).at(-1) ?? "", /FAIL  Invalid[\s\S]*1 problem\(s\) found/);
	} finally {
		await broken.dispose();
	}
});

test("/charter setup writes a configuration from the developer's choices, and doctor verifies it", async () => {
	const h = await piHarness({ files: { "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint .", typecheck: "tsc --noEmit" } }) } });
	try {
		h.project.write(".pi/charter.json", JSON.stringify({ version: 1 }));
		// implementer: enable, model faux/impl, thinking high; auditor: enable, session model, low, 2 shards; refiner: stays disabled.
		h.ui.selects.push(
			"Enable the implementer — writes the code (off = specification only)", "faux/impl", "high",
			"Enable the auditor — independently checks every acceptance criterion", "Use the main session's model", "low", "2",
			"Disable the refiner",
		);
		h.ui.confirms.push(true);
		await h.prompt("/charter setup");
		const saved = JSON.parse(h.project.read(".pi/charter.json")) as { roles: Record<string, { enabled: boolean; model: string | null; thinking: string; shards?: number }>; checks: Array<{ name: string; run: string }> };
		assert.deepEqual(saved.roles.implementer, { enabled: true, model: "faux/impl", thinking: "high", timeoutMinutes: 60 });
		assert.deepEqual(saved.roles.auditor, { enabled: true, model: null, thinking: "low", timeoutMinutes: 30, shards: 2 });
		assert.equal(saved.roles.refiner?.enabled, false);
		assert.deepEqual(saved.checks.map((check) => `${check.name}=${check.run}`), ["typecheck=npm run typecheck", "lint=npm run lint", "test=npm test"]);
		assert.match(h.ui.dialogs.findLast((dialog) => dialog.kind === "confirm")?.message ?? "", /typecheck: npm run typecheck\nlint: npm run lint\ntest: npm test/);

		await h.prompt("/charter doctor");
		const report = shown(h).at(-1) ?? "";
		assert.match(report, /ok    implementer \(faux\/impl, thinking high\)/);
		assert.match(report, /ok    auditor \(session model, thinking low, up to 2 shards\)/);
		assert.match(report, /ok    git: checkpoints enabled/);
		assert.match(report, /ok    check test: npm test \(limit 600s\)/);
		assert.match(report, /No problems found\./);
	} finally {
		await h.dispose();
	}
});

test("developer overrides: go grants a cycle, skip moves past the audit, reopen and rollback return to drafting", async () => {
	const h = await piHarness({ config: { limits: { cycles: 1 } } });
	const implDone = (context: { messages: Parameters<typeof briefOf>[0] }) => call("charter_report", { status: "done", summary: "s", criteria: passing(criteria(briefOf(context.messages))) });
	try {
		await h.prompt("/charter new Greeting");
		h.project.write(`.charter/${ID}/brief.md`, BRIEF);
		h.project.write(`.charter/${ID}/spec.md`, specWith(1));

		// Cycle 1 ends in a finding the developer wants fixed; the budget of one cycle is then spent.
		h.script("main", call("charter_approve"), say("finding"), call("charter_resolve", { decisions: [{ ref: "F1", decision: "fix", text: "fix it" }] }), say("budget spent"));
		h.script("impl", call("write", { path: "src/greet.js", content: "v1\n" }), implDone);
		h.script("audit", (context) =>
			call("charter_report", { criteria: criteria(briefOf(context.messages)).map((id) => ({ id, result: "fail", evidence: "wrong" })), findings: [{ title: "wrong", severity: "major", criterion: "AC1", detail: "d", evidence: "e" }] }),
		);
		await h.prompt("approve");
		h.ui.confirms.push(true, false); // confirm the decision, decline the extra cycle
		await h.prompt("fix it");
		assert.match(h.toolResults().at(-1) ?? "", /The pipeline stopped: The implementation budget of 1 cycle is spent/);
		assert.equal(h.ui.dialogs.at(-1)?.title, "Implementation budget spent");

		// /charter go grants the cycle and hands control back to the model.
		h.script("main", call("charter_advance"), say("implemented, audit pending"));
		h.script("impl", call("write", { path: "src/greet.js", content: "v2\n" }), implDone);
		h.script("audit", say("I refuse to report."), say("Still no."));
		await h.prompt("/charter go");
		assert.equal(readState(h).cycleGrant, 1);
		assert.equal(readState(h).stage, "audit");
		assert.match(h.toolResults().at(-1) ?? "", /audit-2 ended without filing its report/);

		// The developer decides to finish without the audit.
		h.script("main", call("charter_advance"), say("done"));
		await h.prompt("/charter skip auditor model is down");
		assert.equal(readState(h).stage, "done");
		assert.match(h.ui.notifications.findLast((entry) => entry.type === "warning")?.message ?? "", /Skipped "audit"/);
		assert.match(h.toolResults().at(-1) ?? "", /No independent audit ran[\s\S]*audit: skipped by the developer: auditor model is down/);
		await h.prompt("/charter report");
		assert.match(shown(h).at(-1) ?? "", /^# Charter 001-greeting: Greeting/);

		// Rollback restores the baseline and reopens; reports stay.
		h.script("main", say("What should change?"));
		await h.prompt("/charter rollback");
		assert.equal(existsSync(join(h.project.root, "src/greet.js")), false);
		assert.equal(readState(h).stage, "drafting");
		assert.match(shown(h).at(-1) ?? "", /Rolled back to checkpoint "baseline": 1 file\(s\) restored or removed[\s\S]*src\/greet\.js/);
		assert.ok(existsSync(join(h.charterDir(ID), "reports/impl-2.json")));

		// Approving again by command starts revision 2; reopen brings it back once more.
		h.script("main", say("ok"));
		await h.prompt("/charter approve");
		assert.equal(readState(h).revision, 2);
		assert.equal(readState(h).stage, "implement");
		h.script("main", say("What should change?"));
		await h.prompt("/charter reopen");
		assert.equal(readState(h).stage, "drafting");
	} finally {
		await h.dispose();
	}
});
