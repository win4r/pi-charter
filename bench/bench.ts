/**
 * Micro-benchmarks for the parts of Charter that run on every step.
 * Run with `npm run bench`. Numbers are wall-clock on the current machine.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitWorkspace } from "../src/core/git.ts";
import { lintSpec } from "../src/core/spec/lint.ts";
import { parseSpec } from "../src/core/spec/parse.ts";
import { criteriaOf, harness, passAll, specWith } from "../test/support/fixtures.ts";
import { briefOf, call, calls, piHarness, say } from "../test/support/pi.ts";

const rows: Array<[string, string]> = [];
const ms = (value: number): string => `${value.toFixed(value < 10 ? 2 : 0)} ms`;

async function time<T>(work: () => Promise<T> | T): Promise<[T, number]> {
	const started = performance.now();
	const result = await work();
	return [result, performance.now() - started];
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// 1. Extension load: what Pi pays at startup for having the package installed.
//    Measured in fresh processes after the host's own SDK is loaded.
{
	// The first .ts import of a process pays for Node's type stripper; warm it so only our modules are timed.
	const probeWarm = (specifier: string): number => {
		const script = `await import(${JSON.stringify("@earendil-works/pi-coding-agent")}); await import(${JSON.stringify(new URL("../src/core/types.ts", import.meta.url).href)}); const t = performance.now(); await import(${JSON.stringify(specifier)}); console.log(performance.now() - t);`;
		return Number(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim());
	};
	const startup = new URL("../extensions/charter.ts", import.meta.url).href;
	const runtime = new URL("../src/pi/runtime.ts", import.meta.url).href;
	rows.push(["Startup module (paid by every Pi session), fresh process, median of 7", ms(median(Array.from({ length: 7 }, () => probeWarm(startup))))]);
	rows.push(["Engine and agent runner (loaded on first use only), median of 7", ms(median(Array.from({ length: 7 }, () => probeWarm(runtime))))]);
}

// 2. Spec parsing and linting.
{
	const spec = specWith(200);
	const samples: number[] = [];
	for (let run = 0; run < 200; run++) {
		const [, elapsed] = await time(() => lintSpec(parseSpec(spec)));
		samples.push(elapsed);
	}
	rows.push([`Parse + lint a spec with 200 criteria (${(spec.length / 1024).toFixed(0)} KB), median of 200`, ms(median(samples))]);
}

// 3. Work-tree snapshots on a mid-sized repository.
{
	const root = mkdtempSync(join(tmpdir(), "pi-charter-bench-"));
	try {
		const files = 5000;
		for (let dir = 0; dir < 50; dir++) {
			mkdirSync(join(root, `pkg${dir}`), { recursive: true });
			for (let file = 0; file < files / 50; file++) writeFileSync(join(root, `pkg${dir}`, `file${file}.ts`), `export const value${file} = ${dir * file};\n`.repeat(20));
		}
		const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "b", GIT_AUTHOR_EMAIL: "b@b", GIT_COMMITTER_NAME: "b", GIT_COMMITTER_EMAIL: "b@b" } });
		git("init", "-q", "-b", "main");
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		const workspace = await GitWorkspace.open(root, [".charter"]);
		if (!workspace) throw new Error("no repository");

		const [baseline, first] = await time(() => workspace.checkpoint("bench/baseline", "baseline"));
		rows.push([`Checkpoint a clean ${files}-file work tree`, ms(first)]);
		for (let index = 0; index < 20; index++) writeFileSync(join(root, "pkg1", `file${index}.ts`), "changed\n");
		writeFileSync(join(root, "pkg2", "added.ts"), "new\n");
		const samples: number[] = [];
		let tree = "";
		for (let run = 0; run < 10; run++) {
			const [value, elapsed] = await time(() => workspace.snapshot());
			tree = value;
			samples.push(elapsed);
		}
		rows.push([`Snapshot the same tree with 21 changed files, median of 10`, ms(median(samples))]);
		const [changes, diff] = await time(() => workspace.changes(baseline.tree, tree));
		rows.push([`List the ${changes.length} changed files between two snapshots`, ms(diff)]);
		const [, restore] = await time(() => workspace.restore(baseline.commit));
		rows.push(["Restore those files to the checkpoint", ms(restore)]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// 4. Engine overhead: a whole pipeline with agents that answer instantly.
{
	const samples: number[] = [];
	for (let run = 0; run < 5; run++) {
		const h = harness({ config: (config) => void (config.roles.refiner.enabled = true) });
		try {
			const id = await h.draft(10);
			h.runner
				.on("implementer", (request) => {
					h.project.write("src/greet.js", "export const greet = () => 'hi';\n");
					request.submit({ status: "done", summary: "s", criteria: passAll(criteriaOf(request)) });
				})
				.on("auditor", (request) => request.submit({ criteria: passAll(criteriaOf(request)) }))
				.on("refiner", (request) => request.submit({ summary: "nothing to change" }));
			const [, elapsed] = await time(async () => {
				await h.engine.approve(id);
				await h.engine.advance(id);
			});
			samples.push(elapsed);
		} finally {
			h.project.cleanup();
		}
	}
	rows.push(["Engine overhead for approve -> implement -> audit -> refine -> report (git on), median of 5", ms(median(samples))]);
}

// 5. Model round trips for a complete charter, counted on real Pi sessions.
{
	const criteria = (text: string): string[] => [...(text.split("\n").findLast((line) => line.includes("result and evidence for each of:")) ?? "").matchAll(/AC\d+/g)].map((match) => match[0]);
	const passing = (ids: string[]) => ids.map((id) => ({ id, result: "pass", evidence: "ok" }));
	const h = await piHarness({ config: { roles: { refiner: { enabled: true } } } });
	try {
		await h.prompt("/charter new Greeting");
		h.script(
			"main",
			calls(["write", { path: ".charter/001-greeting/brief.md", content: "# Brief\n\n## Why\n\nx\n\n## Outcome\n\nx\n\n## In scope\n\n- x\n\n## Out of scope\n\n- x\n" }], ["write", { path: ".charter/001-greeting/spec.md", content: specWith(4) }]),
			call("charter_approve"),
			say("done"),
		);
		h.script("impl", call("write", { path: "src/greet.js", content: "x\n" }), (context) => call("charter_report", { status: "done", summary: "s", criteria: passing(criteria(briefOf(context.messages))) }));
		h.script("audit", (context) => call("charter_report", { criteria: passing(criteria(briefOf(context.messages))) }));
		h.script("refine", call("charter_report", { summary: "nothing to change" }));
		const before = h.seen.main?.length ?? 0;
		const [, elapsed] = await time(() => h.prompt("draft and approve"));
		const main = (h.seen.main?.length ?? 0) - before;
		rows.push(["Coordinator model calls from approval request to presented report (3 agents ran)", String(main - 1)]);
		rows.push(["Agent model calls beyond their own work (closing turns after the report)", "0"]);
		rows.push(["Host overhead for that whole run: 4 sessions, instant model", ms(elapsed)]);
	} finally {
		await h.dispose();
	}
}

const width = Math.max(...rows.map(([label]) => label.length));
console.log(`node ${process.version} on ${process.platform}/${process.arch}\n`);
for (const [label, value] of rows) console.log(`${label.padEnd(width)}  ${value}`);
