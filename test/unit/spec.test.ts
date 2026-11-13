import assert from "node:assert/strict";
import { test } from "node:test";

import { criterionIds, lintBrief, lintDesign, lintDocuments, lintSpec } from "../../src/core/spec/lint.ts";
import { compareIds, parseSpec, parseVerifiedBy } from "../../src/core/spec/parse.ts";
import { BRIEF, specWith, tempProject } from "../support/fixtures.ts";

const rules = (markdown: string): string[] => lintSpec(parseSpec(markdown)).map((d) => `${d.severity}:${d.rule}`);

const FULL = `# Spec: Export

## Requirements

### R1: The exporter MUST write a header row

- Change: added
- Verified by: AC3, test: test/export.test.ts > "writes, header"

#### AC1: Header row is written

- **GIVEN** an empty dataset
- WHEN the export runs
- AND the file is read back
- THEN the file has exactly one line

| rows | lines |
| --- | --- |
| 0 | 1 |

#### AC2: Columns are quoted

- GIVEN a value with a comma
- WHEN the export runs
- THEN the value is wrapped in double quotes

Example: \`a,b\` becomes \`"a,b"\`

### R2: The exporter MUST NOT emit a BOM

- Change: modified
- Was: A UTF-8 BOM was written.

#### AC10: No BOM

- GIVEN any dataset
- WHEN the export runs
- THEN the first byte is not 0xEF

\`\`\`text
first bytes: 69 64
\`\`\`

## Regression checks

### AC3: Existing JSON export is unchanged

- GIVEN a dataset
- WHEN the JSON export runs
- THEN the output is byte-identical to before

| rows | sha |
| --- | --- |
| 2 | abc |

## Assumptions

- Files are UTF-8.
- Line endings are LF.
`;

test("parses requirements, nested criteria, clauses, examples and assumptions", () => {
	const spec = parseSpec(FULL);
	assert.equal(spec.title, "Spec: Export");
	assert.deepEqual(spec.requirements.map((r) => [r.id, r.change, r.nested]), [["R1", "added", ["AC1", "AC2"]], ["R2", "modified", ["AC10"]]]);
	assert.equal(spec.requirements[1]?.was, "A UTF-8 BOM was written.");
	assert.deepEqual(spec.requirements[0]?.verifiedBy, [{ kind: "criterion", id: "AC3" }, { kind: "test", path: "test/export.test.ts", scenario: "writes, header" }]);

	const [ac1, ac2, ac10, ac3] = spec.criteria;
	assert.deepEqual(ac1?.given, ["an empty dataset"]);
	assert.deepEqual(ac1?.when, ["the export runs", "the file is read back"]);
	assert.equal(ac1?.requirement, "R1");
	assert.ok(ac1?.hasExample && ac2?.hasExample && ac10?.hasExample && ac3?.hasExample);
	assert.equal(ac3?.requirement, undefined);
	assert.equal(ac3?.regression, true);
	assert.deepEqual(spec.assumptions, ["Files are UTF-8.", "Line endings are LF."]);
	assert.deepEqual(criterionIds(spec), ["AC1", "AC2", "AC3", "AC10"]);
	assert.deepEqual(lintSpec(spec), []);
});

test("structure inside fenced code is ignored", () => {
	const spec = parseSpec("## Requirements\n\n```markdown\n### R9: The x MUST y\n#### AC9: nope\n{{placeholder}}\n```\n");
	assert.equal(spec.requirements.length, 0);
	assert.equal(spec.criteria.length, 0);
	assert.equal(spec.placeholders.length, 0);
});

test("Verified by accepts ids, links and test references", () => {
	assert.deepEqual(parseVerifiedBy("AC1, [AC2](#ac2-title); test: a/b.test.ts").refs, [
		{ kind: "criterion", id: "AC1" },
		{ kind: "criterion", id: "AC2" },
		{ kind: "test", path: "a/b.test.ts" },
	]);
	assert.deepEqual(parseVerifiedBy("the tests, AC1").unparsed, ["the tests"]);
});

test("ids sort naturally", () => {
	assert.deepEqual(["AC10", "AC2", "AC1"].sort(compareIds), ["AC1", "AC2", "AC10"]);
});

test("lint: a requirement needs MUST, a Change and some verification", () => {
	const found = rules("### R1: Exports work\n\n### R2: The API MUST respond\n\n- Change: tweaked\n- Verified by: AC7, something\n");
	assert.deepEqual(found.sort(), [
		"error:no-criteria",
		"error:requirement-change",
		"error:requirement-change",
		"error:requirement-must",
		"error:requirement-unverified",
		"error:verified-by-syntax",
		"error:verified-by-unknown",
	]);
});

test("lint: a criterion needs all three clauses and a concrete example", () => {
	const found = rules("### R1: The API MUST respond\n\n- Change: added\n\n#### AC1: Responds\n\n- GIVEN a server\n- THEN it works correctly\n\n| header only |\n| --- |\n");
	assert.deepEqual(found.sort(), ["error:criterion-clause", "error:criterion-example", "warning:criterion-vague"]);
});

test("lint: duplicates, orphans and placeholders", () => {
	const block = (id: string, title: string): string => `### ${id}: ${title}\n\n- GIVEN a\n- WHEN b\n- THEN c is 1\n\nExample: c = 1\n\n`;
	const found = rules(`## Requirements\n\n${block("AC1", "Same")}${block("AC1", "Other")}${block("AC2", "Same")}Status: TBD\n\nLiteral \`TODO\` is fine.\n`);
	assert.deepEqual(found.sort(), [
		"error:duplicate-criterion",
		"error:unresolved-placeholder",
		"warning:criterion-duplicate-title",
		"warning:criterion-orphan",
		"warning:criterion-orphan",
		"warning:criterion-orphan",
	]);
});

test("lint: brief sections must exist and have content; design must record something", () => {
	assert.deepEqual(lintBrief(BRIEF), []);
	const problems = lintBrief("# Brief\n\n## Why\n\n<!-- hint -->\n\n## Outcome\n\n{{fill}}\n\n## In scope\n\n- x\n");
	assert.deepEqual(problems.map((d) => d.message), ['section "why" is empty', 'missing section "## Out of scope"', "unresolved placeholder or open marker: {{fill}}"]);
	assert.deepEqual(lintDesign("# Design\n\n## Decisions\n").map((d) => d.rule), ["design-empty"]);
	assert.deepEqual(lintDesign("# Design\n\n## Decisions\n\nUse SQLite.\n"), []);
});

test("lintDocuments checks missing documents and referenced test files", async () => {
	const project = tempProject({ git: false, files: { "test/real.test.ts": "" } });
	try {
		const spec = `${specWith(1)}\n### R2: The library MUST keep old behavior\n\n- Change: modified\n- Verified by: test: test/real.test.ts > "old", test: test/missing.test.ts\n`;
		const result = await lintDocuments({ brief: BRIEF, spec }, { projectRoot: project.root });
		assert.deepEqual(result.diagnostics.map((d) => d.rule), ["verified-by-test-missing"]);
		assert.match(result.diagnostics[0]?.message ?? "", /missing\.test\.ts/);
		assert.equal(result.errors, 1);

		const missing = await lintDocuments({});
		assert.deepEqual(missing.diagnostics.filter((d) => d.rule === "missing-document").map((d) => d.file), ["brief.md", "spec.md"]);

		assert.equal((await lintDocuments({ brief: BRIEF, spec: specWith(3) })).errors, 0);
	} finally {
		project.cleanup();
	}
});
