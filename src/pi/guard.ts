/**
 * Keeps the coordinating model's file tools away from approved documents and
 * from the files the pipeline owns.
 */

import { relative, sep } from "node:path";

import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

import { isWithin, resolveToolPath } from "../core/fsx.ts";
import { DOCUMENT_NAMES, isCharterId } from "../core/store.ts";
import type { CharterSession } from "./session.ts";

/** File tools that write, and the argument that names their target. */
export const WRITE_TOOLS: Readonly<Record<string, string>> = { write: "path", edit: "path" };

export async function guardWrite(session: CharterSession, event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
	const argument = WRITE_TOOLS[event.toolName];
	if (!argument) return undefined;
	const raw = (event.input as Record<string, unknown>)[argument];
	if (typeof raw !== "string") return undefined;

	const engine = await session.engine(ctx);
	const target = resolveToolPath(ctx.cwd, raw);
	if (!isWithin(engine.store.root, target)) return undefined;
	const [id, ...rest] = relative(engine.store.root, target).split(sep);
	if (!id || !isCharterId(id) || rest.length === 0) return undefined;

	const file = rest.join("/");
	const isDocument = (DOCUMENT_NAMES as readonly string[]).includes(file) || file.startsWith("attachments/");
	if (!isDocument) {
		return { block: true, reason: `${file} is maintained by the Charter pipeline and must not be edited. Use the charter_* tools to change the workflow.` };
	}
	let stage: string;
	try {
		stage = (await engine.store.charter(id).load()).stage;
	} catch {
		return undefined;
	}
	if (stage !== "drafting") {
		return {
			block: true,
			reason: `Charter ${id} was approved and its documents are frozen (stage "${stage}"). If the contract must change, the developer has to run /charter reopen, or decide "revise" on an open question or finding.`,
		};
	}
	return undefined;
}
