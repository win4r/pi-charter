import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cloneConfig, DEFAULT_CONFIG, type CharterConfig } from "../../src/core/config.ts";
import { CharterStore } from "../../src/core/store.ts";
import { type UsageTotals } from "../../src/core/types.ts";
import { Engine, type RoleRunner, type RoleRunRequest, type RoleRunResult } from "../../src/engine/pipeline.ts";

export const BRIEF = `# Brief: Greeting

## Why

Callers need a greeting.

## Outcome

A greet function exists.

## In scope

- greet()

## Out of scope

- localisation
`;

export function specWith(criteria: number): string {
	const blocks: string[] = ["# Spec: Greeting", "", "## Requirements", ""];
	for (let index = 1; index <= criteria; index++) {
		blocks.push(
			`### R${index}: The library MUST greet case ${index}`,
			"",
			"- Change: added",
			"",
			`#### AC${index}: Greeting ${index} is returned`,
			"",
			"- GIVEN a name",
			"- WHEN greet is called",
			`- THEN it returns the greeting ${index}`,
			"",
			"| name | result |",
			"| --- | --- |",
			`| Ada | Hello ${index}, Ada |`,
			"",
		);
	}
	return blocks.join("\n");
}

export const TEMPLATES = { brief: "# Brief: {{title}}\n\n## Why\n\n{{why}}\n", spec: "# Spec: {{title}}\n\n{{spec}}\n" };

export interface Project {
	root: string;
	write(path: string, content: string): void;
	read(path: string): string;
	git(...args: string[]): string;
	cleanup(): void;
}

export function tempProject(options: { git?: boolean; files?: Record<string, string> } = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "pi-charter-test-"));
	const project: Project = {
		root,
		write(path, content) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		},
		read(path) {
			return readFileSync(join(root, path), "utf8");
		},
		git(...args) {
			return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
	for (const [path, content] of Object.entries(options.files ?? {})) project.write(path, content);
	if (options.git !== false) {
		project.git("init", "-q", "-b", "main");
		project.write("README.md", "# project\n");
		project.git("add", "-A");
		project.git("commit", "-q", "-m", "initial");
	}
	return project;
}

export const USAGE: UsageTotals = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 };

export type ScriptedStep = (request: RoleRunRequest) => Promise<Partial<RoleRunResult> | void> | Partial<RoleRunResult> | void;

/** A runner whose agents are plain functions: they may edit files and must call `request.submit`. */
export class ScriptedRunner implements RoleRunner {
	readonly requests: RoleRunRequest[] = [];
	private readonly queues: Record<string, ScriptedStep[]> = { implementer: [], auditor: [], refiner: [] };

	on(role: "implementer" | "auditor" | "refiner", ...steps: ScriptedStep[]): this {
		this.queues[role]?.push(...steps);
		return this;
	}

	pending(): number {
		return Object.values(this.queues).reduce((sum, queue) => sum + queue.length, 0);
	}

	async run(request: RoleRunRequest): Promise<RoleRunResult> {
		this.requests.push(request);
		const step = this.queues[request.role]?.shift();
		if (!step) throw new Error(`ScriptedRunner: no step queued for ${request.role} (${request.label})`);
		let submitted = false;
		const wrapped: RoleRunRequest = {
			...request,
			submit: (submission) => {
				request.submit(submission);
				submitted = true;
			},
		};
		const partial = (await step(wrapped)) ?? {};
		return { outcome: submitted ? "reported" : "no-report", usage: USAGE, durationMs: 5, model: request.model ?? "session/model", ...partial };
	}
}

export function passAll(ids: readonly string[], result: "pass" | "fail" | "untested" = "pass") {
	return ids.map((id) => ({ id, result, evidence: `checked ${id}` }));
}

/** Criterion ids mentioned in the "Finish by calling" line of a brief. */
export function criteriaOf(request: RoleRunRequest): string[] {
	const line = request.prompt.split("\n").findLast((entry) => entry.includes("result and evidence for each of:")) ?? "";
	return [...line.matchAll(/AC\d+/g)].map((match) => match[0]);
}

export interface Harness {
	project: Project;
	config: CharterConfig;
	runner: ScriptedRunner;
	engine: Engine;
	store: CharterStore;
	/** Create a lint-clean charter and return its id. */
	draft(criteria?: number): Promise<string>;
}

export function harness(options: { git?: boolean; config?: (config: CharterConfig) => void; files?: Record<string, string> } = {}): Harness {
	const project = tempProject({ git: options.git, files: options.files });
	const config = cloneConfig(DEFAULT_CONFIG);
	options.config?.(config);
	const runner = new ScriptedRunner();
	const store = new CharterStore(project.root, config.directory);
	let tick = 0;
	const engine = new Engine({
		projectRoot: project.root,
		config,
		store,
		runner,
		now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
		scratchRoot: join(project.root, "..", `${project.root.split("/").pop()}-scratch`),
		...(options.git === false ? { git: null } : {}),
	});
	return {
		project,
		config,
		runner,
		engine,
		store,
		async draft(criteria = 2) {
			const state = await engine.create("Greeting", TEMPLATES);
			project.write(`${config.directory}/${state.id}/brief.md`, BRIEF);
			project.write(`${config.directory}/${state.id}/spec.md`, specWith(criteria));
			return state.id;
		},
	};
}
