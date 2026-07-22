import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ConfidenceSchema, EvidenceReferencesSchema, NonEmptyStringSchema, StableIdSchema } from "./primitives.ts";

export const AutomationModeSchema = StringEnum([
  "unchanged", "deterministic_software", "rules_engine", "traditional_ml", "llm_classification",
  "llm_generation", "agentic_execution", "human_decision", "human_approval", "prohibited",
] as const);

export const AutomationDecisionSchema = Type.Object({
  decision_id: StableIdSchema, workflow_id: StableIdSchema, step_id: StableIdSchema,
  mode: AutomationModeSchema,
  rationale: NonEmptyStringSchema,
  simpler_approaches_rejected: Type.Array(NonEmptyStringSchema, { maxItems: 20 }),
  failure_impact: NonEmptyStringSchema,
  reversibility: NonEmptyStringSchema,
  human_control_checkpoint: Type.Union([NonEmptyStringSchema, Type.Null()]),
  fallback: NonEmptyStringSchema,
  required_evidence: EvidenceReferencesSchema,
  maximum_cost_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  confidence: ConfidenceSchema,
  uncertainty: Type.Array(NonEmptyStringSchema, { maxItems: 50 }),
  approval_owner_id: StableIdSchema,
  security_restrictions: Type.Array(NonEmptyStringSchema, { maxItems: 100 }),
}, { additionalProperties: false });

export const AutomationDecisionRegisterSchema = Type.Object({
  schema_version: Type.Literal("1"), engagement_id: StableIdSchema,
  decisions: Type.Array(AutomationDecisionSchema, { maxItems: 1_000 }),
}, { additionalProperties: false });

export type AutomationDecision = Static<typeof AutomationDecisionSchema>;
export type AutomationDecisionRegister = Static<typeof AutomationDecisionRegisterSchema>;
