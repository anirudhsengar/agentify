import { Type, type Static } from "typebox";
import { EvalFailureCategorySchema, type EvalFailureCategory } from "../failure-taxonomy.ts";

export const EvalResultSchema = Type.Object({
  schema_version: Type.Literal("1"), run_id: Type.String({ minLength: 1, maxLength: 128 }),
  suite_id: Type.String({ minLength: 1, maxLength: 128 }), suite_version: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("running"), Type.Literal("complete"), Type.Literal("partial"), Type.Literal("failed")]),
  task_count: Type.Integer({ minimum: 0 }), planned_trials: Type.Integer({ minimum: 0 }), completed_trials: Type.Integer({ minimum: 0 }),
  passed_trials: Type.Integer({ minimum: 0 }), failed_trials: Type.Integer({ minimum: 0 }), skipped_trials: Type.Integer({ minimum: 0 }),
  trial_pass_rate: Type.Number({ minimum: 0, maximum: 1 }), task_pass_rate: Type.Number({ minimum: 0, maximum: 1 }),
  pass_at_1: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  repeated_trial_success_rate: Type.Number({ minimum: 0, maximum: 1 }),
  all_k_success_rate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  total_cost_usd: Type.Number({ minimum: 0 }), total_runtime_ms: Type.Integer({ minimum: 0 }),
  failure_distribution: Type.Record(EvalFailureCategorySchema, Type.Integer({ minimum: 0 })),
  missing_graders: Type.Array(Type.String(), { uniqueItems: true }), grader_errors: Type.Integer({ minimum: 0 }),
  safety_failures: Type.Integer({ minimum: 0 }), provenance_breakdown: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  release_gate_eligible: Type.Boolean(), release_gate_ineligibility_reasons: Type.Array(Type.String()),
}, { additionalProperties: false });
type EvalResultStatic = Static<typeof EvalResultSchema>;
export type EvalResult = Omit<EvalResultStatic, "failure_distribution" | "provenance_breakdown"> & {
  failure_distribution: Partial<Record<EvalFailureCategory, number>>;
  provenance_breakdown: Record<string, number>;
};
