import assert from "node:assert/strict";
import { test } from "node:test";

import { runCheck, runChecks } from "../../src/core/gate.ts";
import { tempProject } from "../support/fixtures.ts";

const node = (script: string): string => `node -e ${JSON.stringify(script)}`;

test("a check passes on exit 0 and fails otherwise, capturing both streams", async () => {
	const project = tempProject({ git: false });
	try {
		const ok = await runCheck({ name: "ok", run: node("console.log('out'); console.error('err')"), timeoutSeconds: 20 }, project.root);
		assert.equal(ok.passed, true);
		assert.match(ok.output, /out/);
		assert.match(ok.output, /err/);

		const bad = await runCheck({ name: "bad", run: node("console.log(process.cwd()); process.exit(3)"), timeoutSeconds: 20 }, project.root);
		assert.equal(bad.passed, false);
		assert.equal(bad.exitCode, 3);
		assert.ok(bad.output.includes(project.root.split("/").pop() ?? ""), "checks run in the project root");

		const missing = await runCheck({ name: "missing", run: "definitely-not-a-command-xyz", timeoutSeconds: 20 }, project.root);
		assert.equal(missing.passed, false);
	} finally {
		project.cleanup();
	}
});

test("output is cut to its tail on a line boundary", async () => {
	const project = tempProject({ git: false });
	try {
		const result = await runCheck({ name: "noisy", run: node("for (let i = 0; i < 4000; i++) console.log('line ' + i)"), timeoutSeconds: 20 }, project.root);
		assert.ok(result.output.length < 7000);
		assert.match(result.output, /^\[\.\.\. earlier output omitted \.\.\.\]\nline \d+\n/);
		assert.match(result.output, /line 3999$/);
	} finally {
		project.cleanup();
	}
});

test("a check that exceeds its limit is killed and reported as timed out", async () => {
	const project = tempProject({ git: false });
	try {
		const started = Date.now();
		const result = await runCheck({ name: "hang", run: node("setInterval(() => {}, 1000)"), timeoutSeconds: 1 }, project.root);
		assert.equal(result.passed, false);
		assert.equal(result.timedOut, true);
		assert.match(result.output, /timed out after 1s/);
		assert.ok(Date.now() - started < 8000);
	} finally {
		project.cleanup();
	}
});

test("all checks run even after a failure; cancellation stops the sequence", async () => {
	const project = tempProject({ git: false });
	try {
		const seen: string[] = [];
		const outcomes = await runChecks(
			[
				{ name: "first", run: node("process.exit(1)"), timeoutSeconds: 20 },
				{ name: "second", run: node(""), timeoutSeconds: 20 },
			],
			project.root,
			{ onStart: (check) => seen.push(check.name) },
		);
		assert.deepEqual(outcomes.map((outcome) => [outcome.name, outcome.passed]), [["first", false], ["second", true]]);
		assert.deepEqual(seen, ["first", "second"]);

		const controller = new AbortController();
		const pending = runChecks(
			[
				{ name: "hang", run: node("setInterval(() => {}, 1000)"), timeoutSeconds: 60 },
				{ name: "never", run: node(""), timeoutSeconds: 20 },
			],
			project.root,
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 300);
		const cancelled = await pending;
		assert.equal(cancelled.length, 1);
		assert.equal(cancelled[0]?.passed, false);
	} finally {
		project.cleanup();
	}
});
