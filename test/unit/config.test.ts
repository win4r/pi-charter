import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { configLocations, DEFAULT_CONFIG, describeRole, directoryProblem, enabledRoles, loadConfig, parseConfig, saveConfig } from "../../src/core/config.ts";
import { CharterError } from "../../src/core/types.ts";

test("defaults apply when only the version is given", () => {
	assert.deepEqual(parseConfig({ version: 1 }), DEFAULT_CONFIG);
});

test("a partial layer overrides only what it names", () => {
	const config = parseConfig({ version: 1, roles: { auditor: { shards: 3, model: "acme/big" } }, checks: [{ name: "test", run: "npm test" }] });
	assert.equal(config.roles.auditor.shards, 3);
	assert.equal(config.roles.auditor.model, "acme/big");
	assert.equal(config.roles.auditor.thinking, DEFAULT_CONFIG.roles.auditor.thinking);
	assert.equal(config.roles.implementer.model, null);
	assert.deepEqual(config.checks, [{ name: "test", run: "npm test", timeoutSeconds: 600 }]);
});

test("model ids may contain further slashes, and inherit maps to null", () => {
	assert.equal(parseConfig({ version: 1, roles: { implementer: { model: "openrouter/~openai/gpt-mini" } } }).roles.implementer.model, "openrouter/~openai/gpt-mini");
	assert.equal(parseConfig({ version: 1, roles: { implementer: { model: "inherit" } } }).roles.implementer.model, null);
});

test("every problem is reported at once, with its path", () => {
	assert.throws(
		() => parseConfig({ version: 2, directory: "../out", roles: { auditor: { shards: 0, thinking: "huge" }, tester: {} }, checks: [{ name: "a", run: "" }, { name: "a b!", run: "x" }], limits: { cycles: 0 }, extra: 1 }),
		(error: unknown) => {
			assert.ok(error instanceof CharterError);
			const joined = error.problems.join("\n");
			for (const fragment of ["version:", "directory:", "roles.auditor.shards:", "roles.auditor.thinking:", "roles.tester:", "checks[0].run:", "checks[1].name:", "limits.cycles:", "extra:"]) {
				assert.ok(joined.includes(fragment), `expected a problem for ${fragment} in:\n${joined}`);
			}
			return true;
		},
	);
});

test("the version is required and unknown role models are rejected", () => {
	assert.throws(() => parseConfig({}), /version: is required/);
	assert.throws(() => parseConfig({ version: 1, roles: { implementer: { model: "no-provider" } } }), /provider\/model-id/);
	assert.throws(() => parseConfig({ version: 1, checks: [{ name: "t", run: "a" }, { name: "t", run: "b" }] }), /duplicate check name/);
});

test("the charter directory must be a real subdirectory", () => {
	assert.equal(directoryProblem("planning/charters"), undefined);
	assert.match(directoryProblem("/abs") ?? "", /relative/);
	assert.match(directoryProblem(".") ?? "", /project root itself/);
	assert.match(directoryProblem("../x") ?? "", /inside the project/);
	assert.match(directoryProblem("a/../../x") ?? "", /inside the project/);
	assert.match(directoryProblem(".git/x") ?? "", /\.git/);
	assert.match(directoryProblem("") ?? "", /non-empty/);
});

test("disabling the implementer disables the whole pipeline", () => {
	const config = parseConfig({ version: 1, roles: { implementer: { enabled: false }, refiner: { enabled: true } } });
	assert.deepEqual(enabledRoles(config), []);
	assert.deepEqual(enabledRoles(parseConfig({ version: 1, roles: { refiner: { enabled: true } } })), ["implementer", "auditor", "refiner"]);
	assert.match(describeRole(parseConfig({ version: 1, roles: { auditor: { shards: 2 } } }), "auditor"), /session model.*up to 2 shards/);
});

test("project settings are layered over user settings, and ignored when untrusted", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-charter-config-"));
	try {
		const locations = configLocations(join(root, "project"), ".pi", join(root, "agent"));
		mkdirSync(join(root, "agent"), { recursive: true });
		writeFileSync(locations.user ?? "", JSON.stringify({ version: 1, roles: { implementer: { model: "a/user", thinking: "low" } }, limits: { cycles: 5 } }));
		assert.deepEqual((await loadConfig(locations)).sources, [locations.user]);

		await saveConfig(locations.project, parseConfig({ version: 1, roles: { implementer: { model: "a/project" } } }));
		const merged = await loadConfig(locations);
		assert.equal(merged.config.roles.implementer.model, "a/project");
		assert.equal(merged.sources.length, 2);

		const untrusted = await loadConfig(locations, { trustProject: false });
		assert.equal(untrusted.config.roles.implementer.model, "a/user");
		assert.equal(untrusted.config.limits.cycles, 5);

		writeFileSync(locations.project, "{ not json");
		await assert.rejects(loadConfig(locations), /not valid JSON/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
