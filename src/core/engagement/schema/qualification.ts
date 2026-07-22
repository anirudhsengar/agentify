import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { StableIdSchema } from "./primitives.ts";

export const QualificationStatusSchema = StringEnum([
  "qualified", "conditionally_qualified", "insufficient_evidence", "rejected",
] as const);
export const QualificationReasonCodeSchema = StringEnum([
  "missing_workflow_owner", "unclear_problem_statement", "missing_measurable_outcome", "missing_workflow_evidence",
  "insufficient_frequency_or_strategy", "data_inaccessible", "technical_infeasibility", "evaluation_infeasibility",
  "unacceptable_uncontrolled_risk", "missing_adoption_owner", "unresolved_prohibited_condition",
] as const);
export const QualificationInputSchema = Type.Object({
  workflow_owner_id: Type.Union([StableIdSchema, Type.Null()]), problem_statement_clear: Type.Boolean(),
  measurable_outcome_defined: Type.Boolean(), workflow_evidence_count: Type.Integer({ minimum: 0 }),
  task_frequency_sufficient: Type.Boolean(), strategic_justification: Type.Boolean(), data_accessible: Type.Boolean(),
  technically_feasible: Type.Boolean(), evaluation_feasible: Type.Boolean(), risk_acceptable: Type.Boolean(),
  human_control_defined: Type.Boolean(), adoption_owner_id: Type.Union([StableIdSchema, Type.Null()]),
  unresolved_prohibited_conditions: Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }),
}, { additionalProperties: false });
export const QualificationResultSchema = Type.Object({
  schema_version: Type.Literal("1"), engagement_id: StableIdSchema, status: QualificationStatusSchema,
  reasons: Type.Array(Type.Object({ code: QualificationReasonCodeSchema, blocking: Type.Boolean() }, { additionalProperties: false })),
}, { additionalProperties: false });
export type QualificationInput = Static<typeof QualificationInputSchema>;
export type QualificationResult = Static<typeof QualificationResultSchema>;
export type QualificationReasonCode = Static<typeof QualificationReasonCodeSchema>;
