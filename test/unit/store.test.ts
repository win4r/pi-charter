import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { acquireLock, isWithin, resolveToolPath } from "../../src/core/fsx.ts";
import { parseState } from "../../src/core/state.ts";
import { CharterStore, isCharterId, slugify } from "../../src/core/store.ts";
import { TEMPLATES, tempProject } from "../support/fixtures.ts";

const AT = "2026-01-01T00:00:00.000Z";

test("slugs and ids", () => {
	assert.equal(slugify("  CSV Export: für Berichte (v2)! "), "csv-export-fur-berichte-v2");
	assert.equal(slugify("a b c d e f g h"), "a-b-c-d-e-f");
	assert.equal(slugify("!!!"), "charter");
	assert.ok(isCharterId("001-csv-export"));
	assert.ok(isCharterId("1234-x"));
	for (const bad of ["1-x", "001", "001-", "001-CSV", "../001-x", "001-x/y"]) assert.equal(isCharterId(bad), false, bad);
});

test("create numbers charters, fills the templates and journals the event", async () => {
	const project = tempProject({ git: false });
	try {
		const store = new CharterStore(project.root, ".charter");
		assert.deepEqual(await store.list(), []);
		const first = await store.create("  CSV   export ", TEMPLATES, AT);
		const second = await store.create("CSV export", TEMPLATES, AT);
		assert.equal(first.state.id, "001-csv-export");
		assert.equal(second.state.id, "002-csv-export");
		assert.equal(first.state.title, "CSV export");
		assert.match(project.read(".charter/001-csv-export/brief.md"), /^# Brief: CSV export\n/);
		assert.match(project.read(".charter/001-csv-export/spec.md"), /\{\{spec\}\}/, "unfilled placeholders stay for the linter to flag");
		assert.deepEqual((await first.charter.readJournal()).map((event) => event.event), ["created"]);
		assert.deepEqual((await store.list()).map((entry) => [entry.id, entry.stage]), [["001-csv-export", "drafting"], ["002-csv-export", "drafting"]]);
		await assert.rejects(store.create("   ", TEMPLATES, AT), /needs a title/);
		assert.throws(() => store.charter("../escape"), /not a charter id/);
	} finally {
		project.cleanup();
	}
});

test("documents are hashed, archived, compared and restored", async () => {
	const project = tempProject({ git: false });
	try {
		const store = new CharterStore(project.root, ".charter");
		const { charter } = await store.create("Docs", TEMPLATES, AT);
		project.write(".charter/001-docs/attachments/mock/screen.txt", "v1\n");
		const approved = await charter.hashDocuments();
		assert.deepEqual(Object.keys(approved), ["attachments/mock/screen.txt", "brief.md", "spec.md"]);
		await charter.archiveApproved(1, Object.keys(approved));
		assert.deepEqual(await charter.documentDrift(approved), []);

		project.write(".charter/001-docs/spec.md", "tampered\n");
		project.write(".charter/001-docs/design.md", "sneaked in\n");
		project.write(".charter/001-docs/attachments/mock/screen.txt", "v2\n");
		assert.deepEqual(await charter.documentDrift(approved), ["attachments/mock/screen.txt", "design.md", "spec.md"]);

		await charter.restoreApproved(1, approved);
		assert.deepEqual(await charter.documentDrift(approved), []);
		assert.equal(existsSync(charter.document("design.md")), false);
	} finally {
		project.cleanup();
	}
});

test("state files are validated on load", async () => {
	const project = tempProject({ git: false });
	try {
		const store = new CharterStore(project.root, ".charter");
		const { charter, state } = await store.create("State", TEMPLATES, AT);
		assert.deepEqual(await charter.load(), state);

		writeFileSync(charter.statePath, JSON.stringify({ ...state, stage: "audit" }));
		await assert.rejects(charter.load(), /stage "audit" requires a recorded approval/);
		writeFileSync(charter.statePath, JSON.stringify({ ...state, stage: "flying", cycle: -1 }));
		await assert.rejects(charter.load(), /stage: "flying" is not one of[\s\S]*cycle: must be/);
		writeFileSync(charter.statePath, JSON.stringify({ ...state, schema: 99 }));
		await assert.rejects(charter.load(), /state schema 99/);
		writeFileSync(charter.statePath, JSON.stringify({ ...state, id: "002-other" }));
		await assert.rejects(charter.load(), /belongs to charter "002-other"/);
		assert.throws(() => parseState([], "x"), /not a charter state file/);
		await assert.rejects(store.charter("009-nope").load(), /does not exist/);
	} finally {
		project.cleanup();
	}
});

test("locks are exclusive across processes and reclaimed from dead ones", async () => {
	const project = tempProject({ git: false });
	try {
		const path = join(project.root, "x.lock");
		const lock = await acquireLock(path, "thing");
		await lock.release();
		await lock.release();
		assert.equal(existsSync(path), false);

		// pid 1 is alive and is not us.
		writeFileSync(path, JSON.stringify({ pid: 1 }));
		await assert.rejects(acquireLock(path, "thing"), /in use by another Pi process \(pid 1\)/);
		// A pid that cannot exist is a stale lock.
		writeFileSync(path, JSON.stringify({ pid: 2 ** 30 }));
		await (await acquireLock(path, "thing")).release();
		writeFileSync(path, "garbage");
		await (await acquireLock(path, "thing")).release();
	} finally {
		project.cleanup();
	}
});

test("path helpers", () => {
	assert.ok(isWithin("/a/b", "/a/b"));
	assert.ok(isWithin("/a/b", "/a/b/c/d"));
	assert.equal(isWithin("/a/b", "/a/bc"), false);
	assert.equal(isWithin("/a/b", "/a"), false);
	assert.equal(resolveToolPath("/proj", "@src/x.ts"), "/proj/src/x.ts");
	assert.equal(resolveToolPath("/proj", "../etc/passwd"), "/etc/passwd");
	assert.equal(resolveToolPath("/proj", "/abs/x"), "/abs/x");
});
