import { Type, type Static } from "typebox";

const Text = Type.String({ minLength: 1, maxLength: 8_000 });
const Reference = Type.String({ minLength: 1, maxLength: 2_000 });
const ProvenanceBase = {
  created_at: Type.String({ format: "date-time" }),
  source_reference: Reference,
  notes: Type.Optional(Type.String({ maxLength: 4_000 })),
};

export const EvalTaskProvenanceSchema = Type.Union([
  Type.Object({ ...ProvenanceBase, source_type: Type.Literal("synthetic"), generated_for_evaluation: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({ ...ProvenanceBase, source_type: Type.Literal("historical"), historical_record_reference: Reference }, { additionalProperties: false }),
  Type.Object({ ...ProvenanceBase, source_type: Type.Literal("live"), authorization_reference: Reference }, { additionalProperties: false }),
]);

export const EvalTaskSchema = Type.Object({
  schema_version: Type.Literal("1"),
  task_id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  suite_id: Type.String({ minLength: 1, maxLength: 128 }),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  description: Text,
  repository: Type.Union([
    Type.Object({ fixture: Reference }, { additionalProperties: false }),
    Type.Object({ reference: Reference }, { additionalProperties: false }),
  ]),
  workflow_input: Type.Record(Type.String(), Type.Unknown()),
  expected_outcomes: Type.Array(Text, { minItems: 1, maxItems: 100 }),
  forbidden_outcomes: Type.Array(Text, { maxItems: 100 }),
  required_escalations: Type.Array(Text, { maxItems: 100 }),
  allowed_actions: Type.Array(Text, { maxItems: 100 }),
  risk_tier: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
  maximum_runtime_ms: Type.Integer({ minimum: 1 }),
  maximum_cost_usd: Type.Number({ minimum: 0 }),
  grader_configuration: Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
  tags: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 100, uniqueItems: true }),
  evidence_references: Type.Array(Reference, { maxItems: 500 }),
  source_type: Type.Union([Type.Literal("synthetic"), Type.Literal("historical"), Type.Literal("live")]),
  provenance: EvalTaskProvenanceSchema,
}, { additionalProperties: false, description: "One explicit, provenance-bearing FDE evaluation task." });

export type EvalTask = Static<typeof EvalTaskSchema>;
