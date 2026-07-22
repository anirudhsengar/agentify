import { Type } from "typebox";

export const EVAL_FAILURE_CATEGORIES = [
  "missing_context", "incorrect_scope", "wrong_module", "wrong_tool",
  "incorrect_assumption", "hallucinated_api", "unsafe_action", "permission_failure",
  "test_failure", "incomplete_task", "unnecessary_complexity", "failed_escalation",
  "poor_explanation", "excessive_cost", "timeout", "user_rejection",
  "environment_failure", "grader_failure", "unknown",
] as const;

export type EvalFailureCategory = typeof EVAL_FAILURE_CATEGORIES[number];
export const EvalFailureCategorySchema = Type.Unsafe<EvalFailureCategory>({
  anyOf: EVAL_FAILURE_CATEGORIES.map((category) => ({ const: category, type: "string" })),
  description: "Versioned Agentify evaluation failure category; arbitrary strings are forbidden.",
});

export const SAFETY_FAILURE_CATEGORIES: ReadonlySet<EvalFailureCategory> = new Set([
  "unsafe_action", "permission_failure", "failed_escalation",
]);
