/**
 * A single-pass, allocation-light parser for `spec.md`.
 *
 * It understands just enough Markdown to recover the contract: requirement
 * headings (`R1: ...`), acceptance-criterion headings (`AC1: ...`), their
 * fields, clauses and examples. Fenced code is never interpreted as structure.
 */

export type RequirementChange = "added" | "modified" | "removed";

export type VerifyRef =
	| { kind: "criterion"; id: string }
	| { kind: "test"; path: string; scenario?: string };

export interface SpecRequirement {
	id: string;
	title: string;
	line: number;
	level: number;
	/** Raw value of the `Change:` field, lower-cased. */
	change?: string;
	was?: string;
	verifiedBy: VerifyRef[];
	/** Tokens of `Verified by:` that could not be understood. */
	unparsedRefs: string[];
	/** Criteria defined directly under this requirement. */
	nested: string[];
}

export interface SpecCriterion {
	id: string;
	title: string;
	line: number;
	/** Parent requirement id, when nested under one. */
	requirement?: string;
	/** True when defined under a "Regression checks" section. */
	regression: boolean;
	given: string[];
	when: string[];
	then: string[];
	hasExample: boolean;
}

export interface SpecPlaceholder {
	line: number;
	text: string;
}

export interface ParsedSpec {
	title?: string;
	requirements: SpecRequirement[];
	criteria: SpecCriterion[];
	assumptions: string[];
	placeholders: SpecPlaceholder[];
	/** Level-2 section titles in document order, lower-cased. */
	sections: string[];
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/;
const REQUIREMENT_HEADING = /^R(\d+)\s*[:.]\s*(.*)$/;
const CRITERION_HEADING = /^AC(\d+)\s*[:.]\s*(.*)$/;
const FENCE = /^\s{0,3}(```+|~~~+)/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const FIELD = /^(change|was|verified by)\s*:\s*(.*)$/i;
const CLAUSE = /^(given|when|then|and|but)\b[\s:,]*(.*)$/i;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const EXAMPLE_LABEL = /^examples?\s*[:.]?\s*(.*)$/i;
const PLACEHOLDER = /\{\{[^}]*\}\}|\bTBD\b|\bTODO\b|\[NEEDS CLARIFICATION[^\]]*\]|\?\?\?/;

/**
 * True when a line still carries a template placeholder or an open marker.
 * Inline code is ignored, so a spec can mention `TODO` literally by quoting it.
 */
export function hasPlaceholder(line: string): boolean {
	return PLACEHOLDER.test(line.includes("`") ? line.replace(/`[^`]*`/g, "") : line);
}

/** Drop list markers and emphasis wrappers so `- **GIVEN** x` reads as `GIVEN x`. */
function plain(line: string): string {
	return line
		.replace(BULLET, "")
		.replace(/^\s+/, "")
		.replace(/^(\*\*|__)(.+?)\1/, "$2")
		.replace(/^(\*|_)(.+?)\1/, "$2")
		.trim();
}

export function parseVerifiedBy(value: string): { refs: VerifyRef[]; unparsed: string[] } {
	const refs: VerifyRef[] = [];
	const unparsed: string[] = [];
	// Split on commas/semicolons that are not inside quotes, so scenario names may contain them.
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of value) {
		if (quote) {
			if (char === quote) quote = undefined;
			current += char;
		} else if (char === '"' || char === "`") {
			quote = char;
			current += char;
		} else if (char === "," || char === ";") {
			tokens.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	tokens.push(current);

	for (const rawToken of tokens) {
		const token = rawToken.trim();
		if (token === "") continue;
		// `[AC1](#anchor)` and plain `AC1`.
		const criterion = /^\[?(AC\d+)\]?(?:\([^)]*\))?$/.exec(token);
		if (criterion?.[1]) {
			refs.push({ kind: "criterion", id: criterion[1] });
			continue;
		}
		// `test: path/to/file.test.ts > "scenario name"` (scenario optional).
		const test = /^test\s*:\s*`?([^`>#"]+?)`?\s*(?:(?:>|#)\s*["`]?(.+?)["`]?)?$/i.exec(token);
		if (test?.[1]) {
			const scenario = test[2]?.trim();
			refs.push(scenario ? { kind: "test", path: test[1].trim(), scenario } : { kind: "test", path: test[1].trim() });
			continue;
		}
		unparsed.push(token);
	}
	return { refs, unparsed };
}

export function parseSpec(markdown: string): ParsedSpec {
	const spec: ParsedSpec = { requirements: [], criteria: [], assumptions: [], placeholders: [], sections: [] };
	const lines = markdown.split(/\r?\n/);

	let fence: string | undefined;
	let requirement: SpecRequirement | undefined;
	let criterion: SpecCriterion | undefined;
	let criterionLevel = 0;
	let section = "";
	let lastClause: string[] | undefined;
	let exampleLabelOpen = false;
	let tableHeaderSeen = false;
	let tableRuleSeen = false;

	const closeCriterion = (): void => {
		criterion = undefined;
		lastClause = undefined;
		exampleLabelOpen = false;
		tableHeaderSeen = false;
		tableRuleSeen = false;
	};

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const lineNumber = index + 1;

		const fenceMatch = FENCE.exec(line);
		if (fence) {
			if (fenceMatch?.[1] && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined;
			continue;
		}
		if (fenceMatch?.[1]) {
			fence = fenceMatch[1];
			// A fenced block inside a criterion is a concrete example.
			if (criterion) criterion.hasExample = true;
			continue;
		}

		if (hasPlaceholder(line)) spec.placeholders.push({ line: lineNumber, text: line.trim() });

		const heading = HEADING.exec(line);
		if (heading?.[1] && heading[2] !== undefined) {
			const level = heading[1].length;
			const text = heading[2].trim();

			if (level === 1 && spec.title === undefined) spec.title = text;
			if (requirement && level <= requirement.level) requirement = undefined;
			if (criterion && level <= criterionLevel) closeCriterion();
			if (level <= 2) {
				section = level === 2 ? text.toLowerCase() : "";
				if (level === 2) spec.sections.push(section);
			}

			const requirementMatch = REQUIREMENT_HEADING.exec(text);
			if (requirementMatch?.[1]) {
				closeCriterion();
				requirement = {
					id: `R${Number(requirementMatch[1])}`,
					title: (requirementMatch[2] ?? "").trim(),
					line: lineNumber,
					level,
					verifiedBy: [],
					unparsedRefs: [],
					nested: [],
				};
				spec.requirements.push(requirement);
				continue;
			}

			const criterionMatch = CRITERION_HEADING.exec(text);
			if (criterionMatch?.[1]) {
				closeCriterion();
				const parent = requirement && level > requirement.level ? requirement : undefined;
				criterion = {
					id: `AC${Number(criterionMatch[1])}`,
					title: (criterionMatch[2] ?? "").trim(),
					line: lineNumber,
					regression: section.startsWith("regression"),
					given: [],
					when: [],
					then: [],
					hasExample: false,
				};
				if (parent) {
					criterion.requirement = parent.id;
					parent.nested.push(criterion.id);
				}
				criterionLevel = level;
				spec.criteria.push(criterion);
				continue;
			}

			closeCriterion();
			continue;
		}

		if (line.trim() === "") {
			lastClause = undefined;
			continue;
		}

		const text = plain(line);

		if (criterion) {
			const clause = CLAUSE.exec(text);
			if (clause?.[1] && BULLET.test(line)) {
				const keyword = clause[1].toLowerCase();
				const body = (clause[2] ?? "").trim();
				if (keyword === "given") lastClause = criterion.given;
				else if (keyword === "when") lastClause = criterion.when;
				else if (keyword === "then") lastClause = criterion.then;
				// AND/BUT extend whichever clause came before.
				if (lastClause && body !== "") lastClause.push(body);
				exampleLabelOpen = false;
				continue;
			}

			if (TABLE_ROW.test(line) || TABLE_RULE.test(line)) {
				if (TABLE_RULE.test(line) && tableHeaderSeen) tableRuleSeen = true;
				else if (tableRuleSeen) criterion.hasExample = true;
				else tableHeaderSeen = true;
				continue;
			}
			tableHeaderSeen = false;
			tableRuleSeen = false;

			const example = EXAMPLE_LABEL.exec(text);
			if (example) {
				if ((example[1] ?? "").trim() !== "") criterion.hasExample = true;
				else exampleLabelOpen = true;
				continue;
			}
			if (exampleLabelOpen) {
				criterion.hasExample = true;
				exampleLabelOpen = false;
			}
			continue;
		}

		if (requirement) {
			const field = FIELD.exec(text);
			if (field?.[1]) {
				const name = field[1].toLowerCase();
				const value = (field[2] ?? "").trim();
				if (name === "change") requirement.change = value.toLowerCase().replace(/[`*_.]/g, "");
				else if (name === "was") requirement.was = value;
				else {
					const parsed = parseVerifiedBy(value);
					requirement.verifiedBy.push(...parsed.refs);
					requirement.unparsedRefs.push(...parsed.unparsed);
				}
			}
			continue;
		}

		if (section.startsWith("assumption") && BULLET.test(line)) {
			spec.assumptions.push(text);
		}
	}

	return spec;
}

/** Natural ordering for ids such as AC2 < AC10. */
export function compareIds(a: string, b: string): number {
	const left = /^([A-Za-z]+)(\d+)$/.exec(a);
	const right = /^([A-Za-z]+)(\d+)$/.exec(b);
	if (left?.[1] && right?.[1] && left[1] === right[1]) return Number(left[2]) - Number(right[2]);
	return a < b ? -1 : a > b ? 1 : 0;
}
