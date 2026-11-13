import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { auditorBrief, implementerBrief, INLINE_DOCUMENT_LIMIT, partitionCriteria, refinerBrief } from "../../src/core/briefs.ts";
import { cloneConfig, DEFAULT_CONFIG } from "../../src/core/config.ts";
import { detectChecks } from "../../src/core/detect.ts";
import { newState } from "../../src/core/state.ts";
import { CharterStore } from "../../src/core/store.ts";
import { describeStatus, formatDuration, formatUsage, nextAction, statusLine } from "../../src/core/summary.ts";
import { STAGES } from "../../src/core/types.ts";
import { Engine } from "../../src/engine/pipeline.ts";
import { isOwnExtension } from "../../src/pi/child.ts";
import { parseDecisions } from "../../src/pi/commands.ts";
import { criteriaOf, harness, passAll, tempProject } from "../support/fixtures.ts";

test("criteria are partitioned into contiguous, balanced groups", () => {
	const ids = ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7"];
	assert.deepEqual(partitionCriteria(ids, 1), [ids]);
	assert.deepEqual(partitionCriteria(ids, 3).map((group) => group.length), [3, 2, 2]);
	assert.deepEqual(partitionCriteria(ids, 3).flat(), ids);
	assert.deepEqual(partitionCriteria(["AC1", "AC2"], 8), [["AC1"], ["AC2"]], "never more groups than criteria");
	assert.deepEqual(partitionCriteria([], 4), []);
	assert.deepEqual(partitionCriteria(ids, 0), [ids]);
});

test("briefs inline small documents, reference large ones, and list attachments", () => {
	const small = { directory: ".charter/001-x", files: [{ name: "brief.md", content: "why\n" }, { name: "spec.md", content: "what\n" }], attachments: ["attachments/mock.png"] };
	const inline = implementerBrief({ id: "001-x", cycle: 1, documents: small, criteria: ["AC1"], checks: [], answered: [], toFix: [] });
	assert.match(inline, /<document name="spec\.md">\nwhat\n<\/document>/);
	assert.match(inline, /part of the contract[\s\S]*- \.charter\/001-x\/attachments\/mock\.png/);
	assert.doesNotMatch(inline, /## Project checks|## What to fix|Files changed/);

	const large = { directory: ".charter/001-x", files: [{ name: "spec.md", content: "x".repeat(INLINE_DOCUMENT_LIMIT + 1) }] };
	const referenced = auditorBrief({ id: "001-x", documents: large, assigned: ["AC1"], allCriteria: ["AC1"], answered: [], waivedFrom: [], scratchDir: "/tmp/s" });
	assert.match(referenced, /Read these files completely before anything else:\n- \.charter\/001-x\/spec\.md/);
	assert.ok(referenced.length < 2000);
	assert.doesNotMatch(referenced, /working in parallel/);

	const many = Array.from({ length: 200 }, (_, index) => `src/file${index}.ts`);
	const refine = refinerBrief({ id: "001-x", documents: small, scope: many, checks: [{ name: "t", run: "npm test", timeoutSeconds: 1 }] });
	assert.match(refine, /src\/file149\.ts\n\.\.\. and 50 more/);
	assert.match(refine, /- t: `npm test`/);
});

test("status texts cover every stage", () => {
	const config = cloneConfig(DEFAULT_CONFIG);
	for (const stage of STAGES) {
		const state = { ...newState("001-x", "X", "2026-01-01T00:00:00.000Z"), stage, pending: "audit-1", cycle: 2 };
		assert.ok(nextAction(state).length > 20, stage);
		assert.match(statusLine(state), /^charter 001-x · .+ · cycle 2$/);
		assert.match(describeStatus(state, { config, directory: ".charter" }), new RegExp(`Stage: ${stage} `));
	}
	assert.equal(statusLine(newState("001-x", "X", "t"), "auditor audit-1"), "charter 001-x · auditor audit-1");
	assert.equal(formatDuration(900), "1s");
	assert.equal(formatDuration(65_000), "1m 05s");
	assert.equal(formatDuration(3 * 3600_000 + 4 * 60_000), "3h 04m");
	assert.equal(formatUsage({ input: 900, output: 12_345, cacheRead: 100, cacheWrite: 0, cost: 0 }), "1.0k in / 12k out");
	assert.equal(formatUsage({ input: 2_500_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: 1.234 }), "2.5M in / 10 out, $1.23");
	assert.equal(formatUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.0421 }), "1 in / 1 out, $0.042");
});

test("project checks are detected from manifests", async () => {
	const project = tempProject({ git: false });
	try {
		assert.deepEqual(await detectChecks(project.root), []);
		project.write("package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." } }));
		project.write("pnpm-lock.yaml", "");
		project.write("go.mod", "module x\n");
		project.write("Cargo.toml", "[package]\n");
		project.write("conftest.py", "");
		assert.deepEqual((await detectChecks(project.root)).map((check) => check.run), ["pnpm run lint", "cargo check --all-targets", "cargo test", "go vet ./...", "go test ./...", "python -m pytest -q"]);
		project.write("package.json", "{ broken");
		assert.equal((await detectChecks(project.root)).some((check) => check.run.startsWith("pnpm")), false);
	} finally {
		project.cleanup();
	}
});

test("/charter decide input is parsed strictly", () => {
	assert.deepEqual(parseDecisions("audit-1/F1 fix It must match; F2 WAIVE harmless, really\n impl-1/Q1 answer Use UTC; "), [
		{ ref: "audit-1/F1", decision: "fix", text: "It must match" },
		{ ref: "F2", decision: "waive", text: "harmless, really" },
		{ ref: "impl-1/Q1", decision: "answer", text: "Use UTC" },
	]);
	assert.throws(() => parseDecisions(""), /Usage: \/charter decide/);
	assert.throws(() => parseDecisions("F1 maybe later"), /Cannot read "F1 maybe later"/);
	assert.throws(() => parseDecisions("F1"), /Cannot read "F1"/);
});

test("agent sessions recognise every installed copy of this package as their own", () => {
	const project = tempProject({ git: false });
	try {
		assert.equal(isOwnExtension(join(import.meta.dirname, "../../extensions/charter.ts")), true);
		assert.equal(isOwnExtension("builtin:mcp"), false);
		assert.equal(isOwnExtension("<inline:charter-agent>"), false);
		assert.equal(isOwnExtension(join(project.root, "missing.ts")), false);

		mkdirSync(join(project.root, "copy/extensions"), { recursive: true });
		writeFileSync(join(project.root, "copy/package.json"), JSON.stringify({ name: "pi-charter" }));
		writeFileSync(join(project.root, "copy/extensions/charter.ts"), "");
		mkdirSync(join(project.root, "other/extensions"), { recursive: true });
		writeFileSync(join(project.root, "other/package.json"), JSON.stringify({ name: "something-else" }));
		writeFileSync(join(project.root, "other/extensions/index.ts"), "");
		assert.equal(isOwnExtension(join(project.root, "copy/extensions/charter.ts")), true);
		assert.equal(isOwnExtension(join(project.root, "other/extensions/index.ts")), false);
	} finally {
		project.cleanup();
	}
});

test("a phase disabled in the configuration after approval is passed over and reported", async () => {
	const h = harness({ config: (config) => void (config.roles.refiner.enabled = true) });
	try {
		const id = await h.draft(1);
		await h.engine.approve(id);
		h.runner.on("implementer", (request) => {
			h.project.write("src/greet.js", "x\n");
			request.submit({ status: "done", summary: "s", criteria: passAll(criteriaOf(request)) });
		});
		// The developer edits the configuration while the implementer is still due: no auditor, no refiner.
		const changed = cloneConfig(h.config);
		changed.roles.auditor.enabled = false;
		changed.roles.refiner.enabled = false;
		const store = new CharterStore(h.project.root, changed.directory);
		const later = new Engine({ projectRoot: h.project.root, config: changed, store, runner: h.runner });
		const state = await store.charter(id).load();
		state.stage = "audit";
		await store.charter(id).save(state, "2026-01-01T00:00:00.000Z");

		const notices: string[] = [];
		const result = await later.advance(id, { onNotice: (notice) => notices.push(notice) });
		assert.equal(result.status, "done");
		assert.match(notices.join(), /The auditor is disabled in the configuration; skipping "audit"/);
		assert.match(result.status === "done" ? result.report : "", /audit: the auditor was disabled in the configuration after approval/);
		assert.equal(h.runner.pending(), 1, "no agent ran");

		changed.roles.implementer.enabled = false;
		const reopened = await later.reopen(id);
		assert.equal(reopened.stage, "drafting");
	} finally {
		h.project.cleanup();
	}
});
