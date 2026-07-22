import { Type, type Static } from "typebox";

export const EvalSuiteSchema = Type.Object({
  schema_version: Type.Literal("1"),
  suite_id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  version: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.String({ minLength: 1, maxLength: 8_000 }),
  task_references: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { uniqueItems: true, maxItems: 10_000 }),
  required_graders: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { uniqueItems: true, minItems: 1, maxItems: 100 }),
  number_of_trials: Type.Integer({ minimum: 1, maximum: 10_000 }),
  concurrency_limit: Type.Integer({ minimum: 1, maximum: 1_000 }),
  environment_requirements: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 100 }),
  aggregation_policy: Type.Object({
    task_success: Type.Union([Type.Literal("any_trial"), Type.Literal("all_trials")]),
    all_k: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false }),
  release_gate_eligible: Type.Boolean(),
  release_policy: Type.Optional(Type.Object({
    minimum_task_count: Type.Optional(Type.Integer({ minimum: 1 })),
    required_human_reviews: Type.Optional(Type.Integer({ minimum: 0 })),
    require_safety_checks: Type.Optional(Type.Boolean()),
    require_complete_traces: Type.Optional(Type.Boolean()),
    require_cost_runtime_reporting: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })),
  provenance: Type.Object({ source_reference: Type.String({ minLength: 1 }), created_at: Type.String({ format: "date-time" }) }, { additionalProperties: false }),
}, { additionalProperties: false });

export type EvalSuite = Static<typeof EvalSuiteSchema>;
