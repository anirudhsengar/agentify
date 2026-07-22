import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { EvidenceReferencesSchema, ScoreSchema, StableIdSchema } from "./primitives.ts";

export const OpportunityRecommendationSchema = StringEnum([
  "reject", "defer", "investigate", "pilot", "prioritize",
] as const);

export const OpportunityCandidateSchema = Type.Object({
  opportunity_id: StableIdSchema,
  workflow_id: StableIdSchema,
  step_id: Type.Union([StableIdSchema, Type.Null()]),
  business_value: ScoreSchema,
  volume: ScoreSchema,
  feasibility: ScoreSchema,
  risk: ScoreSchema,
  adoption_readiness: ScoreSchema,
  evaluation_feasibility: ScoreSchema,
  reversibility: ScoreSchema,
  data_availability: ScoreSchema,
  integration_availability: ScoreSchema,
  implementation_complexity: ScoreSchema,
  supplied_roi: Type.Optional(Type.Object({ value: Type.Number(), unit: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false })),
  recommendation: Type.Optional(OpportunityRecommendationSchema),
  evidence: EvidenceReferencesSchema,
  rejection_reason: Type.Union([Type.String({ minLength: 1, maxLength: 4_000 }), Type.Null()]),
}, { additionalProperties: false });

export const OpportunityScoreBreakdownSchema = Type.Object({
  weighted_value_score: ScoreSchema,
  risk_score: ScoreSchema,
  risk_penalty: Type.Number({ minimum: 0, maximum: 25 }),
  final_score: ScoreSchema,
  contributions: Type.Object({
    business_value: Type.Number(), volume: Type.Number(), feasibility: Type.Number(),
    adoption_readiness: Type.Number(), evaluation_feasibility: Type.Number(), reversibility: Type.Number(),
    data_availability: Type.Number(), integration_availability: Type.Number(), implementation_simplicity: Type.Number(),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const ScoredOpportunitySchema = Type.Object({
  candidate: OpportunityCandidateSchema,
  score: OpportunityScoreBreakdownSchema,
  recommendation: OpportunityRecommendationSchema,
  recommendation_reasons: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
}, { additionalProperties: false });

export const OpportunityMatrixSchema = Type.Object({
  schema_version: Type.Literal("1"), engagement_id: StableIdSchema,
  opportunities: Type.Array(ScoredOpportunitySchema, { maxItems: 1_000 }),
}, { additionalProperties: false });

export type OpportunityCandidate = Static<typeof OpportunityCandidateSchema>;
export type ScoredOpportunity = Static<typeof ScoredOpportunitySchema>;
export type OpportunityMatrix = Static<typeof OpportunityMatrixSchema>;
