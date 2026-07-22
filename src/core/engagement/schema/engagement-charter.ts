import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { EngagementStatusSchema } from "./engagement-status.ts";

const NON_EMPTY = { minLength: 1, maxLength: 4_000 } as const;
const ISO_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";

export const EngagementMetricSchema = Type.Object({
  name: Type.String({ ...NON_EMPTY, description: "Stable metric name." }),
  unit: Type.String({ ...NON_EMPTY, maxLength: 120, description: "Unit used to measure the value." }),
  value: Type.Number({ description: "Finite observed or target metric value." }),
}, { additionalProperties: false, description: "A quantified engagement metric." });

export const EngagementTargetSchema = Type.Object({
  direction: StringEnum(["increase", "decrease", "maintain"] as const, {
    description: "Desired direction of movement for the primary outcome.",
  }),
  value: Type.Number({ description: "Desired numeric target value." }),
  unit: Type.String({ ...NON_EMPTY, maxLength: 120, description: "Unit of the desired target." }),
}, { additionalProperties: false });

export const EngagementRepositorySchema = Type.Object({
  root: Type.String({ ...NON_EMPTY, description: "Repository identity supplied by the owning runtime." }),
  remote: Type.Union([Type.String({ ...NON_EMPTY }), Type.Null()], {
    description: "Canonical repository remote when known.",
  }),
}, { additionalProperties: false });

const TimestampSchema = Type.String({
  pattern: ISO_TIMESTAMP_PATTERN,
  description: "UTC ISO-8601 timestamp.",
});

export const EngagementCharterSchema = Type.Object({
  schema_version: Type.Literal("1"),
  revision: Type.Integer({ minimum: 1 }),
  engagement_id: Type.String({ minLength: 1, maxLength: 128 }),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  status: EngagementStatusSchema,
  repository: EngagementRepositorySchema,
  workflow_name: Type.String(NON_EMPTY),
  workflow_owner: Type.String(NON_EMPTY),
  intended_users: Type.Array(Type.String(NON_EMPTY), { minItems: 1, maxItems: 100 }),
  systems_involved: Type.Array(Type.String(NON_EMPTY), { minItems: 1, maxItems: 100 }),
  problem_statement: Type.String(NON_EMPTY),
  workflow_frequency: Type.String(NON_EMPTY),
  baseline_metrics: Type.Array(EngagementMetricSchema, { minItems: 1, maxItems: 100 }),
  desired_primary_outcome: Type.String(NON_EMPTY),
  target: EngagementTargetSchema,
  guardrail_metrics: Type.Array(EngagementMetricSchema, { minItems: 0, maxItems: 100 }),
  forbidden_actions: Type.Array(Type.String(NON_EMPTY), { minItems: 0, maxItems: 100 }),
  requires_human_approval: Type.Boolean(),
  maximum_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
  maximum_runtime_minutes: Type.Optional(Type.Number({ minimum: 0 })),
  business_owner: Type.String(NON_EMPTY),
  technical_owner: Type.String(NON_EMPTY),
  evidence_references: Type.Array(Type.String(NON_EMPTY), { minItems: 0, maxItems: 500 }),
  stop_reason: Type.Union([Type.String(NON_EMPTY), Type.Null()]),
}, {
  additionalProperties: false,
  description: "Typed charter and lifecycle state for one internal FDE engagement.",
});

export type EngagementCharter = Static<typeof EngagementCharterSchema>;
export type EngagementMetric = Static<typeof EngagementMetricSchema>;
