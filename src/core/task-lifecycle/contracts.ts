import type { AgentExecutionPolicy } from "../security/execution-policy.ts";
import type {
  ProcedureDefinition,
  SpecialistDefinition,
  SpecialistRoutingReport,
} from "../specialists/contracts.ts";

export const TASK_LIFECYCLE_SCHEMA_VERSION = "1" as const;
export const TASK_STATE_FORMAT = "agentify_task_state" as const;
export const TASK_STATE_COMMENT_MARKER = "agentify-task-state:v1" as const;
export const DEFAULT_MAX_FIX_CYCLES = 2;
export const MAX_TASK_EVENT_IDS = 256;
export const MAX_TASK_CHANGED_FILES = 512;
export const MAX_TASK_MODEL_CALLS = 32;
export const MAX_TASK_COMMENT_BYTES = 60 * 1024;
export const TASK_RUNTIME_PROTECTED_PATHS = [
  ".agentify-runtime",
  ".agentify/policies",
  ".github/agentify",
  ".github/agentify-task-policy.json",
  ".github/workflows/agentify-issue.yml",
] as const;

export type TaskLifecycleState =
  | "new"
  | "needs-information"
  | "ready"
  | "planned"
  | "awaiting-approval"
  | "approved"
  | "implementing"
  | "validating"
  | "reviewing"
  | "fixing"
  | "draft-pr-open"
  | "completed"
  | "stopped"
  | "refused"
  | "blocked"
  | "stale-base"
  | "budget-exhausted"
  | "failed"
  | "recovering";

export type ActiveTaskState = Exclude<
  TaskLifecycleState,
  "completed" | "stopped" | "refused" | "blocked" | "budget-exhausted" | "failed"
>;

export type TaskCommandKind =
  | "queue"
  | "approve"
  | "stop"
  | "retry"
  | "replan"
  | "explain";

export type RepositoryPermission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

export interface RepositoryIdentity {
  repository_id: string;
  full_name: string;
  default_branch: string;
}

export interface TrustedIssueActor {
  login: string;
  type: "User" | "Bot" | "Organization" | "Unknown";
  permission: RepositoryPermission;
}

export interface TrustedIssueEvent {
  schema_version: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  delivery_id: string;
  event_name: "issues" | "issue_comment";
  action: "labeled" | "created" | "edited" | "deleted" | "other";
  repository: RepositoryIdentity;
  installation_repository_id: string;
  issue_number: number;
  issue_state: "open" | "closed";
  issue_is_pull_request: boolean;
  issue_title: string;
  issue_body: string;
  actor: TrustedIssueActor;
  label_name: string | null;
  comment_id: number | null;
  comment_body: string | null;
  comment_created_at: string | null;
  comment_updated_at: string | null;
  received_at: string;
}

export type ParsedIssueCommand =
  | {
      disposition: "accepted";
      command: TaskCommandKind;
      event_id: string;
      issue_number: number;
      actor: TrustedIssueActor;
    }
  | {
      disposition: "ignored" | "unauthorized" | "invalid";
      command: null;
      event_id: string;
      issue_number: number;
      reason: string;
    };

export interface TaskApproval {
  approver: string;
  plan_digest: string;
  expected_base_commit: string;
  approved_at: string;
  expires_at: string;
  policy_digest: string;
}

export type TaskModelRole = "specialist" | "builder" | "reviewer";

export interface TaskActiveModelCall {
  call_id: string;
  role: TaskModelRole;
  phase: string;
  reserved_cost_usd: number;
  started_at: string;
}

export interface TaskModelUsage {
  turns: number;
  cost_usd: number | null;
  runtime_ms: number;
  aborted: boolean;
}

export interface TaskStateEventIdentity {
  event_id: string;
  actor: string;
  reason: string;
  occurred_at: string;
}

export interface TaskBudgetState {
  maximum_cost_usd: number;
  measured_cost_usd: number;
  estimated_cost_usd: number;
  reserved_cost_usd: number;
  model_calls: number;
  maximum_model_calls: number;
  started_at: string;
  deadline_at: string;
  maximum_runtime_ms: number;
}

export type TaskExternalMutation =
  | "state-created"
  | "plan-recorded"
  | "approval-recorded"
  | "branch-created"
  | "builder-commit"
  | "validation-completed"
  | "review-completed"
  | "fix-committed"
  | "branch-pushed"
  | "draft-pr-created"
  | "projection-updated";

export interface TaskRecoveryMetadata {
  recovery_id: string;
  target_state: TaskLifecycleState;
  checkpoint: TaskExternalMutation | null;
  completed_mutations: TaskExternalMutation[];
  owned_resources: TaskOwnedResource[];
  attempt: number;
  started_at: string;
  updated_at: string;
}

export interface TaskOwnedResource {
  kind: "state-comment" | "branch" | "commit" | "artifact" | "pull-request" | "projection-comment";
  identity: string;
  ownership_digest: string;
}

export interface TaskDraftPullRequestIdentity {
  number: number;
  url: string;
  head_branch: string;
  base_branch: string;
  head_commit: string;
  draft: true;
}

export interface TaskAcceptedMergeIdentity {
  repository_id: string;
  task_id: string;
  issue_number: number;
  pull_request_number: number;
  head_branch: string;
  validated_head_commit: string;
  merge_commit: string;
  default_branch: string;
  merge_actor: string;
  event_id: string;
  merged_at: string;
}

export interface DurableTaskState {
  format: typeof TASK_STATE_FORMAT;
  schema_version: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  repository: RepositoryIdentity;
  issue_number: number;
  task_id: string;
  revision: number;
  current_state: TaskLifecycleState;
  expected_base_commit: string;
  active_branch: string | null;
  draft_pr: TaskDraftPullRequestIdentity | null;
  policy_digest: string;
  plan_digest: string | null;
  selected_specialist_ids: string[];
  selected_procedure_ids: string[];
  approval: TaskApproval | null;
  budget: TaskBudgetState;
  active_model_call: TaskActiveModelCall | null;
  retry_count: number;
  fix_cycle_count: number;
  maximum_fix_cycles: number;
  event_ids: string[];
  created_at: string;
  updated_at: string;
  prior_state_digest: string | null;
  current_digest: string;
  failure_reason: string | null;
  recovery: TaskRecoveryMetadata | null;
  accepted_task_evidence_ref: string | null;
  accepted_merge: TaskAcceptedMergeIdentity | null;
  final_commit: string | null;
  builder_result_digest: string | null;
  validation_result_digest: string | null;
  reviewer_verdict_digest: string | null;
  last_event: TaskStateEventIdentity;
}

export interface TaskStateMutation {
  expected_revision: number;
  event_id: string;
  actor: string;
  transition_to?: TaskLifecycleState;
  expected_current_state?: TaskLifecycleState;
  reason: string;
  now: string;
  patch?: {
    expected_base_commit?: string;
    active_branch?: string | null;
    draft_pr?: TaskDraftPullRequestIdentity | null;
    policy_digest?: string;
    plan_digest?: string | null;
    selected_specialist_ids?: string[];
    selected_procedure_ids?: string[];
    approval?: TaskApproval | null;
    budget?: TaskBudgetState;
    active_model_call?: TaskActiveModelCall | null;
    retry_count?: number;
    fix_cycle_count?: number;
    failure_reason?: string | null;
    recovery?: TaskRecoveryMetadata | null;
    accepted_task_evidence_ref?: string | null;
    accepted_merge?: TaskAcceptedMergeIdentity | null;
    final_commit?: string | null;
    builder_result_digest?: string | null;
    validation_result_digest?: string | null;
    reviewer_verdict_digest?: string | null;
  };
}

export interface TaskStateMutationResult {
  status: "applied" | "duplicate";
  state: DurableTaskState;
  intermediate_states?: DurableTaskState[];
}

export interface IssueAcceptanceCriterion {
  criterion_id: string;
  statement: string;
  verification: string;
}

export type TaskRiskCategory = "low" | "medium" | "high" | "critical";

export type ReadinessReasonCode =
  | "issue_closed"
  | "unauthorized_actor"
  | "repository_mismatch"
  | "active_task_conflict"
  | "pull_request_conflict"
  | "stale_base"
  | "missing_acceptance_criteria"
  | "missing_scope"
  | "missing_validation"
  | "protected_path_policy_unknown"
  | "unsafe_secret_or_service_requirement"
  | "validation_policy_stale"
  | "budget_unavailable"
  | "forbidden_merge"
  | "forbidden_deployment"
  | "forbidden_credential_exposure"
  | "forbidden_policy_expansion"
  | "forbidden_history_rewrite"
  | "forbidden_default_branch_write";

export interface TaskReadinessInput {
  repository: RepositoryIdentity;
  installation_repository_id: string;
  issue_number: number;
  issue_open: boolean;
  actor_authorized: boolean;
  expected_base_commit: string;
  current_base_commit: string;
  active_task_id: string | null;
  conflicting_pull_request: number | null;
  acceptance_criteria: IssueAcceptanceCriterion[];
  proposed_paths: string[];
  validation_commands: ValidationCommandSpec[];
  protected_path_policy_known: boolean;
  validation_services_attested: boolean;
  validation_policy_current: boolean;
  available_budget_usd: number;
  issue_text: string;
}

export interface TaskReadinessReason {
  code: ReadinessReasonCode;
  message: string;
}

export interface TaskReadinessDecision {
  disposition: "ready" | "needs-information" | "refused" | "blocked" | "stale-base";
  reasons: TaskReadinessReason[];
  clarification_questions: string[];
  risk_category: TaskRiskCategory;
}

export interface PlanRiskControl {
  control_id: string;
  description: string;
  enforcement: "policy" | "validation" | "approval" | "review";
}

export interface PlanSpecialistSelection {
  specialist_id: string;
  score: number;
  reasons: string[];
}

export interface PlanProcedureSelection {
  procedure_id: string;
  score: number;
  reasons: string[];
}

export interface TaskImplementationStep {
  step_id: string;
  description: string;
  in_scope_paths: string[];
  required_procedure_ids: string[];
  validation_command_ids: string[];
}

export interface TaskMemoryExcerpt {
  memory_id: string;
  kind: "codebase" | "procedure" | "episode" | "specialist" | "orchestrator" | "policy";
  owning_agent_id: string;
  statement: string;
  freshness: "current";
  context_role: "active-guidance" | "prior-episode";
  relevant_payload: string;
  evidence_ids: string[];
  evidence_paths: string[];
  supporting_commit: string;
}

export interface OrchestratorPlan {
  schema_version: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  task_id: string;
  repository: RepositoryIdentity;
  issue_number: number;
  expected_base_commit: string;
  task_summary: string;
  acceptance_criteria: IssueAcceptanceCriterion[];
  in_scope_paths: string[];
  excluded_paths: string[];
  selected_specialists: PlanSpecialistSelection[];
  selected_procedures: PlanProcedureSelection[];
  implementation_steps: TaskImplementationStep[];
  validation_commands: ValidationCommandSpec[];
  security_controls: PlanRiskControl[];
  risk_category: TaskRiskCategory;
  migration_implications: string[];
  documentation_expectations: string[];
  approval_required: boolean;
  estimated_model_calls: number;
  estimated_cost_usd: number;
  escalation_conditions: string[];
  memory_record_ids: string[];
  memory_excerpts: TaskMemoryExcerpt[];
  routing_digest: string;
  policy_digest: string;
  created_at: string;
  plan_digest: string;
}

export interface SpecialistConsultationRequest {
  task_id: string;
  issue_number: number;
  expected_base_commit: string;
  specialist: SpecialistDefinition;
  selected_procedures: ProcedureDefinition[];
  bounded_context_paths: string[];
  task_summary: string;
  acceptance_criteria: IssueAcceptanceCriterion[];
}

export interface SpecialistFinding {
  finding_id: string;
  statement: string;
  evidence_paths: string[];
  severity: "info" | "warning" | "blocking";
}

export interface SpecialistConsultationResult {
  schema_version: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  task_id: string;
  specialist_id: string;
  expected_base_commit: string;
  paths: string[];
  contracts: string[];
  patterns: string[];
  pitfalls: string[];
  procedures: string[];
  validation: string[];
  risks: SpecialistFinding[];
  related_specialists: string[];
  unresolved_questions: string[];
  result_digest: string;
}

export interface TaskRoleAuthority {
  role: "orchestrator" | "specialist" | "builder" | "reviewer";
  application_source_write: boolean;
  github_write: false;
  may_approve_result: boolean;
  execution_policy: AgentExecutionPolicy;
  trusted_custom_tools: string[];
}

export interface BuilderRequest {
  schema_version: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  task_id: string;
  repository: RepositoryIdentity;
  issue_number: number;
  expected_base_commit: string;
  branch: string;
  write_root: string;
  protected_paths: string[];
  allowed_paths: string[];
  plan: OrchestratorPlan;
  specialist_findings: SpecialistConsultationResult[];
  selected_procedure_ids: string[];
  memory_record_ids: string[];
  fix_cycle: number;
  reviewer_findings: ReviewerFinding[];
  execution_policy_digest: string;
}

export interface BuilderAttempt {
  sequence: number;
  approach: string;
  result: "succeeded" | "failed" | "cancelled";
  failure_category: string | null;
  signal: string;
  correction: string | null;
}

export interface BuilderModelSubmission {
  summary: string;
  attempts: BuilderAttempt[];
  turns: number;
  cost_usd: number | null;
  runtime_ms: number;
  aborted: boolean;
}

export interface BuilderCallEvidence {
  schema_version: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  task_id: string;
  call_id: string;
  fix_cycle: number;
  builder_agent_id: string;
  started_at: string;
  completed_at: string;
  submission: BuilderModelSubmission;
  evidence_digest: string;
}

export interface BuilderResult {
  schema_version: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  task_id: string;
  issue_number: number;
  expected_base_commit: string;
  branch: string;
  builder_agent_id: string;
  started_at: string;
  completed_at: string;
  commit_shas: string[];
  final_commit: string;
  changed_files: string[];
  untracked_files: string[];
  summary: string;
  attempts: BuilderAttempt[];
  cost_usd: number | null;
  runtime_ms: number;
}

export interface ValidationCommandSpec {
  command_id: string;
  argv: string[];
  cwd: string;
  timeout_ms: number;
  required: boolean;
  mutation_allowed: false;
  source: "repository-policy" | "procedure" | "plan";
}

export interface ValidationPlan {
  schema_version: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  task_id: string;
  expected_base_commit: string;
  expected_branch: string;
  expected_builder_commit: string;
  commands: ValidationCommandSpec[];
  protected_paths: string[];
  allowed_changed_paths: string[];
  deadline_at: string;
  plan_digest: string;
}

export interface ValidationCommandResult {
  command_id: string;
  started_at: string;
  completed_at: string;
  exit_code: number | null;
  timed_out: boolean;
  output_digest: string;
  redacted_summary: string;
  head_before: string;
  head_after: string;
  tree_digest_before: string;
  tree_digest_after: string;
}

export interface ValidationResult {
  schema_version: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  task_id: string;
  expected_base_commit: string;
  expected_branch: string;
  builder_commit: string;
  final_commit: string;
  changed_files: string[];
  untracked_files: string[];
  commands: ValidationCommandResult[];
  policy_verdict: "passed" | "failed";
  policy_reasons: string[];
  started_at: string;
  completed_at: string;
  final_tree_digest: string;
}

export type ReviewerVerdictKind = "approved" | "changes_requested" | "blocked" | "unsafe";

export interface ReviewerFinding {
  finding_id: string;
  severity: "minor" | "major" | "critical";
  path: string | null;
  statement: string;
  required_change: string | null;
  acceptance_criterion_ids: string[];
}

export interface ReviewerVerdict {
  schema_version: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  task_id: string;
  issue_number: number;
  expected_base_commit: string;
  reviewed_commit: string;
  reviewer_agent_id: string;
  builder_agent_id: string;
  verdict: ReviewerVerdictKind;
  findings: ReviewerFinding[];
  summary: string;
  reviewed_at: string;
  verdict_digest: string;
}

export interface DraftPublicationAssessmentInput {
  state: DurableTaskState;
  plan: OrchestratorPlan;
  validation: ValidationResult;
  reviewer: ReviewerVerdict;
  branch_owned: boolean;
  current_base_commit: string;
  current_head_commit: string;
  current_tree_digest: string;
  conflicting_pull_request: number | null;
  approval_now: string;
  accepted_task_evidence_ref: string;
}

export interface DraftPublicationDecision {
  allowed: boolean;
  reasons: string[];
  title: string;
  body: string;
  head_branch: string;
  base_branch: string;
  draft: true;
}

export interface TaskLifecyclePolicy {
  policy_digest: string;
  approval_required: boolean;
  approval_ttl_ms: number;
  maximum_cost_usd: number;
  maximum_runtime_ms: number;
  maximum_model_calls: number;
  maximum_fix_cycles: number;
  protected_paths: string[];
  allowed_write_paths: string[];
  validation_commands: ValidationCommandSpec[];
  forbidden_actions: string[];
}

export interface TaskPlanningInput {
  cwd: string;
  task_id: string;
  repository: RepositoryIdentity;
  issue_number: number;
  expected_base_commit: string;
  task_summary: string;
  acceptance_criteria: IssueAcceptanceCriterion[];
  candidate_paths: string[];
  excluded_paths: string[];
  risk_category: TaskRiskCategory;
  implementation_steps: TaskImplementationStep[];
  portfolio: {
    specialists: SpecialistDefinition[];
    procedures: ProcedureDefinition[];
    supporting_commit: string;
    schema_version: "1";
    source_map_digest: string;
    evidence_paths: string[];
    warnings: string[];
  };
  policy: TaskLifecyclePolicy;
  now: string;
  prior_successful_specialist_ids?: string[];
}

export interface TaskPlanningResult {
  plan: OrchestratorPlan;
  routing: SpecialistRoutingReport;
  consultations: SpecialistConsultationResult[];
}
