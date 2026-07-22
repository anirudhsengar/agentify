import { Value } from "typebox/value";
import { EngagementError } from "./errors.ts";
import { QualificationInputSchema, type QualificationInput, type QualificationReasonCode, type QualificationResult } from "./schema/qualification.ts";

export function qualifyEngagement(engagementId: string, value: unknown): QualificationResult {
  if (!Value.Check(QualificationInputSchema, value)) throw new EngagementError("invalid_artifact", "qualification input failed schema validation");
  const input: QualificationInput = value;
  const reasons: Array<{ code: QualificationReasonCode; blocking: boolean }> = [];
  const add = (condition: boolean, code: QualificationReasonCode, blocking = true): void => { if (condition) reasons.push({ code, blocking }); };
  add(input.workflow_owner_id === null, "missing_workflow_owner");
  add(!input.problem_statement_clear, "unclear_problem_statement", false);
  add(!input.measurable_outcome_defined, "missing_measurable_outcome");
  add(input.workflow_evidence_count === 0, "missing_workflow_evidence", false);
  add(!input.task_frequency_sufficient && !input.strategic_justification, "insufficient_frequency_or_strategy");
  add(!input.data_accessible, "data_inaccessible");
  add(!input.technically_feasible, "technical_infeasibility");
  add(!input.evaluation_feasible, "evaluation_infeasibility");
  add(!input.risk_acceptable && !input.human_control_defined, "unacceptable_uncontrolled_risk");
  add(input.adoption_owner_id === null, "missing_adoption_owner");
  add(input.unresolved_prohibited_conditions.length > 0, "unresolved_prohibited_condition");
  const hardReject = reasons.some(({ code }) => ["data_inaccessible", "technical_infeasibility", "unacceptable_uncontrolled_risk", "unresolved_prohibited_condition"].includes(code));
  const insufficient = reasons.some(({ code }) => ["unclear_problem_statement", "missing_workflow_evidence"].includes(code));
  const status = hardReject ? "rejected" : insufficient ? "insufficient_evidence" : reasons.length > 0 ? "conditionally_qualified" : "qualified";
  return { schema_version: "1", engagement_id: engagementId, status, reasons };
}
