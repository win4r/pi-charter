/**
 * Guess the project's own checks from its manifest files, so first-time setup
 * can offer them instead of asking the developer to type commands.
 */

import { join } from "node:path";

import type { CheckConfig } from "./config.ts";
import { pathExists, readJsonIfExists } from "./fsx.ts";
import { isRecord } from "./types.ts";

const NODE_SCRIPTS = ["typecheck", "lint", "test"] as const;

async function nodeRunner(root: string): Promise<string> {
	if (await pathExists(join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (await pathExists(join(root, "yarn.lock"))) return "yarn";
	if ((await pathExists(join(root, "bun.lock"))) || (await pathExists(join(root, "bun.lockb")))) return "bun";
	return "npm";
}

export async function detectChecks(root: string): Promise<CheckConfig[]> {
	const checks: CheckConfig[] = [];
	const add = (name: string, run: string, timeoutSeconds = 600): void => {
		checks.push({ name, run, timeoutSeconds });
	};

	let manifest: unknown;
	try {
		manifest = await readJsonIfExists(join(root, "package.json"));
	} catch {
		manifest = undefined;
	}
	if (isRecord(manifest) && isRecord(manifest.scripts)) {
		const runner = await nodeRunner(root);
		for (const script of NODE_SCRIPTS) {
			const body = manifest.scripts[script];
			// `npm init` leaves a placeholder test script that always fails.
			if (typeof body !== "string" || /no test specified/i.test(body)) continue;
			add(script, script === "test" && runner !== "bun" ? `${runner} test` : `${runner} run ${script}`);
		}
	}
	if (await pathExists(join(root, "Cargo.toml"))) {
		add("cargo-check", "cargo check --all-targets");
		add("cargo-test", "cargo test", 1200);
	}
	if (await pathExists(join(root, "go.mod"))) {
		add("go-vet", "go vet ./...");
		add("go-test", "go test ./...", 1200);
	}
	if ((await pathExists(join(root, "pytest.ini"))) || (await pathExists(join(root, "conftest.py")))) {
		add("pytest", "python -m pytest -q", 1200);
	}
	return checks;
}
