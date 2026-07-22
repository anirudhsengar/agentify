import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const AUTONOMY_LEVELS = ["observe", "draft", "approved_execute", "bounded_auto", "policy_auto"] as const;
export const AutonomyLevelSchema = StringEnum(AUTONOMY_LEVELS, { description: "Ordered FDE autonomy level; representation does not imply runtime support." });
export const PromotionDecisionSchema = StringEnum(["approved", "rejected", "insufficient_evidence", "expired", "revoked"] as const);

const NonEmpty = Type.String({ minLength: 1, maxLength: 4000 });
const Timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" });
const OptionalLimit = Type.Optional(Type.Number({ minimum: 0 }));
export const PromotionConditionsSchema = Type.Object({
  minimum_eligible_tasks: Type.Optional(Type.Integer({ minimum: 1 })),
  minimum_pass_at_1: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  minimum_repeated_run_consistency: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  maximum_major_rework_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  maximum_forbidden_action_failures: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  maximum_security_failures: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  maximum_cost_usd: OptionalLimit,
  maximum_runtime_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  required_human_reviews: Type.Optional(Type.Integer({ minimum: 0 })),
  required_business_owner: Type.Optional(NonEmpty), required_technical_owner: Type.Optional(NonEmpty),
  required_rollback_test: Type.Optional(Type.Literal(true)), required_escalation_test: Type.Optional(Type.Literal(true)),
  required_monitoring: Type.Optional(Type.Literal(true)), required_risk_register_status: Type.Optional(NonEmpty),
  required_approval_checkpoint: Type.Optional(Type.Literal(true)), no_unresolved_critical_risks: Type.Optional(Type.Literal(true)),
}, { additionalProperties: false, description: "Engagement-specific promotion conditions. Omitted thresholds remain missing, never implicitly passing." });

export const PromotionActualsSchema = Type.Object({
  eligible_tasks: Type.Optional(Type.Integer({ minimum: 0 })), pass_at_1: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  repeated_run_consistency: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), major_rework_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  forbidden_action_failures: Type.Optional(Type.Integer({ minimum: 0 })), security_failures: Type.Optional(Type.Integer({ minimum: 0 })),
  cost_usd: OptionalLimit, runtime_ms: Type.Optional(Type.Integer({ minimum: 0 })), human_reviews: Type.Optional(Type.Integer({ minimum: 0 })),
  business_owner: Type.Optional(NonEmpty), technical_owner: Type.Optional(NonEmpty), rollback_test_passed: Type.Optional(Type.Boolean()),
  escalation_test_passed: Type.Optional(Type.Boolean()), monitoring_active: Type.Optional(Type.Boolean()), risk_register_status: Type.Optional(NonEmpty),
  approval_checkpoint_passed: Type.Optional(Type.Boolean()), unresolved_critical_risks: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

export const PromotionPolicySchema = Type.Object({
  schema_version: Type.Literal("1"), policy_version: NonEmpty, engagement_id: NonEmpty, workflow_id: NonEmpty,
  execution_policy_mode: StringEnum(["audit-readonly", "review-readonly", "repository-write", "orchestrator"] as const, { description: "Existing execution-policy mode this promotion evaluates; promotion never widens it." }),
  current_level: AutonomyLevelSchema, candidate_level: AutonomyLevelSchema, requested_by: NonEmpty,
  evidence_run_ids: Type.Array(NonEmpty, { minItems: 1, maxItems: 100, uniqueItems: true }),
  required_conditions: PromotionConditionsSchema, expires_at: Type.Optional(Timestamp), review_at: Type.Optional(Timestamp), rollback_level: AutonomyLevelSchema,
}, { additionalProperties: false });

export const PromotionRecordSchema = Type.Object({
  record_id: NonEmpty, engagement_id: NonEmpty, workflow_id: NonEmpty, current_level: AutonomyLevelSchema, candidate_level: AutonomyLevelSchema,
  requested_by: NonEmpty, approved_by: Type.Union([NonEmpty, Type.Null()]), timestamp: Timestamp,
  evidence_run_ids: Type.Array(NonEmpty, { maxItems: 100, uniqueItems: true }), required_conditions: PromotionConditionsSchema,
  actual_condition_results: PromotionActualsSchema, decision: PromotionDecisionSchema,
  reasons: Type.Array(NonEmpty, { minItems: 1, maxItems: 100 }), expires_at: Type.Union([NonEmpty, Type.Null()]),
  review_at: Type.Union([NonEmpty, Type.Null()]), rollback_level: AutonomyLevelSchema, policy_version: NonEmpty,
  passed_requirements: Type.Array(NonEmpty), failed_requirements: Type.Array(NonEmpty), missing_evidence: Type.Array(NonEmpty), safety_blockers: Type.Array(NonEmpty),
}, { additionalProperties: false });

export const PromotionStateSchema = Type.Object({ schema_version: Type.Literal("1"), revision: Type.Integer({ minimum: 1 }), engagement_id: NonEmpty, policy: PromotionPolicySchema, records: Type.Array(PromotionRecordSchema) }, { additionalProperties: false });
export type AutonomyLevel = Static<typeof AutonomyLevelSchema>;
export type PromotionConditions = Static<typeof PromotionConditionsSchema>;
export type PromotionActuals = Static<typeof PromotionActualsSchema>;
export type PromotionPolicy = Static<typeof PromotionPolicySchema>;
export type PromotionRecord = Static<typeof PromotionRecordSchema>;
export type PromotionState = Static<typeof PromotionStateSchema>;
