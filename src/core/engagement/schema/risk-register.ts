import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { EvidenceReferencesSchema, FivePointSchema, NonEmptyStringSchema, StableIdSchema } from "./primitives.ts";

export const RiskSeveritySchema = StringEnum(["low", "moderate", "high", "critical"] as const);
export const RiskSchema = Type.Object({
  risk_id: StableIdSchema,
  category: StringEnum(["business", "operational", "technical", "security", "compliance", "adoption", "evaluation"] as const),
  description: NonEmptyStringSchema,
  likelihood: FivePointSchema, impact: FivePointSchema, severity: RiskSeveritySchema,
  mitigation: NonEmptyStringSchema, owner_id: StableIdSchema,
  status: StringEnum(["open", "mitigating", "accepted", "closed"] as const),
  detection_method: NonEmptyStringSchema, rollback_or_fallback: NonEmptyStringSchema,
  related_step_ids: Type.Array(StableIdSchema, { maxItems: 100 }), evidence: EvidenceReferencesSchema,
}, { additionalProperties: false });
export const RiskRegisterSchema = Type.Object({
  schema_version: Type.Literal("1"), engagement_id: StableIdSchema,
  risks: Type.Array(RiskSchema, { maxItems: 1_000 }),
}, { additionalProperties: false });
export type Risk = Static<typeof RiskSchema>;
export type RiskRegister = Static<typeof RiskRegisterSchema>;
export type RiskSeverity = Static<typeof RiskSeveritySchema>;
