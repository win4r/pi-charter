import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorkspace } from "../../src/core/git.ts";
import { tempProject } from "../support/fixtures.ts";

test("open returns undefined outside a repository", async () => {
	const project = tempProject({ git: false });
	try {
		assert.equal(await GitWorkspace.open(project.root), undefined);
	} finally {
		project.cleanup();
	}
});

test("snapshots see tracked, untracked and deleted files but never touch HEAD, index or status", async () => {
	const project = tempProject({ files: { "src/a.ts": "a1\n", ".gitignore": "ignored/\n" } });
	try {
		project.write("staged.txt", "staged\n");
		project.git("add", "staged.txt");
		const git = await GitWorkspace.open(project.root, [".charter"]);
		assert.ok(git);

		const head = project.git("rev-parse", "HEAD");
		const statusBefore = project.git("status", "--porcelain");
		const first = await git.snapshot();
		assert.equal(await git.snapshot(), first, "snapshots are deterministic");

		project.write("src/a.ts", "a2\n");
		project.write("src/new.ts", "new\n");
		project.write("ignored/junk.txt", "junk\n");
		project.write(".charter/001-x/charter.json", "{}\n");
		rmSync(join(project.root, "README.md"));
		const statusDirty = project.git("status", "--porcelain");
		const second = await git.snapshot();

		assert.deepEqual(await git.changes(first, second), [
			{ status: "D", path: "README.md" },
			{ status: "M", path: "src/a.ts" },
			{ status: "A", path: "src/new.ts" },
		]);
		assert.deepEqual(await git.changes(second, second), []);
		assert.equal(project.git("rev-parse", "HEAD"), head);
		assert.equal(project.git("status", "--porcelain"), statusDirty, "snapshot must not alter the index");
		assert.notEqual(statusDirty, statusBefore);
	} finally {
		project.cleanup();
	}
});

test("restore puts back exactly the checkpointed tree and leaves excluded and ignored paths alone", async () => {
	const project = tempProject({ files: { "src/a.ts": "a1\n", "src/gone.ts": "gone\n", ".gitignore": "ignored/\n" } });
	try {
		project.write("wip.txt", "developer work in progress\n");
		const git = await GitWorkspace.open(project.root, [".charter"]);
		assert.ok(git);
		const checkpoint = await git.checkpoint("001-x/baseline", "baseline");
		assert.match(project.git("for-each-ref", "refs/charter/"), /refs\/charter\/001-x\/baseline/);
		assert.deepEqual((await git.listCheckpoints("001-x")).map((entry) => entry.commit), [checkpoint.commit]);

		project.write("src/a.ts", "agent edit\n");
		project.write("src/added/by-agent.ts", "x\n");
		rmSync(join(project.root, "src/gone.ts"));
		rmSync(join(project.root, "wip.txt"));
		project.write(".charter/001-x/reports/impl-1.json", "{}\n");
		project.write("ignored/cache.bin", "cache\n");
		const indexBefore = project.git("diff", "--cached", "--name-only");

		const restored = await git.restore(checkpoint.commit);
		assert.deepEqual(restored, ["src/a.ts", "src/added/by-agent.ts", "src/gone.ts", "wip.txt"]);
		assert.equal(project.read("src/a.ts"), "a1\n");
		assert.equal(project.read("src/gone.ts"), "gone\n");
		assert.equal(project.read("wip.txt"), "developer work in progress\n");
		assert.equal(existsSync(join(project.root, "src/added/by-agent.ts")), false);
		assert.equal(project.read(".charter/001-x/reports/impl-1.json"), "{}\n", "charter files survive a restore");
		assert.equal(project.read("ignored/cache.bin"), "cache\n");
		assert.equal(project.git("diff", "--cached", "--name-only"), indexBefore, "restore must not alter the index");
		assert.equal(await git.snapshot(), checkpoint.tree);
		assert.deepEqual(await git.restore(checkpoint.commit), []);
	} finally {
		project.cleanup();
	}
});

test("works before the first commit, with odd file names, and when the charter directory is committed", async () => {
	const project = tempProject({ git: false });
	try {
		project.git("init", "-q", "-b", "main");
		project.write("a file with spaces.txt", "1\n");
		project.write("-dash.txt", "1\n");
		project.write(".charter/001-x/spec.md", "v1\n");
		const git = await GitWorkspace.open(project.root, [".charter"]);
		assert.ok(git);
		const checkpoint = await git.checkpoint("001-x/baseline", "baseline");

		// The developer commits everything, including charter documents.
		project.git("add", "-A");
		project.git("commit", "-q", "-m", "all");
		project.write("a file with spaces.txt", "2\n");
		project.write("-dash.txt", "2\n");
		project.write(".charter/001-x/spec.md", "v2\n");
		assert.deepEqual((await git.changes(checkpoint.tree, await git.snapshot())).map((change) => change.path), ["-dash.txt", "a file with spaces.txt"]);
		assert.deepEqual(await git.restore(checkpoint.commit), ["-dash.txt", "a file with spaces.txt"]);
		assert.equal(project.read("a file with spaces.txt"), "1\n");
		assert.equal(project.read(".charter/001-x/spec.md"), "v2\n");
	} finally {
		project.cleanup();
	}
});

test("a project in a subdirectory only sees and restores its own subtree", async () => {
	const project = tempProject({ files: { "app/src/a.ts": "a1\n", "other/b.ts": "b1\n" } });
	try {
		const git = await GitWorkspace.open(join(project.root, "app"), [".charter"]);
		assert.ok(git);
		assert.equal(git.prefix, "app");
		const checkpoint = await git.checkpoint("001-x/baseline", "baseline");
		project.write("app/src/a.ts", "a2\n");
		project.write("other/b.ts", "b2\n");
		mkdirSync(join(project.root, "app/.charter"), { recursive: true });
		project.write("app/.charter/note.txt", "n\n");
		assert.deepEqual(await git.changes(checkpoint.tree, await git.snapshot()), [{ status: "M", path: "src/a.ts" }]);
		assert.deepEqual(await git.restore(checkpoint.commit), ["src/a.ts"]);
		assert.equal(project.read("other/b.ts"), "b2\n", "files outside the project are not ours to restore");
	} finally {
		project.cleanup();
	}
});

test("an edit that keeps a file's size and lands in the same instant as a commit is still seen", async () => {
	// Git's stat cache alone cannot tell such a file from the committed one: same size, same
	// timestamp. Editing right after each commit, many times, makes the same-tick case likely.
	const project = tempProject({ files: { "value.txt": "0\n" } });
	try {
		const git = await GitWorkspace.open(project.root);
		assert.ok(git);
		for (let round = 1; round <= 40; round++) {
			project.write("value.txt", `${round % 10}\n`);
			project.git("commit", "-q", "-a", "-m", `round ${round}`);
			project.write("value.txt", `${(round + 5) % 10}\n`);
			const committed = await git.treeOf("HEAD");
			const edited = await git.snapshot();
			assert.notEqual(edited, committed, `round ${round}: the edit was not noticed`);
			assert.deepEqual(await git.changes(committed, edited), [{ status: "M", path: "value.txt" }]);
		}
	} finally {
		project.cleanup();
	}
});
