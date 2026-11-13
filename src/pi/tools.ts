/**
 * Tools the coordinating model uses in the main session. Every state change
 * goes through the engine; the model cannot move the workflow by editing files.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { describeRole, enabledRoles } from "../core/config.ts";
import type { DecisionInput } from "../core/decisions.ts";
import { formatDiagnostics } from "../core/spec/lint.ts";
import { describeStatus, statusLine } from "../core/summary.ts";
import type { ApprovalPreview, Engine } from "../engine/pipeline.ts";
import { ProgressView } from "./progress.ts";
import { STATUS_KEY, type ToolName } from "./schemas.ts";
import type { CharterSession } from "./session.ts";

export type Result = AgentToolResult<undefined>;
type Update = AgentToolUpdateCallback<undefined> | undefined;
type Executor = (session: CharterSession, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: Update, ctx: ExtensionContext) => Promise<Result>;

const text = (value: string): Result => ({ content: [{ type: "text", text: value }], details: undefined });
const failure = (value: string): Result => ({ content: [{ type: "text", text: value }], details: undefined, isError: true });

export function approvalMessage(preview: ApprovalPreview, engine: Engine): string {
	const { lint, state, documents } = preview;
	const roles = enabledRoles(engine.config);
	const lines = [
		`"${state.title}"`,
		"",
		`Documents: ${documents.map((name) => `${engine.store.relativeRoot}/${state.id}/${name}`).join(", ")}`,
		`Contract: ${lint.spec.requirements.length} requirement(s), ${lint.spec.criteria.length} acceptance criteria`,
		lint.warnings > 0 ? `Lint: ${lint.warnings} warning(s), no errors` : "Lint: clean",
		"",
		roles.length === 0
			? "After approval: nothing runs (implementer disabled); the approved documents are the deliverable."
			: `After approval: ${roles.map((role) => describeRole(engine.config, role)).join(" -> ")}`,
		engine.config.checks.length > 0 ? `Project checks: ${engine.config.checks.map((check) => check.name).join(", ")}` : "Project checks: none configured",
		"",
		"Approving freezes these documents until the charter is reopened.",
	];
	return lines.join("\n");
}

/** Drive the pipeline as far as it goes and describe where it stopped. */
export async function runPipeline(
	session: CharterSession,
	ctx: ExtensionContext,
	engine: Engine,
	id: string,
	signal: AbortSignal | undefined,
	onUpdate: Update,
	preface?: string,
): Promise<Result> {
	const before = await engine.store.charter(id).load();
	const view = new ProgressView(
		(value) => onUpdate?.({ content: [{ type: "text", text: value }], details: undefined }),
		(step) => {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, statusLine(before, step));
		},
	);
	view.start();
	let result: Awaited<ReturnType<Engine["advance"]>>;
	try {
		result = await engine.advance(id, {
			signal,
			onStep: view.onStep,
			onActivity: view.onActivity,
			onNotice: view.onNotice,
			confirmExtraCycle: async (state) => {
				if (!ctx.hasUI) return false;
				const budget = engine.config.limits.cycles + state.cycleGrant;
				return ctx.ui.confirm(
					"Implementation budget spent",
					`Charter ${state.id} used its ${budget} implementation cycle(s) without a clean result. Allow one more cycle?`,
				);
			},
		});
	} finally {
		view.stop();
		await session.refreshStatus(ctx);
	}

	const parts: string[] = [];
	if (preface) parts.push(preface);
	if (view.collectedNotices.length > 0) parts.push(view.collectedNotices.map((notice) => `Note: ${notice}`).join("\n"));

	if (result.status === "done") {
		parts.push(
			`Charter ${id} is complete. The report below was generated from the recorded results and saved to ${engine.store.relativeRoot}/${id}/report.md.`,
			result.report.trimEnd(),
			"Present this report to the developer faithfully. Do not add claims it does not contain. Review, commits and merging are the developer's.",
		);
	} else if (result.status === "waiting") {
		if (result.waitingFor === "approval") {
			parts.push("The charter is in drafting. It needs the developer's approval before anything runs (charter_approve).");
		} else if (result.waitingFor === "answers") {
			parts.push(
				"The implementer stopped because it needs decisions that belong to the developer.",
				result.text,
				'Present every question to the developer with its options and consequences, and do not answer on their behalf. Once you have every answer, call charter_resolve with one decision per question: "answer" when the approved spec stays as it is, "revise" when the answer changes the spec.',
			);
		} else {
			parts.push(
				"There are findings that need the developer's decision.",
				result.text,
				'Present every finding to the developer with its evidence and practical effect, and do not decide on their behalf. Once you have a decision and reason for each, call charter_resolve: "fix" (implementer repairs it, spec unchanged), "waive" (accept as is), or "revise" (the spec must change).',
			);
		}
	} else {
		parts.push(`The pipeline stopped: ${result.reason}`, "Tell the developer what happened and what their options are. Do not attempt the stopped step yourself.");
		return failure(parts.join("\n\n"));
	}
	return text(parts.join("\n\n"));
}

/** Implementations of the tools declared in `schemas.ts`. */
export const TOOL_EXECUTORS: Record<ToolName, Executor> = {
	async charter_new(session, params, _signal, _onUpdate, ctx) {
		const engine = await session.engine(ctx);
		const templates = await session.templates();
		const state = await engine.create(String(params.title ?? ""), templates);
		session.setMode(true, state.id);
		await session.refreshStatus(ctx);
		const dir = `${engine.store.relativeRoot}/${state.id}`;
		return text(
			[
				`Created charter ${state.id} in ${dir}/ and made it active.`,
				`Edit ${dir}/brief.md and ${dir}/spec.md with your file tools.`,
				"Every {{placeholder}} must be replaced. Run charter_lint to check the documents; errors block approval.",
				"",
				`Create ${dir}/design.md only if a significant technical decision must be fixed before implementation. If so, use this shape:`,
				templates.design.replaceAll("{{title}}", state.title).replace(/<!--[\s\S]*?-->\n*/g, "").trim(),
			].join("\n"),
		);
	},

	async charter_lint(session, _params, _signal, _onUpdate, ctx) {
		const engine = await session.engine(ctx);
		const lint = await engine.lint(session.requireActive());
		const header = `${lint.errors} error(s), ${lint.warnings} warning(s); ${lint.spec.requirements.length} requirement(s), ${lint.spec.criteria.length} acceptance criteria.`;
		return text(lint.diagnostics.length === 0 ? `${header}\nThe documents are ready for the developer's review.` : `${header}\n${formatDiagnostics(lint.diagnostics)}`);
	},

	async charter_approve(session, _params, signal, onUpdate, ctx) {
		const engine = await session.engine(ctx);
		const id = session.requireActive();
		const preview = await engine.previewApproval(id);
		if (preview.lint.errors > 0) {
			return failure(`The documents are not ready for approval:\n${formatDiagnostics(preview.lint.diagnostics.filter((d) => d.severity === "error"))}`);
		}
		if (!ctx.hasUI) {
			return failure(`Approval has to come from the developer and this session has no dialog. Ask the developer to run: /charter approve ${id}`);
		}
		const approved = await ctx.ui.confirm(`Approve charter ${id}?`, approvalMessage(preview, engine));
		if (!approved) {
			return text("The developer did not approve. Ask what should change, revise the documents, run charter_lint, then request approval again.");
		}
		await engine.approve(id);
		return runPipeline(session, ctx, engine, id, signal, onUpdate, `The developer approved charter ${id} (revision ${preview.state.revision + 1}).`);
	},

	async charter_advance(session, _params, signal, onUpdate, ctx) {
		const engine = await session.engine(ctx);
		return runPipeline(session, ctx, engine, session.requireActive(), signal, onUpdate);
	},

	async charter_resolve(session, params, signal, onUpdate, ctx) {
		const engine = await session.engine(ctx);
		const id = session.requireActive();
		const decisions = (params.decisions ?? []) as DecisionInput[];
		if (!ctx.hasUI) {
			return failure(
				`Decisions have to come from the developer and this session has no dialog to confirm them. Ask the developer to run: /charter decide ${decisions.map((entry) => `${entry.ref} ${entry.decision} ${entry.text}`).join(" ; ")}`,
			);
		}
		const confirmed = await ctx.ui.confirm(`Record these decisions for ${id}?`, decisions.map((entry) => `${entry.ref}: ${entry.decision} — ${entry.text}`).join("\n"));
		if (!confirmed) return text("The developer did not confirm these decisions. Ask what they want instead; nothing was recorded.");
		const state = await engine.resolve(id, decisions);
		await session.refreshStatus(ctx);
		if (state.stage === "drafting") {
			return text(
				"Decisions recorded. The charter is back in drafting because the spec has to change. Revise the documents with the developer according to the recorded decisions, run charter_lint, then call charter_approve for renewed approval.",
			);
		}
		return runPipeline(session, ctx, engine, id, signal, onUpdate, "Decisions recorded.");
	},

	async charter_status(session, _params, _signal, _onUpdate, ctx) {
		const engine = await session.engine(ctx);
		const id = session.requireActive();
		const state = await engine.store.charter(id).load();
		return text(describeStatus(state, { config: engine.config, directory: engine.store.relativeRoot, pendingText: await engine.describePending(id) }));
	},
};
