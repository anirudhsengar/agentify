import { Type, type Static } from "typebox";
import {
  LEARNING_SCHEMA_VERSION,
  MAX_LEARNING_ATTEMPTS,
  MAX_LEARNING_CHANGED_FILES,
  MAX_LEARNING_REVIEW_FEEDBACK,
} from "./contracts.ts";

const GitObjectSchema = Type.String({
  pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
  minLength: 40,
  maxLength: 64,
});
const TimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
});
const SafeIdSchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9._-]{0,127}$",
  minLength: 1,
  maxLength: 128,
});
const NonEmptyTextSchema = Type.String({ minLength: 1, maxLength: 4_000 });
const ShortTextSchema = Type.String({ minLength: 1, maxLength: 512 });
const NullableIssueSchema = Type.Union([
  Type.Integer({ minimum: 1 }),
  Type.Null(),
]);
const NullableUrlSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 2_048 }),
  Type.Null(),
]);

export const AcceptedMergeEventSchema = Type.Object({
  schema_version: Type.Literal(LEARNING_SCHEMA_VERSION),
  repository_id: Type.String({ minLength: 1, maxLength: 512 }),
  default_branch: Type.String({ minLength: 1, maxLength: 256 }),
  accepted_commit: GitObjectSchema,
  first_parent_commit: GitObjectSchema,
  expected_repository_head: GitObjectSchema,
  pull_request_number: NullableIssueSchema,
  issue_number: NullableIssueSchema,
  pull_request_url: NullableUrlSchema,
  actor: Type.String({ minLength: 1, maxLength: 256 }),
  author_kind: Type.Union([
    Type.Literal("agentify"),
    Type.Literal("human"),
    Type.Literal("unknown"),
  ]),
  accepted_at: TimestampSchema,
}, { additionalProperties: false });

export const AcceptedMergeChangeSchema = Type.Object({
  status: Type.Union([
    Type.Literal("added"),
    Type.Literal("modified"),
    Type.Literal("deleted"),
    Type.Literal("renamed"),
    Type.Literal("copied"),
  ]),
  path: Type.String({ minLength: 1, maxLength: 1_024 }),
  previous_path: Type.Union([
    Type.String({ minLength: 1, maxLength: 1_024 }),
    Type.Null(),
  ]),
}, { additionalProperties: false });

export const AcceptedValidationEvidenceSchema = Type.Object({
  commands: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
    minItems: 0,
    maxItems: 64,
  }),
  passed: Type.Boolean(),
  evidence_refs: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
    minItems: 0,
    maxItems: 64,
  }),
}, { additionalProperties: false });

export const AcceptedReviewFeedbackSchema = Type.Object({
  actor: Type.String({ minLength: 1, maxLength: 256 }),
  source_ref: Type.String({ minLength: 1, maxLength: 2_048 }),
  accepted_at: TimestampSchema,
  statement: NonEmptyTextSchema,
}, { additionalProperties: false });

export const AcceptedTaskAttemptSchema = Type.Object({
  sequence: Type.Integer({ minimum: 1, maximum: MAX_LEARNING_ATTEMPTS }),
  approach: NonEmptyTextSchema,
  result: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  failure_category: Type.Union([ShortTextSchema, Type.Null()]),
  signal: NonEmptyTextSchema,
  correction: Type.Union([NonEmptyTextSchema, Type.Null()]),
}, { additionalProperties: false });

export const AcceptedTaskEvidenceSchema = Type.Object({
  schema_version: Type.Literal(LEARNING_SCHEMA_VERSION),
  task_id: SafeIdSchema,
  issue_number: NullableIssueSchema,
  pull_request_number: NullableIssueSchema,
  issue_url: NullableUrlSchema,
  plan_digest: Type.Union([
    Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 }),
    Type.Null(),
  ]),
  selected_specialist_ids: Type.Array(SafeIdSchema, {
    minItems: 0,
    maxItems: 16,
    uniqueItems: true,
  }),
  selected_procedure_ids: Type.Array(SafeIdSchema, {
    minItems: 0,
    maxItems: 32,
    uniqueItems: true,
  }),
  risk_category: Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("critical"),
  ]),
  validation: AcceptedValidationEvidenceSchema,
  review_feedback: Type.Array(AcceptedReviewFeedbackSchema, {
    minItems: 0,
    maxItems: MAX_LEARNING_REVIEW_FEEDBACK,
  }),
  attempts: Type.Array(AcceptedTaskAttemptSchema, {
    minItems: 0,
    maxItems: MAX_LEARNING_ATTEMPTS,
  }),
  generalization: Type.Union([
    Type.Literal("task_local"),
    Type.Literal("candidate"),
    Type.Literal("generalized"),
  ]),
  cost_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  runtime_ms: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  source_artifact_url: NullableUrlSchema,
}, { additionalProperties: false });

export const MergeLearningJournalSchema = Type.Object({
  format: Type.Literal("agentify_merge_learning_transaction"),
  schema_version: Type.Literal(LEARNING_SCHEMA_VERSION),
  event_digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  accepted_commit: GitObjectSchema,
  expected_repository_head: GitObjectSchema,
  repository_id: Type.String({ minLength: 1, maxLength: 512 }),
  phase: Type.Union([
    Type.Literal("bound"),
    Type.Literal("assessed"),
    Type.Literal("invalidated"),
    Type.Literal("candidates-accepted"),
    Type.Literal("specialists-refreshed"),
    Type.Literal("recorded"),
  ]),
  started_at: TimestampSchema,
  updated_at: TimestampSchema,
  journal_digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
}, { additionalProperties: false });

export const MergeLearningReportSchema = Type.Object({
  schema_version: Type.Literal(LEARNING_SCHEMA_VERSION),
  status: Type.Union([
    Type.Literal("processed"),
    Type.Literal("already-processed"),
    Type.Literal("knowledge-only"),
  ]),
  event_digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  accepted_commit: GitObjectSchema,
  expected_repository_head: GitObjectSchema,
  changes: Type.Array(AcceptedMergeChangeSchema, {
    minItems: 0,
    maxItems: MAX_LEARNING_CHANGED_FILES,
  }),
  invalidation: Type.Object({
    stale_memory_ids: Type.Array(SafeIdSchema, { maxItems: 5_000 }),
    already_inactive_memory_ids: Type.Array(SafeIdSchema, { maxItems: 5_000 }),
    expertise: Type.Object({
      specialist_ids: Type.Array(SafeIdSchema, { maxItems: 8 }),
      procedure_ids: Type.Array(SafeIdSchema, { maxItems: 64 }),
      reasons: Type.Record(Type.String(), Type.Array(NonEmptyTextSchema, { maxItems: 256 })),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  candidates: Type.Array(Type.Object({
    candidate_id: SafeIdSchema,
    memory_id: SafeIdSchema,
    kind: Type.Union([
      Type.Literal("codebase"),
      Type.Literal("procedure"),
      Type.Literal("episode"),
      Type.Literal("specialist"),
      Type.Literal("orchestrator"),
      Type.Literal("policy"),
    ]),
    owning_agent_id: SafeIdSchema,
    status: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("already-accepted"),
    ]),
  }, { additionalProperties: false }), { maxItems: 128 }),
  specialist_sync: Type.Union([
    Type.Literal("not-requested"),
    Type.Literal("map-absent"),
    Type.Literal("memory-absent"),
    Type.Literal("synchronized"),
  ]),
  learning_run_memory_id: SafeIdSchema,
  metrics: Type.Object({
    changed_file_count: Type.Integer({ minimum: 0 }),
    candidate_count: Type.Integer({ minimum: 0 }),
    stale_memory_count: Type.Integer({ minimum: 0 }),
    accepted_memory_count: Type.Integer({ minimum: 0 }),
    elapsed_ms: Type.Integer({ minimum: 0 }),
    cost_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type AcceptedMergeEventValue = Static<typeof AcceptedMergeEventSchema>;
export type AcceptedTaskEvidenceValue = Static<typeof AcceptedTaskEvidenceSchema>;
export type MergeLearningJournalValue = Static<typeof MergeLearningJournalSchema>;
export type MergeLearningReportValue = Static<typeof MergeLearningReportSchema>;
