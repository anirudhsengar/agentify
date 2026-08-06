import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AcceptedTaskEvidence } from "../learning/contracts.ts";
import { AcceptedTaskEvidenceSchema } from "../learning/schema.ts";
import {
  DEFAULT_MAX_FIX_CYCLES,
  MAX_TASK_CHANGED_FILES,
  MAX_TASK_EVENT_IDS,
  MAX_TASK_MODEL_CALLS,
  TASK_LIFECYCLE_SCHEMA_VERSION,
  TASK_STATE_FORMAT,
  type BuilderCallEvidence,
  type BuilderModelSubmission,
  type BuilderRequest,
  type BuilderResult,
  type DurableTaskState,
  type OrchestratorPlan,
  type ReviewerVerdict,
  type SpecialistConsultationResult,
  type TaskLifecyclePolicy,
  type TrustedIssueEvent,
  type ValidationPlan,
  type ValidationResult,
} from "./contracts.ts";
import { digestTaskValue, normalizeTaskPaths, sortedTaskStrings } from "./serialization.ts";
import { assertDurableTaskState, TaskLifecycleError } from "./state-machine.ts";

const TimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
  maxLength: 32,
});
const CommitSchema = Type.String({ pattern: "^[0-9a-f]{40}$", minLength: 40, maxLength: 40 });
const DigestSchema = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const SafeIdSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$", minLength: 1, maxLength: 256 });
const RepoPathSchema = Type.String({ minLength: 1, maxLength: 1_024 });
const ShortTextSchema = Type.String({ minLength: 1, maxLength: 1_500 });
const TextSchema = Type.String({ minLength: 1, maxLength: 12_000 });
const NullableTextSchema = Type.Union([Type.String({ minLength: 1, maxLength: 12_000 }), Type.Null()]);
const StringListSchema = Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { maxItems: 256 });
const PathListSchema = Type.Array(RepoPathSchema, { maxItems: MAX_TASK_CHANGED_FILES, uniqueItems: true });

export const RepositoryIdentitySchema = Type.Object({
  repository_id: Type.String({ minLength: 1, maxLength: 128 }),
  full_name: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", minLength: 3, maxLength: 256 }),
  default_branch: Type.String({ minLength: 1, maxLength: 256 }),
}, { additionalProperties: false });

export const TaskLifecycleStateSchema = Type.Union([
  Type.Literal("new"),
  Type.Literal("needs-information"),
  Type.Literal("ready"),
  Type.Literal("planned"),
  Type.Literal("awaiting-approval"),
  Type.Literal("approved"),
  Type.Literal("implementing"),
  Type.Literal("validating"),
  Type.Literal("reviewing"),
  Type.Literal("fixing"),
  Type.Literal("draft-pr-open"),
  Type.Literal("completed"),
  Type.Literal("stopped"),
  Type.Literal("refused"),
  Type.Literal("blocked"),
  Type.Literal("stale-base"),
  Type.Literal("budget-exhausted"),
  Type.Literal("failed"),
  Type.Literal("recovering"),
]);

const RepositoryPermissionSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("read"),
  Type.Literal("triage"),
  Type.Literal("write"),
  Type.Literal("maintain"),
  Type.Literal("admin"),
]);

export const TrustedIssueEventSchema = Type.Object({
  schema_version: Type.Literal(TASK_LIFECYCLE_SCHEMA_VERSION),
  delivery_id: SafeIdSchema,
  event_name: Type.Union([Type.Literal("issues"), Type.Literal("issue_comment")]),
  action: Type.Union([
    Type.Literal("labeled"), Type.Literal("created"), Type.Literal("edited"),
    Type.Literal("deleted"), Type.Literal("other"),
  ]),
  repository: RepositoryIdentitySchema,
  installation_repository_id: Type.String({ minLength: 1, maxLength: 128 }),
  issue_number: Type.Integer({ minimum: 1 }),
  issue_state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  issue_is_pull_request: Type.Boolean(),
  issue_title: Type.String({ maxLength: 2_048 }),
  issue_body: Type.String({ maxLength: 64 * 1024 }),
  actor: Type.Object({
    login: Type.String({ minLength: 1, maxLength: 256 }),
    type: Type.Union([Type.Literal("User"), Type.Literal("Bot"), Type.Literal("Organization"), Type.Literal("Unknown")]),
    permission: RepositoryPermissionSchema,
  }, { additionalProperties: false }),
  label_name: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  comment_id: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  comment_body: Type.Union([Type.String({ maxLength: 64 * 1024 }), Type.Null()]),
  comment_created_at: Type.Union([TimestampSchema, Type.Null()]),
  comment_updated_at: Type.Union([TimestampSchema, Type.Null()]),
  received_at: TimestampSchema,
}, { additionalProperties: false });

export const TaskApprovalSchema = Type.Object({
  approver: Type.String({ minLength: 1, maxLength: 256 }),
  plan_digest: DigestSchema,
  expected_base_commit: CommitSchema,
  approved_at: TimestampSchema,
  expires_at: TimestampSchema,
  policy_digest: DigestSchema,
}, { additionalProperties: false });

const TaskBudgetStateSchema = Type.Object({
  maximum_cost_usd: Type.Number({ minimum: 0 }),
  measured_cost_usd: Type.Number({ minimum: 0 }),
  estimated_cost_usd: Type.Number({ minimum: 0 }),
  reserved_cost_usd: Type.Number({ minimum: 0 }),
  model_calls: Type.Integer({ minimum: 0, maximum: MAX_TASK_MODEL_CALLS }),
  maximum_model_calls: Type.Integer({ minimum: 1, maximum: MAX_TASK_MODEL_CALLS }),
  started_at: TimestampSchema,
  deadline_at: TimestampSchema,
  maximum_runtime_ms: Type.Integer({ minimum: 1, maximum: 24 * 60 * 60 * 1000 }),
}, { additionalProperties: false });

const TaskActiveModelCallSchema = Type.Object({
  call_id: SafeIdSchema,
  role: Type.Union([Type.Literal("specialist"), Type.Literal("builder"), Type.Literal("reviewer")]),
  phase: Type.String({ minLength: 1, maxLength: 256 }),
  reserved_cost_usd: Type.Number({ exclusiveMinimum: 0 }),
  started_at: TimestampSchema,
}, { additionalProperties: false });

const TaskOwnedResourceSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("state-comment"), Type.Literal("branch"), Type.Literal("commit"),
    Type.Literal("artifact"), Type.Literal("pull-request"), Type.Literal("projection-comment"),
  ]),
  identity: Type.String({ minLength: 1, maxLength: 1_024 }),
  ownership_digest: DigestSchema,
}, { additionalProperties: false });

const TaskExternalMutationSchema = Type.Union([
  Type.Literal("state-created"),
  Type.Literal("plan-recorded"),
  Type.Literal("approval-recorded"),
  Type.Literal("branch-created"),
  Type.Literal("builder-commit"),
  Type.Literal("validation-completed"),
  Type.Literal("review-completed"),
  Type.Literal("fix-committed"),
  Type.Literal("branch-pushed"),
  Type.Literal("draft-pr-created"),
  Type.Literal("projection-updated"),
]);

const TaskRecoverySchema = Type.Object({
  recovery_id: SafeIdSchema,
  target_state: TaskLifecycleStateSchema,
  checkpoint: Type.Union([TaskExternalMutationSchema, Type.Null()]),
  completed_mutations: Type.Array(TaskExternalMutationSchema, { maxItems: 32, uniqueItems: true }),
  owned_resources: Type.Array(TaskOwnedResourceSchema, { maxItems: 64 }),
  attempt: Type.Integer({ minimum: 1, maximum: 32 }),
  started_at: TimestampSchema,
  updated_at: TimestampSchema,
}, { additionalProperties: false });

const DraftPrIdentitySchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  url: Type.String({ minLength: 1, maxLength: 2_048 }),
  head_branch: Type.String({ minLength: 1, maxLength: 256 }),
  base_branch: Type.String({ minLength: 1, maxLength: 256 }),
  head_commit: CommitSchema,
  draft: Type.Literal(true),
}, { additionalProperties: false });

export const DurableTaskStateSchema = Type.Object({
  format: Type.Literal(TASK_STATE_FORMAT),
  schema_version: Type.Literal(TASK_LIFECYCLE_SCHEMA_VERSION),
  repository: RepositoryIdentitySchema,
  issue_number: Type.Integer({ minimum: 1 }),
  task_id: SafeIdSchema,
  revision: Type.Integer({ minimum: 1 }),
  current_state: TaskLifecycleStateSchema,
  expected_base_commit: CommitSchema,
  active_branch: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  draft_pr: Type.Union([DraftPrIdentitySchema, Type.Null()]),
  policy_digest: DigestSchema,
  plan_digest: Type.Union([DigestSchema, Type.Null()]),
  selected_specialist_ids: Type.Array(SafeIdSchema, { maxItems: 16, uniqueItems: true }),
  selected_procedure_ids: Type.Array(SafeIdSchema, { maxItems: 64, uniqueItems: true }),
  approval: Type.Union([TaskApprovalSchema, Type.Null()]),
  budget: TaskBudgetStateSchema,
  active_model_call: Type.Union([TaskActiveModelCallSchema, Type.Null()]),
  retry_count: Type.Integer({ minimum: 0, maximum: 32 }),
  fix_cycle_count: Type.Integer({ minimum: 0, maximum: 16 }),
  maximum_fix_cycles: Type.Integer({ minimum: 0, maximum: 16, default: DEFAULT_MAX_FIX_CYCLES }),
  event_ids: Type.Array(SafeIdSchema, { minItems: 1, maxItems: MAX_TASK_EVENT_IDS, uniqueItems: true }),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  prior_state_digest: Type.Union([DigestSchema, Type.Null()]),
  current_digest: DigestSchema,
  failure_reason: NullableTextSchema,
  recovery: Type.Union([TaskRecoverySchema, Type.Null()]),
  accepted_merge: Type.Union([Type.Object({
    repository_id: Type.String({ minLength: 1, maxLength: 512 }), task_id: SafeIdSchema,
    issue_number: Type.Integer({ minimum: 1 }), pull_request_number: Type.Integer({ minimum: 1 }),
    head_branch: Type.String({ minLength: 1, maxLength: 256 }), validated_head_commit: CommitSchema,
    merge_commit: CommitSchema, default_branch: Type.String({ minLength: 1, maxLength: 256 }),
    merge_actor: Type.String({ minLength: 1, maxLength: 256 }), event_id: SafeIdSchema,
    merged_at: TimestampSchema,
  }, { additionalProperties: false }), Type.Null()]),
  accepted_task_evidence_ref: Type.Union([Type.String({ minLength: 1, maxLength: 2_048 }), Type.Null()]),
  final_commit: Type.Union([CommitSchema, Type.Null()]),
  builder_result_digest: Type.Union([DigestSchema, Type.Null()]),
  validation_result_digest: Type.Union([DigestSchema, Type.Null()]),
  reviewer_verdict_digest: Type.Union([DigestSchema, Type.Null()]),
  last_event: Type.Object({
    event_id: SafeIdSchema,
    actor: Type.String({ minLength: 1, maxLength: 256 }),
    reason: Type.String({ minLength: 1, maxLength: 2_048 }),
    occurred_at: TimestampSchema,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const IssueAcceptanceCriterionSchema = Type.Object({
  criterion_id: SafeIdSchema,
  statement: TextSchema,
  verification: Type.String({ minLength: 1, maxLength: 4_000 }),
}, { additionalProperties: false });

export const ValidationCommandSpecSchema = Type.Object({
  command_id: SafeIdSchema,
  argv: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { minItems: 1, maxItems: 64 }),
  cwd: RepoPathSchema,
  timeout_ms: Type.Integer({ minimum: 1, maximum: 60 * 60 * 1000 }),
  required: Type.Boolean(),
  mutation_allowed: Type.Literal(false),
  source: Type.Union([Type.Literal("repository-policy"), Type.Literal("procedure"), Type.Literal("plan")]),
}, { additionalProperties: false });

export const TaskLifecyclePolicySchema = Type.Object({
  policy_digest: DigestSchema,
  approval_required: Type.Boolean(),
  approval_ttl_ms: Type.Integer({ minimum: 1, maximum: 30 * 24 * 60 * 60 * 1000 }),
  maximum_cost_usd: Type.Number({ exclusiveMinimum: 0 }),
  maximum_runtime_ms: Type.Integer({ minimum: 1, maximum: 24 * 60 * 60 * 1000 }),
  maximum_model_calls: Type.Integer({ minimum: 1, maximum: MAX_TASK_MODEL_CALLS }),
  maximum_fix_cycles: Type.Integer({ minimum: 0, maximum: 16 }),
  protected_paths: PathListSchema,
  allowed_write_paths: PathListSchema,
  validation_commands: Type.Array(ValidationCommandSpecSchema, { minItems: 1, maxItems: 64 }),
  forbidden_actions: StringListSchema,
}, { additionalProperties: false });

const PlanSpecialistSelectionSchema = Type.Object({
  specialist_id: SafeIdSchema,
  score: Type.Number({ minimum: 0 }),
  reasons: StringListSchema,
}, { additionalProperties: false });
const PlanProcedureSelectionSchema = Type.Object({
  procedure_id: SafeIdSchema,
  score: Type.Number({ minimum: 0 }),
  reasons: StringListSchema,
}, { additionalProperties: false });
const ImplementationStepSchema = Type.Object({
  step_id: SafeIdSchema,
  description: TextSchema,
  in_scope_paths: PathListSchema,
  required_procedure_ids: Type.Array(SafeIdSchema, { maxItems: 64, uniqueItems: true }),
  validation_command_ids: Type.Array(SafeIdSchema, { maxItems: 64, uniqueItems: true }),
}, { additionalProperties: false });
const PlanRiskControlSchema = Type.Object({
  control_id: SafeIdSchema,
  description: TextSchema,
  enforcement: Type.Union([Type.Literal("policy"), Type.Literal("validation"), Type.Literal("approval"), Type.Literal("review")]),
}, { additionalProperties: false });
const TaskMemoryExcerptSchema = Type.Object({
  memory_id: SafeIdSchema,
  kind: Type.Union([Type.Literal("codebase"), Type.Literal("procedure"), Type.Literal("episode"), Type.Literal("specialist"), Type.Literal("orchestrator"), Type.Literal("policy")]),
  owning_agent_id: SafeIdSchema,
  statement: Type.String({ minLength: 1, maxLength: 4_000 }),
  freshness: Type.Literal("current"),
  context_role: Type.Union([Type.Literal("active-guidance"), Type.Literal("prior-episode")]),
  relevant_payload: Type.String({ minLength: 2, maxLength: 8_000 }),
  evidence_ids: Type.Array(SafeIdSchema, { maxItems: 32, uniqueItems: true }),
  evidence_paths: Type.Array(RepoPathSchema, { maxItems: 64, uniqueItems: true }),
  supporting_commit: CommitSchema,
}, { additionalProperties: false });

export const OrchestratorPlanSchema = Type.Object({
  schema_version: Type.Literal(TASK_LIFECYCLE_SCHEMA_VERSION),
  task_id: SafeIdSchema,
  repository: RepositoryIdentitySchema,
  issue_number: Type.Integer({ minimum: 1 }),
  expected_base_commit: CommitSchema,
  task_summary: TextSchema,
  acceptance_criteria: Type.Array(IssueAcceptanceCriterionSchema, { minItems: 1, maxItems: 64 }),
  in_scope_paths: PathListSchema,
  excluded_paths: PathListSchema,
  selected_specialists: Type.Array(PlanSpecialistSelectionSchema, { maxItems: 8 }),
  selected_procedures: Type.Array(PlanProcedureSelectionSchema, { maxItems: 64 }),
  implementation_steps: Type.Array(ImplementationStepSchema, { minItems: 1, maxItems: 128 }),
  validation_commands: Type.Array(ValidationCommandSpecSchema, { minItems: 1, maxItems: 64 }),
  security_controls: Type.Array(PlanRiskControlSchema, { minItems: 1, maxItems: 64 }),
  risk_category: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
  migration_implications: StringListSchema,
  documentation_expectations: StringListSchema,
  approval_required: Type.Boolean(),
  estimated_model_calls: Type.Integer({ minimum: 0, maximum: MAX_TASK_MODEL_CALLS }),
  estimated_cost_usd: Type.Number({ minimum: 0 }),
  escalation_conditions: StringListSchema,
  memory_record_ids: Type.Array(SafeIdSchema, { maxItems: 256, uniqueItems: true }),
  memory_excerpts: Type.Array(TaskMemoryExcerptSchema, { maxItems: 32 }),
  routing_digest: DigestSchema,
  policy_digest: DigestSchema,
  created_at: TimestampSchema,
  plan_digest: DigestSchema,
}, { additionalProperties: false });

const SpecialistFindingSchema = Type.Object({
  finding_id: SafeIdSchema,
  statement: TextSchema,
  evidence_paths: PathListSchema,
  severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("blocking")]),
}, { additionalProperties: false });

export const SpecialistConsultationResultSchema = Type.Object({
  schema_version: Type.Literal(TASK_LIFECYCLE_SCHEMA_VERSION),
  task_id: SafeIdSchema,
  specialist_id: SafeIdSchema,
  expected_base_commit: CommitSchema,
  paths: PathListSchema,
  contracts: StringListSchema,
  patterns: StringListSchema,
  pitfalls: StringListSchema,
  procedures: Type.Array(SafeIdSchema, { maxItems: 64, uniqueItems: true }),
  validation: StringListSchema,
  risks: Type.Array(SpecialistFindingSchema, { maxItems: 64 }),
  related_specialists: Type.Array(SafeIdSchema, { maxItems: 16, uniqueItems: true }),
  unresolved_questions: StringListSchema,
  result_digest: DigestSchema,
}, { additionalProperties: false });

const ReviewerFindingSchema = Type.Object({
  finding_id: SafeIdSchema,
  severity: Type.Union([Type.Literal("minor"), Type.Literal("major"), Type.Literal("critical")]),
  path: Type.Union([RepoPathSchema, Type.Null()]),
  statement: TextSchema,
  required_change: NullableTextSchema,
  acceptance_criterion_ids: Type.Array(SafeIdSchema, { maxItems: 64, uniqueItems: true }),
}, { additionalProperties: false });

export const BuilderRequestSchema = Type.Object({
  schema_version: Type.Literal(TASK_LIFECYCLE_SCHEMA_VERSION),
  task_id: SafeIdSchema,
  repository: RepositoryIdentitySchema,
  issue_number: Type.Integer({ minimum: 1 }),
  expected_base_commit: CommitSchema,
  branch: Type.String({ minLength: 1, maxLength: 256 }),
  write_root: RepoPathSchema,
  protected_paths: PathListSchema,
  allowed_paths: Type.Array(RepoPathSchema, { minItems: 1, maxItems: MAX_TASK_CHANGED_FILES, uniqueItems: true }),
  plan: OrchestratorPlanSchema,
  specialist_findings: Type.Array(SpecialistConsultationResultSchema, { maxItems: 8 }),
  selected_procedure_ids: Type.Array(SafeIdSchema, { maxItems: 64, uniqueItems: true }),
  memory_record_ids: Type.Array(SafeIdSchema, { maxItems: 256, uniqueItems: true }),
  fix_cycle: Type.Integer({ minimum: 0, maximum: 16 }),
  reviewer_findings: Type.Array(ReviewerFindingSchema, { maxItems: 64 }),
  execution_policy_digest: DigestSchema,
}, { additionalProperties: false });

export const BuilderAttemptSchema = Type.Object({
  sequence: Type.Integer({ minimum: 1, maximum: 32 }),
  approach: TextSchema,
  result: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]),
  failure_category: Type.Union([ShortTextSchema, Type.Null()]),
  signal: TextSchema,
  correction: NullableTextSchema,
}, { additionalProperties: false });

export const BuilderModelSubmissionSchema = Type.Object({
  summary: TextSchema,
  attempts: Type.Array(BuilderAttemptSchema, { minItems: 1, maxItems: 32 }),
  turns: Type.Integer({ minimum: 0 }),
  cost_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  runtime_ms: Type.Integer({ minimum: 0 }),
  aborted: Type.Boolean(),
}, { additionalProperties: false });

export const BuilderCallEvidenceSchema = Type.Object({
  schema_version: Type.Literal(TASK_LIFECYCLE_SCHEMA_VERSION),
  task_id: SafeIdSchema,
  call_id: SafeIdSchema,
  fix_cycle: Type.Integer({ minimum: 0, maximum: 16 }),
  builder_agent_id: SafeIdSchema,
  started_at: TimestampSchema,
  completed_at: TimestampSchema,
  submission: BuilderModelSubmissionSchema,
  evidence_digest: DigestSchema,
}, { additionalProperties: false });

export const BuilderResultSchema = Type.Object({
  schema_version: Type.Literal(TASK_LIFECYCLE_SCHEMA_VERSION),
  task_id: SafeIdSchema,
  issue_number: Type.Integer({ minimum: 1 }),
  expected_base_commit: CommitSchema,
  branch: Type.String({ minLength: 1, maxLength: 256 }),
  builder_agent_id: SafeIdSchema,
  started_at: TimestampSchema,
  completed_at: TimestampSchema,
  commit_shas: Type.Array(CommitSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
  final_commit: CommitSchema,
  changed_files: Type.Array(RepoPathSchema, { minItems: 1, maxItems: MAX_TASK_CHANGED_FILES, uniqueItems: true }),
  untracked_files: Type.Array(RepoPathSchema, { maxItems: MAX_TASK_CHANGED_FILES, uniqueItems: true }),
  summary: TextSchema,
  attempts: Type.Array(BuilderAttemptSchema, { minItems: 1, maxItems: 32 }),
  cost_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  runtime_ms: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const ValidationPlanSchema = Type.Object({
  schema_version: Type.Literal(TASK_LIFECYCLE_SCHEMA_VERSION),
  task_id: SafeIdSchema,
  expected_base_commit: CommitSchema,
  expected_branch: Type.String({ minLength: 1, maxLength: 256 }),
  expected_builder_commit: CommitSchema,
  commands: Type.Array(ValidationCommandSpecSchema, { minItems: 1, maxItems: 64 }),
  protected_paths: PathListSchema,
  allowed_changed_paths: Type.Array(RepoPathSchema, { minItems: 1, maxItems: MAX_TASK_CHANGED_FILES, uniqueItems: true }),
  deadline_at: TimestampSchema,
  plan_digest: DigestSchema,
}, { additionalProperties: false });

const ValidationCommandResultSchema = Type.Object({
  command_id: SafeIdSchema,
  started_at: TimestampSchema,
  completed_at: TimestampSchema,
  exit_code: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
  timed_out: Type.Boolean(),
  output_digest: DigestSchema,
  redacted_summary: Type.String({ maxLength: 4_000 }),
  head_before: CommitSchema,
  head_after: CommitSchema,
  tree_digest_before: DigestSchema,
  tree_digest_after: DigestSchema,
}, { additionalProperties: false });

export const ValidationResultSchema = Type.Object({
  schema_version: Type.Literal(TASK_LIFECYCLE_SCHEMA_VERSION),
  task_id: SafeIdSchema,
  expected_base_commit: CommitSchema,
  expected_branch: Type.String({ minLength: 1, maxLength: 256 }),
  builder_commit: CommitSchema,
  final_commit: CommitSchema,
  changed_files: Type.Array(RepoPathSchema, { maxItems: MAX_TASK_CHANGED_FILES, uniqueItems: true }),
  untracked_files: Type.Array(RepoPathSchema, { maxItems: MAX_TASK_CHANGED_FILES, uniqueItems: true }),
  commands: Type.Array(ValidationCommandResultSchema, { minItems: 1, maxItems: 64 }),
  policy_verdict: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
  policy_reasons: StringListSchema,
  started_at: TimestampSchema,
  completed_at: TimestampSchema,
  final_tree_digest: DigestSchema,
}, { additionalProperties: false });

export const ReviewerVerdictSchema = Type.Object({
  schema_version: Type.Literal(TASK_LIFECYCLE_SCHEMA_VERSION),
  task_id: SafeIdSchema,
  issue_number: Type.Integer({ minimum: 1 }),
  expected_base_commit: CommitSchema,
  reviewed_commit: CommitSchema,
  reviewer_agent_id: SafeIdSchema,
  builder_agent_id: SafeIdSchema,
  verdict: Type.Union([Type.Literal("approved"), Type.Literal("changes_requested"), Type.Literal("blocked"), Type.Literal("unsafe")]),
  findings: Type.Array(ReviewerFindingSchema, { maxItems: 64 }),
  summary: TextSchema,
  reviewed_at: TimestampSchema,
  verdict_digest: DigestSchema,
}, { additionalProperties: false });

function schemaErrors(schema: TSchema, value: unknown): string {
  return [...Value.Errors(schema, value)]
    .slice(0, 12)
    .map((error) => {
      const detail = error as { path?: string; instancePath?: string; message: string };
      return `${detail.path || detail.instancePath || "(root)"}: ${detail.message}`;
    })
    .join("; ");
}

function validateValue<T>(schema: TSchema, value: unknown, label: string): T {
  if (!Value.Check(schema, value)) {
    throw new TaskLifecycleError("invalid_input", `${label} failed schema validation: ${schemaErrors(schema, value)}`);
  }
  return value as T;
}

function assertDigestBound<T extends Record<string, unknown>>(value: T, digestField: keyof T, label: string): void {
  const copy = { ...value, [digestField]: undefined };
  if (value[digestField] !== digestTaskValue(copy)) {
    throw new TaskLifecycleError("invalid_input", `${label} digest does not match its typed content`);
  }
}

export function validateTrustedIssueEvent(value: unknown): TrustedIssueEvent {
  return validateValue<TrustedIssueEvent>(TrustedIssueEventSchema, value, "trusted issue event");
}

export function validateTaskLifecyclePolicy(value: unknown): TaskLifecyclePolicy {
  const policy = validateValue<TaskLifecyclePolicy>(TaskLifecyclePolicySchema, value, "task lifecycle policy");
  const normalized = {
    ...policy,
    protected_paths: normalizeTaskPaths(policy.protected_paths, "protected path"),
    allowed_write_paths: normalizeTaskPaths(policy.allowed_write_paths, "allowed write path"),
    forbidden_actions: sortedTaskStrings(policy.forbidden_actions),
  };
  if (normalized.allowed_write_paths.length === 0) {
    throw new TaskLifecycleError("invalid_input", "task lifecycle policy has no application write scope");
  }
  if (normalized.validation_commands.length === 0 || !normalized.validation_commands.some((command) => command.required)) {
    throw new TaskLifecycleError("invalid_input", "task lifecycle policy requires at least one required validation command");
  }
  const ids = normalized.validation_commands.map((command) => command.command_id);
  if (new Set(ids).size !== ids.length) {
    throw new TaskLifecycleError("invalid_input", "task lifecycle validation command IDs must be unique");
  }
  const expected = digestTaskValue({ ...normalized, policy_digest: undefined });
  if (normalized.policy_digest !== expected) {
    throw new TaskLifecycleError("invalid_input", "task lifecycle policy digest does not match its typed content");
  }
  return normalized;
}

export function validateDurableTaskState(value: unknown): DurableTaskState {
  const state = validateValue<DurableTaskState>(DurableTaskStateSchema, value, "durable task state");
  assertDurableTaskState(state);
  return state;
}

export function validateOrchestratorPlan(value: unknown): OrchestratorPlan {
  const plan = validateValue<OrchestratorPlan>(OrchestratorPlanSchema, value, "orchestrator plan");
  assertDigestBound(plan as unknown as Record<string, unknown>, "plan_digest", "orchestrator plan");
  return plan;
}

export function validateSpecialistConsultationResult(value: unknown): SpecialistConsultationResult {
  const result = validateValue<SpecialistConsultationResult>(SpecialistConsultationResultSchema, value, "specialist consultation");
  assertDigestBound(result as unknown as Record<string, unknown>, "result_digest", "specialist consultation");
  return result;
}

export function validateBuilderRequest(value: unknown): BuilderRequest {
  const request = validateValue<BuilderRequest>(BuilderRequestSchema, value, "builder request");
  return {
    ...request,
    protected_paths: normalizeTaskPaths(request.protected_paths, "builder protected path"),
    allowed_paths: normalizeTaskPaths(request.allowed_paths, "builder allowed path"),
    selected_procedure_ids: sortedTaskStrings(request.selected_procedure_ids),
    memory_record_ids: sortedTaskStrings(request.memory_record_ids),
  };
}

export function validateBuilderModelSubmission(value: unknown): BuilderModelSubmission {
  return validateValue<BuilderModelSubmission>(BuilderModelSubmissionSchema, value, "builder model submission");
}

export function validateBuilderCallEvidence(value: unknown): BuilderCallEvidence {
  const evidence = validateValue<BuilderCallEvidence>(BuilderCallEvidenceSchema, value, "builder call evidence");
  assertDigestBound(evidence as unknown as Record<string, unknown>, "evidence_digest", "builder call evidence");
  return evidence;
}

export function validateBuilderResult(value: unknown): BuilderResult {
  return validateValue<BuilderResult>(BuilderResultSchema, value, "builder result");
}

export function validateValidationPlan(value: unknown): ValidationPlan {
  const plan = validateValue<ValidationPlan>(ValidationPlanSchema, value, "validation plan");
  return {
    ...plan,
    protected_paths: normalizeTaskPaths(plan.protected_paths, "validation protected path"),
    allowed_changed_paths: normalizeTaskPaths(plan.allowed_changed_paths, "validation allowed path"),
  };
}

export function validateValidationResult(value: unknown): ValidationResult {
  return validateValue<ValidationResult>(ValidationResultSchema, value, "validation result");
}

export function validateReviewerVerdict(value: unknown): ReviewerVerdict {
  const verdict = validateValue<ReviewerVerdict>(ReviewerVerdictSchema, value, "reviewer verdict");
  assertDigestBound(verdict as unknown as Record<string, unknown>, "verdict_digest", "reviewer verdict");
  if (verdict.reviewer_agent_id === verdict.builder_agent_id) {
    throw new TaskLifecycleError("invalid_input", "builder and reviewer identities must be independent");
  }
  return verdict;
}

export function validateAcceptedTaskEvidence(value: unknown): AcceptedTaskEvidence {
  return validateValue<AcceptedTaskEvidence>(AcceptedTaskEvidenceSchema, value, "accepted task evidence");
}
