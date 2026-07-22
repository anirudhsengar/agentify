import { Value } from "typebox/value";
import { EngagementError } from "./errors.ts";
import { AutomationDecisionSchema, type AutomationDecision } from "./schema/automation-decision.ts";

const AI_MODES = new Set(["traditional_ml", "llm_classification", "llm_generation", "agentic_execution"]);
export function validateAutomationDecision(value: unknown): AutomationDecision {
  if (!Value.Check(AutomationDecisionSchema, value)) throw new EngagementError("invalid_artifact", "automation decision failed schema validation");
  if (AI_MODES.has(value.mode) && value.simpler_approaches_rejected.length === 0) {
    throw new EngagementError("invalid_artifact", "AI decisions must explain why simpler approaches were rejected");
  }
  if ((value.mode === "agentic_execution" || value.mode === "human_approval") && value.human_control_checkpoint === null) {
    throw new EngagementError("invalid_artifact", `${value.mode} requires a human-control checkpoint`);
  }
  if (value.mode === "prohibited" && value.human_control_checkpoint !== null) {
    throw new EngagementError("invalid_artifact", "prohibited automation cannot define an execution checkpoint");
  }
  return value;
}
