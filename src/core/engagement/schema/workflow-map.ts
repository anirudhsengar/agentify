import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { EvidenceReferencesSchema, NonEmptyStringSchema, StableIdSchema } from "./primitives.ts";
import { EngagementMetricSchema } from "./engagement-charter.ts";

export const WorkflowVariantSchema = StringEnum(["current", "target"] as const);
const WorkflowDecisionSchema = Type.Object({
  description: NonEmptyStringSchema,
  outcomes: Type.Array(NonEmptyStringSchema, { minItems: 2, maxItems: 20 }),
}, { additionalProperties: false });

export const WorkflowStepSchema = Type.Object({
  step_id: StableIdSchema,
  name: NonEmptyStringSchema,
  actors: Type.Array(StableIdSchema, { maxItems: 100 }),
  systems: Type.Array(NonEmptyStringSchema, { maxItems: 100 }),
  data_sources: Type.Array(NonEmptyStringSchema, { maxItems: 100 }),
  inputs: Type.Array(NonEmptyStringSchema, { maxItems: 100 }),
  outputs: Type.Array(NonEmptyStringSchema, { maxItems: 100 }),
  decisions: Type.Array(WorkflowDecisionSchema, { maxItems: 50 }),
  handoff_to_step_ids: Type.Array(StableIdSchema, { maxItems: 100 }),
  approvals: Type.Array(NonEmptyStringSchema, { maxItems: 50 }),
  waiting_period_minutes: Type.Number({ minimum: 0 }),
  exceptions: Type.Array(NonEmptyStringSchema, { maxItems: 100 }),
  workarounds: Type.Array(NonEmptyStringSchema, { maxItems: 100 }),
  failure_modes: Type.Array(NonEmptyStringSchema, { maxItems: 100 }),
  evidence: EvidenceReferencesSchema,
}, { additionalProperties: false });

export const WorkflowMapSchema = Type.Object({
  schema_version: Type.Literal("1"),
  engagement_id: StableIdSchema,
  workflow_id: StableIdSchema,
  name: NonEmptyStringSchema,
  variant: WorkflowVariantSchema,
  trigger: NonEmptyStringSchema,
  actors: Type.Array(StableIdSchema, { maxItems: 500 }),
  systems: Type.Array(NonEmptyStringSchema, { maxItems: 500 }),
  data_sources: Type.Array(NonEmptyStringSchema, { maxItems: 500 }),
  steps: Type.Array(WorkflowStepSchema, { minItems: 1, maxItems: 1_000 }),
  source_of_truth_system: NonEmptyStringSchema,
  evidence: EvidenceReferencesSchema,
  baseline_metrics: Type.Array(EngagementMetricSchema, { maxItems: 100 }),
}, { additionalProperties: false, description: "An ordered current or target workflow with stable step identities." });

export type WorkflowMap = Static<typeof WorkflowMapSchema>;
export type WorkflowStep = Static<typeof WorkflowStepSchema>;
