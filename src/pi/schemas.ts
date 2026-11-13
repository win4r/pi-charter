/**
 * Everything Pi needs at startup to know this extension exists: tool
 * declarations and the command's subcommand list. Deliberately free of any
 * import from the engine, so an installed-but-unused Charter costs a session
 * almost nothing; the implementation is loaded on first use.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";

export const STATUS_KEY = "charter";
export const ENTRY_TYPE = "pi-charter";

export const TOOL_NAMES = ["charter_new", "charter_lint", "charter_approve", "charter_advance", "charter_resolve", "charter_status"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolSpec {
	name: ToolName;
	label: string;
	description: string;
	promptSnippet: string;
	parameters: TSchema;
	/** Tools that change the workflow must not run concurrently with each other. */
	sequential: boolean;
}

const NONE = Type.Object({});

export const TOOL_SPECS: readonly ToolSpec[] = [
	{
		name: "charter_new",
		label: "New charter",
		description:
			"Create a new charter (brief.md and spec.md from templates) for one change and make it the active charter. " +
			"Call this once the developer has described the change. Afterwards fill in the documents together with the developer.",
		promptSnippet: "Create a charter (brief + spec) for one change",
		parameters: Type.Object({ title: Type.String({ description: 'Short title of the change, e.g. "CSV export for reports"' }) }),
		sequential: true,
	},
	{
		name: "charter_lint",
		label: "Lint charter",
		description:
			"Check the active charter's documents against the charter rules (structure, traceability, measurable criteria, leftover placeholders). " +
			"Errors block approval. Run it after editing the documents and before asking for approval.",
		promptSnippet: "Check the active charter's documents",
		parameters: NONE,
		sequential: false,
	},
	{
		name: "charter_approve",
		label: "Approve charter",
		description:
			"Ask the developer to approve the active charter. The developer confirms in a dialog; you cannot approve on their behalf. " +
			"On approval the documents are frozen and the pipeline runs (implementation, checks, audit, refinement as configured) until it finishes or needs a decision. " +
			"Call this only after charter_lint reports no errors and the developer has read the documents.",
		promptSnippet: "Request the developer's approval and start the pipeline",
		parameters: NONE,
		sequential: true,
	},
	{
		name: "charter_advance",
		label: "Advance charter",
		description:
			"Continue the active charter's pipeline from its current stage: runs every step that needs no developer input and stops when the work is done or a decision is required. " +
			"Use it to resume after an interruption or a failed run.",
		promptSnippet: "Continue the active charter's pipeline",
		parameters: NONE,
		sequential: true,
	},
	{
		name: "charter_resolve",
		label: "Record decisions",
		description:
			"Record the developer's decisions for every open implementer question or audit/check finding of the active charter, in one call. " +
			"Decisions must be the developer's own; the developer confirms them in a dialog (without a dialog, they record them with /charter decide). Afterwards the pipeline continues automatically when it can.",
		promptSnippet: "Record the developer's decisions on open questions or findings",
		parameters: Type.Object({
			decisions: Type.Array(
				Type.Object({
					ref: Type.String({ description: "Item reference, e.g. impl-1/Q1 or audit-2/F3" }),
					decision: StringEnum(["answer", "fix", "waive", "revise"] as const, {
						description: 'Questions: "answer" (spec unchanged) or "revise" (spec must change). Findings: "fix", "waive" or "revise".',
					}),
					text: Type.String({ description: "The developer's answer (questions) or reason (findings), in their words." }),
				}),
				{ minItems: 1 },
			),
		}),
		sequential: true,
	},
	{
		name: "charter_status",
		label: "Charter status",
		description: "Show the active charter's stage, what happened so far, anything waiting for a decision, and the next step. Use it to re-orient after an interruption.",
		promptSnippet: "Show the active charter's stage and next step",
		parameters: NONE,
		sequential: false,
	},
];

export const SUBCOMMANDS: ReadonlyArray<readonly [name: string, help: string]> = [
	["on", "turn Charter mode on"],
	["off", "turn Charter mode off (files are kept)"],
	["new", "<title> — create a charter and make it active"],
	["resume", "[id] — make an existing charter active"],
	["list", "list charters and their stages"],
	["status", "show the active charter's stage and next step"],
	["lint", "check the active charter's documents"],
	["approve", "[id] — approve the charter and start the pipeline"],
	["decide", "<ref> <decision> <text> [; ...] — record your decisions on open questions or findings"],
	["go", "continue the pipeline (grants one more cycle if the budget is spent)"],
	["reopen", "return an approved charter to drafting"],
	["skip", "[reason] — skip the pending checks, audit or refinement"],
	["rollback", "[checkpoint] — restore project files to a checkpoint and reopen"],
	["prune", "[id] — delete the git checkpoints of a finished charter"],
	["log", "[n] — show the last n journal events"],
	["report", "show the final report"],
	["setup", "choose models, phases and checks interactively"],
	["doctor", "verify configuration, models, git and checks"],
	["help", "show this list"],
];

/** Mode of the current session. Lives in the startup module; the lazily loaded runtime shares it. */
export interface Mode {
	enabled: boolean;
	activeId: string | null;
	/** Serialized form last written to the session, to avoid duplicate entries. */
	saved: string;
}
