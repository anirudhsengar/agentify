import { Type, type Static } from "typebox";
import { EvalFailureCategorySchema } from "../failure-taxonomy.ts";

export const GraderResultSchema = Type.Object({
  schema_version: Type.Literal("1"),
  run_id: Type.String({ minLength: 1, maxLength: 128 }),
  task_id: Type.String({ minLength: 1, maxLength: 128 }),
  trial_index: Type.Integer({ minimum: 0 }),
  grader_id: Type.String({ minLength: 1, maxLength: 128 }),
  grader_version: Type.String({ minLength: 1, maxLength: 64 }),
  status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("human_required"), Type.Literal("error"), Type.Literal("skipped")]),
  passed: Type.Union([Type.Boolean(), Type.Null()]),
  score: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  reason: Type.String({ minLength: 1, maxLength: 8_000 }),
  failure_categories: Type.Array(EvalFailureCategorySchema, { uniqueItems: true }),
  evidence_references: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 500 }),
  error: Type.Union([Type.String({ minLength: 1, maxLength: 8_000 }), Type.Null()]),
  duration_ms: Type.Integer({ minimum: 0 }),
  confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
}, { additionalProperties: false });

export type GraderResult = Static<typeof GraderResultSchema>;
