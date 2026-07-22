import { Value } from "typebox/value";
import { validateAutomationDecision } from "./automation-decider.ts";
import { EngagementError } from "./errors.ts";
import { AutomationDecisionRegisterSchema, type AutomationDecisionRegister } from "./schema/automation-decision.ts";
import { OpportunityMatrixSchema, type OpportunityMatrix } from "./schema/opportunity.ts";
import { StakeholderRegisterSchema, type StakeholderRegister } from "./schema/stakeholders.ts";

function requireUnique(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new EngagementError("duplicate_id", `duplicate ${label} ID: ${id}`);
    seen.add(id);
  }
}

export function validateStakeholderRegister(value: unknown): StakeholderRegister {
  if (!Value.Check(StakeholderRegisterSchema, value)) throw new EngagementError("invalid_artifact", "stakeholder register failed schema validation");
  requireUnique(value.stakeholders.map(({ stakeholder_id }) => stakeholder_id), "stakeholder");
  const ids = new Set(value.stakeholders.map(({ stakeholder_id }) => stakeholder_id));
  for (const [field, id] of [["workflow owner", value.workflow_owner_id], ["adoption owner", value.adoption_owner_id]] as const) {
    if (!ids.has(id)) throw new EngagementError("invalid_reference", `${field} references missing stakeholder ${id}`);
  }
  return value;
}

export function validateOpportunityMatrix(value: unknown, workflowId: string, stepIds: ReadonlySet<string>): OpportunityMatrix {
  if (!Value.Check(OpportunityMatrixSchema, value)) throw new EngagementError("invalid_artifact", "opportunity matrix failed schema validation");
  requireUnique(value.opportunities.map(({ candidate }) => candidate.opportunity_id), "opportunity");
  for (const { candidate } of value.opportunities) {
    if (candidate.workflow_id !== workflowId) throw new EngagementError("invalid_reference", `opportunity ${candidate.opportunity_id} references missing workflow ${candidate.workflow_id}`);
    if (candidate.step_id !== null && !stepIds.has(candidate.step_id)) throw new EngagementError("invalid_reference", `opportunity ${candidate.opportunity_id} references missing step ${candidate.step_id}`);
  }
  return value;
}

export function validateAutomationDecisionRegister(value: unknown, workflowId: string, stepIds: ReadonlySet<string>, stakeholderIds: ReadonlySet<string>): AutomationDecisionRegister {
  if (!Value.Check(AutomationDecisionRegisterSchema, value)) throw new EngagementError("invalid_artifact", "automation decision register failed schema validation");
  requireUnique(value.decisions.map(({ decision_id }) => decision_id), "automation decision");
  for (const decision of value.decisions) {
    validateAutomationDecision(decision);
    if (decision.workflow_id !== workflowId || !stepIds.has(decision.step_id)) throw new EngagementError("invalid_reference", `automation decision ${decision.decision_id} references a missing workflow step`);
    if (!stakeholderIds.has(decision.approval_owner_id)) throw new EngagementError("invalid_reference", `automation decision ${decision.decision_id} references missing approval owner ${decision.approval_owner_id}`);
  }
  return value;
}
