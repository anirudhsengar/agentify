import { Type, type Static } from "typebox";
import { EvalFailureCategorySchema } from "../failure-taxonomy.ts";
import { GraderResultSchema } from "./grader-result.ts";

const NullableReference = Type.Union([Type.String({ minLength: 1, maxLength: 2_000 }), Type.Null()]);
export const EvalTrialSchema = Type.Object({
  schema_version: Type.Literal("1"), run_id: Type.String({ minLength: 1, maxLength: 128 }),
  task_id: Type.String({ minLength: 1, maxLength: 128 }), trial_index: Type.Integer({ minimum: 0 }),
  started_at: Type.String({ format: "date-time" }), ended_at: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  status: Type.Union([Type.Literal("planned"), Type.Literal("running"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped"), Type.Literal("error")]),
  evidence_origin: Type.Union([Type.Literal("imported"), Type.Literal("no_execution")]),
  inputs: Type.Record(Type.String(), Type.Unknown()), environment_reference: NullableReference,
  execution_reference: NullableReference, transcript_reference: NullableReference,
  cost_usd: Type.Number({ minimum: 0 }), runtime_ms: Type.Integer({ minimum: 0 }),
  output_references: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 500 }),
  error: Type.Union([Type.String({ minLength: 1, maxLength: 8_000 }), Type.Null()]),
  grader_results: Type.Array(GraderResultSchema, { maxItems: 100 }),
  passed: Type.Union([Type.Boolean(), Type.Null()]),
  failure_categories: Type.Array(EvalFailureCategorySchema, { uniqueItems: true }),
}, { additionalProperties: false });
export type EvalTrial = Static<typeof EvalTrialSchema>;
