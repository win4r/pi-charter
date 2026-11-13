import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig } from "../../src/core/config.ts";
import { afterImplementation, isFrozen, isRunnable, isWaiting, transition } from "../../src/core/machine.ts";
import { STAGES } from "../../src/core/types.ts";

const all = parseConfig({ version: 1, roles: { refiner: { enabled: true } }, checks: [{ name: "t", run: "true" }] });
const bare = parseConfig({ version: 1, roles: { auditor: { enabled: false } } });
const specOnly = parseConfig({ version: 1, roles: { implementer: { enabled: false } } });

test("the full path visits every configured phase in order", () => {
	assert.equal(transition("drafting", { type: "approve" }, all), "implement");
	assert.equal(transition("implement", { type: "implemented" }, all), "gate");
	assert.equal(transition("gate", { type: "gate-passed" }, all), "audit");
	assert.equal(transition("audit", { type: "audit-clean" }, all), "refine");
	assert.equal(transition("refine", { type: "refined" }, all), "done");
});

test("disabled phases are bypassed", () => {
	assert.equal(transition("drafting", { type: "approve" }, specOnly), "done");
	assert.equal(afterImplementation(bare), "done");
	assert.equal(transition("implement", { type: "implemented" }, parseConfig({ version: 1 })), "audit");
	assert.equal(transition("audit", { type: "audit-clean" }, parseConfig({ version: 1 })), "done");
});

test("decisions route by outcome, and waived gate findings still reach the audit", () => {
	assert.equal(transition("implement", { type: "blocked" }, all), "questions");
	assert.equal(transition("questions", { type: "answered", revise: false }, all), "implement");
	assert.equal(transition("questions", { type: "answered", revise: true }, all), "drafting");
	assert.equal(transition("gate", { type: "gate-repair" }, all), "implement");
	assert.equal(transition("gate", { type: "gate-escalated" }, all), "triage");
	assert.equal(transition("audit", { type: "audit-findings" }, all), "triage");
	assert.equal(transition("triage", { type: "triaged", outcome: "fix", origin: "audit" }, all), "implement");
	assert.equal(transition("triage", { type: "triaged", outcome: "revise", origin: "audit" }, all), "drafting");
	assert.equal(transition("triage", { type: "triaged", outcome: "waived", origin: "audit" }, all), "refine");
	assert.equal(transition("triage", { type: "triaged", outcome: "waived", origin: "gate" }, all), "audit");
});

test("skip moves past exactly one optional step; reopen works from any approved stage", () => {
	assert.equal(transition("gate", { type: "skip" }, all), "audit");
	assert.equal(transition("audit", { type: "skip" }, all), "refine");
	assert.equal(transition("refine", { type: "skip" }, all), "done");
	for (const stage of STAGES) {
		if (stage === "drafting") assert.throws(() => transition(stage, { type: "reopen" }, all), /not possible/);
		else assert.equal(transition(stage, { type: "reopen" }, all), "drafting");
	}
});

test("illegal moves are refused with the allowed origins", () => {
	assert.throws(() => transition("drafting", { type: "implemented" }, all), /allowed from: implement/);
	assert.throws(() => transition("implement", { type: "approve" }, all), /allowed from: drafting/);
	assert.throws(() => transition("implement", { type: "skip" }, all), /not possible/);
	assert.throws(() => transition("done", { type: "refined" }, all), /not possible/);
});

test("stage classes partition the stages", () => {
	for (const stage of STAGES) {
		const classes = [isRunnable(stage), isWaiting(stage), stage === "done"].filter(Boolean).length;
		assert.equal(classes, 1, stage);
		assert.equal(isFrozen(stage), stage !== "drafting");
	}
});
