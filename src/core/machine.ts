/**
 * The workflow as a pure function: (stage, event, config) -> next stage.
 * No I/O happens here, which keeps every legal and illegal move unit-testable.
 */

import type { CharterConfig } from "./config.ts";
import { CharterError, type Stage } from "./types.ts";

export type WorkflowEvent =
	| { type: "approve" }
	| { type: "implemented" }
	| { type: "blocked" }
	| { type: "answered"; revise: boolean }
	| { type: "gate-passed" }
	| { type: "gate-repair" }
	| { type: "gate-escalated" }
	| { type: "audit-clean" }
	| { type: "audit-findings" }
	| { type: "triaged"; outcome: "waived" | "fix" | "revise"; origin: "gate" | "audit" }
	| { type: "refined" }
	| { type: "skip" }
	| { type: "reopen" };

/** Where the work goes once the audit question is settled. */
export function afterAudit(config: CharterConfig): Stage {
	return config.roles.refiner.enabled ? "refine" : "done";
}

/** Where the work goes once the checks question is settled. */
export function afterGate(config: CharterConfig): Stage {
	return config.roles.auditor.enabled ? "audit" : afterAudit(config);
}

export function afterImplementation(config: CharterConfig): Stage {
	return config.checks.length > 0 ? "gate" : afterGate(config);
}

const ALLOWED_FROM: Record<WorkflowEvent["type"], readonly Stage[]> = {
	approve: ["drafting"],
	implemented: ["implement"],
	blocked: ["implement"],
	answered: ["questions"],
	"gate-passed": ["gate"],
	"gate-repair": ["gate"],
	"gate-escalated": ["gate"],
	"audit-clean": ["audit"],
	"audit-findings": ["audit"],
	triaged: ["triage"],
	refined: ["refine"],
	skip: ["gate", "audit", "refine"],
	reopen: ["implement", "questions", "gate", "audit", "triage", "refine", "done"],
};

export function transition(stage: Stage, event: WorkflowEvent, config: CharterConfig): Stage {
	if (!ALLOWED_FROM[event.type].includes(stage)) {
		throw new CharterError(
			`"${event.type}" is not possible while the charter is at stage "${stage}" (allowed from: ${ALLOWED_FROM[event.type].join(", ")}).`,
		);
	}
	switch (event.type) {
		case "approve":
			return config.roles.implementer.enabled ? "implement" : "done";
		case "implemented":
			return afterImplementation(config);
		case "blocked":
			return "questions";
		case "answered":
			return event.revise ? "drafting" : "implement";
		case "gate-passed":
			return afterGate(config);
		case "gate-repair":
			return "implement";
		case "gate-escalated":
			return "triage";
		case "audit-clean":
			return afterAudit(config);
		case "audit-findings":
			return "triage";
		case "triaged":
			if (event.outcome === "revise") return "drafting";
			if (event.outcome === "fix") return "implement";
			return event.origin === "gate" ? afterGate(config) : afterAudit(config);
		case "refined":
			return "done";
		case "skip":
			if (stage === "gate") return afterGate(config);
			if (stage === "audit") return afterAudit(config);
			return "done";
		case "reopen":
			return "drafting";
	}
}

/** Stages in which the pipeline can make progress without the developer. */
export function isRunnable(stage: Stage): boolean {
	return stage === "implement" || stage === "gate" || stage === "audit" || stage === "refine";
}

/** Stages that wait for a developer decision. */
export function isWaiting(stage: Stage): boolean {
	return stage === "drafting" || stage === "questions" || stage === "triage";
}

/** Documents are frozen from approval until the charter is reopened. */
export function isFrozen(stage: Stage): boolean {
	return stage !== "drafting";
}
