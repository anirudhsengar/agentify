import { Value } from "typebox/value";
import { EngagementError } from "./errors.ts";
import { WorkflowMapSchema, type WorkflowMap } from "./schema/workflow-map.ts";

export function validateWorkflowMap(value: unknown): WorkflowMap {
  if (!Value.Check(WorkflowMapSchema, value)) throw new EngagementError("invalid_artifact", "workflow map failed schema validation");
  const stepIds = new Set<string>();
  for (const step of value.steps) {
    if (stepIds.has(step.step_id)) throw new EngagementError("duplicate_id", `duplicate workflow step ID: ${step.step_id}`);
    stepIds.add(step.step_id);
  }
  for (const step of value.steps) {
    for (const target of step.handoff_to_step_ids) {
      if (!stepIds.has(target)) throw new EngagementError("invalid_reference", `step ${step.step_id} references missing handoff step ${target}`);
    }
  }
  return value;
}
