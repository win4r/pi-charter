/**
 * Work-tree snapshots that never touch HEAD, the index, the stash or any
 * branch. A snapshot is a tree built through a private index file; a
 * checkpoint is a commit of that tree kept alive under `refs/charter/`.
 *
 * Snapshots make three things possible without trusting an agent: an exact
 * list of what changed since approval, detection (and undo) of changes made
 * by a read-only role, and rollback of a refinement that broke a check.
 */

import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { pathExists } from "./fsx.ts";
import { CharterError } from "./types.ts";

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Covers timestamp granularity of coarse filesystems and the precision lost when setting times. */
const RACY_MARGIN_MS = 2000;

const IDENTITY = {
	GIT_AUTHOR_NAME: "pi-charter",
	GIT_AUTHOR_EMAIL: "pi-charter@localhost",
	GIT_COMMITTER_NAME: "pi-charter",
	GIT_COMMITTER_EMAIL: "pi-charter@localhost",
};

function run(cwd: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		const child = execFile(
			"git",
			args,
			{ cwd, env: { ...process.env, ...options.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
				resolvePromise({ code, stdout, stderr: stderr || (error && code === 1 && !stdout ? error.message : "") });
			},
		);
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

async function must(cwd: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}): Promise<string> {
	const result = await run(cwd, args, options);
	if (result.code !== 0) {
		throw new CharterError(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}`);
	}
	return result.stdout;
}

export interface FileChange {
	/** `A` added, `M` modified, `D` deleted (relative to the older tree). */
	status: "A" | "M" | "D";
	/** Path relative to the project root, with `/` separators. */
	path: string;
}

export class GitWorkspace {
	/** Repository top level. */
	readonly root: string;
	/** Project root relative to `root` (`""` when they coincide), `/`-separated. */
	readonly prefix: string;
	private readonly excludes: string[];

	private constructor(root: string, prefix: string, excludes: string[]) {
		this.root = root;
		this.prefix = prefix;
		this.excludes = excludes;
	}

	/**
	 * Open the repository that contains `projectRoot`, or return `undefined`
	 * when there is none (or git itself is missing).
	 *
	 * @param excludes project-relative directories left out of every snapshot
	 *   (the charter directory: restoring files must never rewind the workflow).
	 */
	static async open(projectRoot: string, excludes: string[] = []): Promise<GitWorkspace | undefined> {
		const result = await run(projectRoot, ["rev-parse", "--show-toplevel"]);
		if (result.code !== 0) return undefined;
		const root = resolve(result.stdout.trim());
		const prefix = relative(root, resolve(projectRoot)).split(sep).join("/");
		if (prefix.startsWith("..")) return undefined;
		return new GitWorkspace(root, prefix, excludes.map((exclude) => (prefix ? `${prefix}/${exclude}` : exclude)));
	}

	private toProjectPath(repoPath: string): string {
		return this.prefix && repoPath.startsWith(`${this.prefix}/`) ? repoPath.slice(this.prefix.length + 1) : repoPath;
	}

	/** Build a tree of the current work tree (tracked + untracked, honouring .gitignore). */
	async snapshot(): Promise<string> {
		const scratch = await mkdtemp(join(tmpdir(), "pi-charter-index-"));
		const index = join(scratch, "index");
		try {
			// Seeding from the real index reuses its stat cache, so unchanged files are not re-hashed.
			const realIndex = resolve(this.root, (await must(this.root, ["rev-parse", "--git-path", "index"])).trim());
			if (await pathExists(realIndex)) {
				await copyFile(realIndex, index);
				// Git trusts a cached entry only if the file is older than the index file itself; a file
				// touched in the same instant is re-read ("racy" entries). A copy made now would look newer
				// than every entry and switch that protection off, so a same-size edit made in the same
				// tick as the last `git add` would be missed. Backdating the copy keeps the protection on
				// and errs on the side of re-reading a few more files.
				const original = await stat(realIndex);
				await utimes(index, original.atime, new Date(original.mtimeMs - RACY_MARGIN_MS));
			}
			const env = { GIT_INDEX_FILE: index };
			const pathspec = [this.prefix === "" ? "." : this.prefix, ...this.excludes.map((exclude) => `:(exclude)${exclude}`)];
			await must(this.root, ["add", "--all", "--", ...pathspec], { env });
			// The developer's own staging of excluded paths must not leak into the snapshot.
			if (this.excludes.length > 0) await run(this.root, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...this.excludes], { env });
			return (await must(this.root, ["write-tree"], { env })).trim();
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}

	/** Snapshot the work tree and pin it under `refs/charter/<name>`. Returns the commit. */
	async checkpoint(name: string, message: string): Promise<{ commit: string; tree: string }> {
		const tree = await this.snapshot();
		const head = await run(this.root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
		const parents = head.code === 0 ? ["-p", head.stdout.trim()] : [];
		const commit = (await must(this.root, ["commit-tree", tree, ...parents, "-m", message], { env: IDENTITY })).trim();
		await must(this.root, ["update-ref", `refs/charter/${name}`, commit]);
		return { commit, tree };
	}

	async treeOf(commitish: string): Promise<string> {
		return (await must(this.root, ["rev-parse", "--verify", `${commitish}^{tree}`])).trim();
	}

	/** Files that differ between two trees (or commits), limited to the project root. */
	async changes(from: string, to: string): Promise<FileChange[]> {
		if (from === to) return [];
		const scope = this.prefix === "" ? [] : ["--", this.prefix];
		const output = await must(this.root, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to, ...scope]);
		const parts = output.split("\0");
		const changes: FileChange[] = [];
		for (let index = 0; index + 1 < parts.length; index += 2) {
			const status = parts[index]?.[0];
			const path = parts[index + 1];
			if (!path || (status !== "A" && status !== "M" && status !== "D" && status !== "T")) continue;
			changes.push({ status: status === "T" ? "M" : status, path: this.toProjectPath(path) });
		}
		return changes;
	}

	/**
	 * Make the work tree match `target` again. Only paths that differ are
	 * touched, the index is left alone, and excluded directories are ignored.
	 * Returns the project-relative paths that were restored or removed.
	 */
	async restore(target: string): Promise<string[]> {
		const targetTree = await this.treeOf(target);
		const current = await this.snapshot();
		if (current === targetTree) return [];
		const scope = this.prefix === "" ? [] : ["--", this.prefix];
		const output = await must(this.root, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", targetTree, current, ...scope]);
		const parts = output.split("\0");
		const rewrite: string[] = [];
		const remove: string[] = [];
		for (let index = 0; index + 1 < parts.length; index += 2) {
			const status = parts[index]?.[0];
			const path = parts[index + 1];
			if (!path) continue;
			if (this.excludes.some((exclude) => path === exclude || path.startsWith(`${exclude}/`))) continue;
			// Added since the target: it must go. Anything else existed then: bring it back.
			if (status === "A") remove.push(path);
			else rewrite.push(path);
		}
		await Promise.all(remove.map((path) => rm(join(this.root, path), { force: true })));
		if (rewrite.length > 0) {
			await must(
				this.root,
				["--literal-pathspecs", "restore", `--source=${targetTree}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"],
				{ input: rewrite.join("\0") },
			);
		}
		return [...remove, ...rewrite].map((path) => this.toProjectPath(path)).sort();
	}

	/** Remove every checkpoint ref of one charter. Returns how many were removed. */
	async deleteCheckpoints(charterId: string): Promise<number> {
		const refs = await this.listCheckpoints(charterId);
		if (refs.length === 0) return 0;
		await must(this.root, ["update-ref", "--stdin"], { input: refs.map(({ ref }) => `delete ${ref}\n`).join("") });
		return refs.length;
	}

	/** Checkpoint refs for one charter, oldest first. */
	async listCheckpoints(charterId: string): Promise<Array<{ ref: string; commit: string }>> {
		const output = await must(this.root, ["for-each-ref", "--sort=creatordate", "--format=%(refname) %(objectname)", `refs/charter/${charterId}/`]);
		return output
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => {
				const [ref = "", commit = ""] = line.split(" ");
				return { ref, commit };
			});
	}
}
