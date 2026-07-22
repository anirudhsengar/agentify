import { Type, type Static } from "typebox";

export const HumanReviewSchema = Type.Object({
  schema_version: Type.Literal("1"), run_id: Type.String({ minLength: 1, maxLength: 128 }),
  task_id: Type.String({ minLength: 1, maxLength: 128 }), trial_index: Type.Integer({ minimum: 0 }),
  reviewer: Type.String({ minLength: 1, maxLength: 300 }), timestamp: Type.String({ format: "date-time" }),
  judgment: Type.Union([Type.Literal("accept"), Type.Literal("accept_with_minor_changes"), Type.Literal("major_rework"), Type.Literal("reject"), Type.Literal("safety_concern")]),
  review_minutes: Type.Number({ minimum: 0 }), comments: Type.String({ maxLength: 8_000 }),
  linked_pr_or_issue: Type.Union([Type.String({ minLength: 1, maxLength: 2_000 }), Type.Null()]),
  evidence_reference: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false, description: "Imported human judgment, distinct from automated grader results." });
export type HumanReview = Static<typeof HumanReviewSchema>;
