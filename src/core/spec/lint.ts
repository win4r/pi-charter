/**
 * Deterministic review of a charter's documents. Errors block approval;
 * warnings are shown to the developer but do not block.
 */

import { join } from "node:path";

import { pathExists, readTextIfExists } from "../fsx.ts";
import { compareIds, hasPlaceholder, type ParsedSpec, parseSpec, type SpecPlaceholder } from "./parse.ts";

export type Severity = "error" | "warning";

export interface Diagnostic {
	severity: Severity;
	/** Stable rule name, usable in documentation and tests. */
	rule: string;
	file: string;
	line?: number;
	message: string;
}

export interface LintResult {
	diagnostics: Diagnostic[];
	errors: number;
	warnings: number;
	spec: ParsedSpec;
}

const CHANGES = ["added", "modified", "removed"];
const VAGUE = /\b(properly|correctly|as expected|appropriately|should work|works? (?:fine|well)|user[- ]friendly|intuitive|fast enough|reasonabl[ey]|gracefully|seamlessly|etc\.?)\b/i;
const BRIEF_SECTIONS = ["why", "outcome", "in scope", "out of scope"];

function placeholderDiagnostics(file: string, placeholders: SpecPlaceholder[]): Diagnostic[] {
	return placeholders.map((placeholder) => ({
		severity: "error" as const,
		rule: "unresolved-placeholder",
		file,
		line: placeholder.line,
		message: `unresolved placeholder or open marker: ${placeholder.text.slice(0, 100)}`,
	}));
}

/** Rules that need only the parsed spec (no filesystem). */
export function lintSpec(spec: ParsedSpec, file = "spec.md"): Diagnostic[] {
	const out: Diagnostic[] = [];
	const add = (severity: Severity, rule: string, message: string, line?: number): void => {
		out.push({ severity, rule, file, line, message });
	};

	if (spec.criteria.length === 0) {
		add("error", "no-criteria", "the spec defines no acceptance criteria (headings like `#### AC1: ...`)");
	}

	const criteriaById = new Map<string, number>();
	for (const criterion of spec.criteria) {
		const count = criteriaById.get(criterion.id) ?? 0;
		criteriaById.set(criterion.id, count + 1);
		if (count === 1) add("error", "duplicate-criterion", `${criterion.id} is defined more than once`, criterion.line);
	}
	const requirementIds = new Set<string>();
	for (const requirement of spec.requirements) {
		if (requirementIds.has(requirement.id)) {
			add("error", "duplicate-requirement", `${requirement.id} is defined more than once`, requirement.line);
		}
		requirementIds.add(requirement.id);
	}

	const referenced = new Set<string>();
	for (const requirement of spec.requirements) {
		const at = requirement.line;
		if (requirement.title === "") add("error", "requirement-title", `${requirement.id} has no statement`, at);
		else if (!/\bMUST\b/.test(requirement.title)) {
			add("error", "requirement-must", `${requirement.id} must state an obligation with MUST or MUST NOT ("The <actor> MUST <outcome>")`, at);
		}

		if (requirement.change === undefined) {
			add("error", "requirement-change", `${requirement.id} is missing its \`Change:\` field (${CHANGES.join(" | ")})`, at);
		} else if (!CHANGES.includes(requirement.change)) {
			add("error", "requirement-change", `${requirement.id} has Change "${requirement.change}"; expected ${CHANGES.join(" | ")}`, at);
		}

		for (const token of requirement.unparsedRefs) {
			add("error", "verified-by-syntax", `${requirement.id}: cannot read \`Verified by\` entry "${token}" (use AC ids or \`test: path > "scenario"\`)`, at);
		}
		for (const ref of requirement.verifiedBy) {
			if (ref.kind !== "criterion") continue;
			referenced.add(ref.id);
			if (!criteriaById.has(ref.id)) add("error", "verified-by-unknown", `${requirement.id} is verified by ${ref.id}, which is not defined`, at);
		}
		for (const id of requirement.nested) referenced.add(id);
		if (requirement.nested.length === 0 && requirement.verifiedBy.length === 0) {
			add("error", "requirement-unverified", `${requirement.id} has no verification: nest an acceptance criterion under it or add \`Verified by:\``, at);
		}
	}

	const titles = new Map<string, string>();
	for (const criterion of spec.criteria) {
		const at = criterion.line;
		if (criterion.title === "") add("error", "criterion-title", `${criterion.id} has no title`, at);
		for (const [clause, items] of [
			["GIVEN", criterion.given],
			["WHEN", criterion.when],
			["THEN", criterion.then],
		] as const) {
			if (items.length === 0) add("error", "criterion-clause", `${criterion.id} is missing its ${clause} clause (\`- ${clause} ...\`)`, at);
		}
		if (!criterion.hasExample) {
			add("error", "criterion-example", `${criterion.id} needs a concrete example: a table with at least one data row, a fenced block, or an \`Example:\` line`, at);
		}
		for (const outcome of criterion.then) {
			const vague = VAGUE.exec(outcome);
			if (vague) add("warning", "criterion-vague", `${criterion.id}: THEN uses "${vague[0]}", which cannot be measured; state the observable result`, at);
		}
		if (!criterion.requirement && !criterion.regression && !referenced.has(criterion.id)) {
			add("warning", "criterion-orphan", `${criterion.id} belongs to no requirement and is not under "Regression checks"`, at);
		}
		const key = criterion.title.toLowerCase();
		const previous = titles.get(key);
		if (previous && key !== "") add("warning", "criterion-duplicate-title", `${criterion.id} has the same title as ${previous}`, at);
		else titles.set(key, criterion.id);
	}

	out.push(...placeholderDiagnostics(file, spec.placeholders));
	return out;
}

/** Sections of a prose document: level-2 title (lower-cased) -> whether it has any body text. */
function proseSections(markdown: string): { sections: Map<string, boolean>; placeholders: SpecPlaceholder[] } {
	const sections = new Map<string, boolean>();
	const placeholders: SpecPlaceholder[] = [];
	let current: string | undefined;
	let fenced = false;
	const lines = markdown.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (/^\s{0,3}(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		if (hasPlaceholder(line)) placeholders.push({ line: index + 1, text: line.trim() });
		const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/.exec(line);
		if (heading?.[1] && heading[2] !== undefined) {
			current = heading[1].length === 2 ? heading[2].trim().toLowerCase() : heading[1].length < 2 ? undefined : current;
			if (heading[1].length === 2 && current !== undefined) sections.set(current, false);
			continue;
		}
		if (current !== undefined && line.trim() !== "" && !/^\s*<!--.*-->\s*$/.test(line)) sections.set(current, true);
	}
	return { sections, placeholders };
}

export function lintBrief(markdown: string, file = "brief.md"): Diagnostic[] {
	const out: Diagnostic[] = [];
	const { sections, placeholders } = proseSections(markdown);
	for (const name of BRIEF_SECTIONS) {
		const filled = sections.get(name);
		if (filled === undefined) out.push({ severity: "error", rule: "brief-section", file, message: `missing section "## ${name[0]?.toUpperCase()}${name.slice(1)}"` });
		else if (!filled) out.push({ severity: "error", rule: "brief-section", file, message: `section "${name}" is empty` });
	}
	out.push(...placeholderDiagnostics(file, placeholders));
	return out;
}

export function lintDesign(markdown: string, file = "design.md"): Diagnostic[] {
	const { sections, placeholders } = proseSections(markdown);
	const out = placeholderDiagnostics(file, placeholders);
	if (![...sections.values()].some(Boolean)) {
		out.push({ severity: "error", rule: "design-empty", file, message: "design.md exists but records no decision; fill it in or delete it" });
	}
	return out;
}

export interface CharterDocuments {
	brief?: string;
	spec?: string;
	design?: string;
}

export interface LintOptions {
	/** Project root, used to confirm that `test:` references point at real files. */
	projectRoot?: string;
}

export async function lintDocuments(documents: CharterDocuments, options: LintOptions = {}): Promise<LintResult> {
	const diagnostics: Diagnostic[] = [];
	const spec = parseSpec(documents.spec ?? "");

	if (documents.brief === undefined) diagnostics.push({ severity: "error", rule: "missing-document", file: "brief.md", message: "brief.md does not exist" });
	else diagnostics.push(...lintBrief(documents.brief));

	if (documents.spec === undefined) diagnostics.push({ severity: "error", rule: "missing-document", file: "spec.md", message: "spec.md does not exist" });
	else {
		diagnostics.push(...lintSpec(spec));
		if (options.projectRoot) {
			for (const requirement of spec.requirements) {
				for (const ref of requirement.verifiedBy) {
					if (ref.kind !== "test") continue;
					if (!(await pathExists(join(options.projectRoot, ref.path)))) {
						diagnostics.push({
							severity: "error",
							rule: "verified-by-test-missing",
							file: "spec.md",
							line: requirement.line,
							message: `${requirement.id} is verified by test file "${ref.path}", which does not exist (paths are relative to the project root)`,
						});
					}
				}
			}
		}
	}

	if (documents.design !== undefined) diagnostics.push(...lintDesign(documents.design));

	diagnostics.sort((a, b) => (a.file === b.file ? (a.line ?? 0) - (b.line ?? 0) : a.file < b.file ? -1 : 1));
	const errors = diagnostics.filter((d) => d.severity === "error").length;
	return { diagnostics, errors, warnings: diagnostics.length - errors, spec };
}

export async function readDocuments(directory: string): Promise<CharterDocuments> {
	const [brief, spec, design] = await Promise.all([
		readTextIfExists(join(directory, "brief.md")),
		readTextIfExists(join(directory, "spec.md")),
		readTextIfExists(join(directory, "design.md")),
	]);
	return { brief, spec, design };
}

export function formatDiagnostics(diagnostics: Diagnostic[], limit = 40): string {
	if (diagnostics.length === 0) return "No problems found.";
	const lines = diagnostics.slice(0, limit).map((d) => `${d.severity === "error" ? "error" : "warn "} ${d.file}${d.line ? `:${d.line}` : ""} [${d.rule}] ${d.message}`);
	if (diagnostics.length > limit) lines.push(`... and ${diagnostics.length - limit} more`);
	return lines.join("\n");
}

/** Criterion ids in natural order: the canonical list every report must cover. */
export function criterionIds(spec: ParsedSpec): string[] {
	return [...new Set(spec.criteria.map((criterion) => criterion.id))].sort(compareIds);
}
