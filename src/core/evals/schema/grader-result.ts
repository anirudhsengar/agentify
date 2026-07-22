import { Type, type Static } from "typebox";
import { EvalFailureCategorySchema } from "../failure-taxonomy.ts";

export const GraderResultSchema = Type.Object({
  schema_version: Type.Literal("1"),
  run_id: Type.String({ minLength: 1, maxLength: 128 }),
  task_id: Type.String({ minLength: 1, maxLength: 128 }),
  trial_index: Type.Integer({ minimum: 0 }),
  grader_id: Type.String({ minLength: 1, maxLength: 128 }),
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("error"), Type.Literal("skipped")]),
  passed: Type.Union([Type.Boolean(), Type.Null()]),
  score: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  explanation: Type.String({ maxLength: 8_000 }),
  failure_categories: Type.Array(EvalFailureCategorySchema, { uniqueItems: true }),
  evidence_references: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 500 }),
  error: Type.Union([Type.String({ minLength: 1, maxLength: 8_000 }), Type.Null()]),
}, { additionalProperties: false });

export type GraderResult = Static<typeof GraderResultSchema>;
