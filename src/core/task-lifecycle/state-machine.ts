import {
  DEFAULT_MAX_FIX_CYCLES,
  MAX_TASK_EVENT_IDS,
  TASK_LIFECYCLE_SCHEMA_VERSION,
  TASK_STATE_FORMAT,
  type DurableTaskState,
  type RepositoryIdentity,
  type TaskApproval,
  type TaskBudgetState,
  type TaskExternalMutation,
  type TaskLifecyclePolicy,
  type TaskModelRole,
  type TaskModelUsage,
  type TaskLifecycleState,
  type TaskOwnedResource,
  type TaskRecoveryMetadata,
  type TaskStateMutation,
  type TaskStateMutationResult,
} from "./contracts.ts";
import {
  computeTaskStateDigest,
  digestTaskValue,
  sortedTaskStrings,
  taskSlug,
} from "./serialization.ts";

export type TaskLifecycleErrorCode =
  | "invalid_input"
  | "corrupt_state"
  | "revision_conflict"
  | "invalid_transition"
  | "approval_invalid"
  | "fix_cycle_exhausted"
  | "resource_conflict";

export class TaskLifecycleError extends Error {
  readonly code: TaskLifecycleErrorCode;

  constructor(code: TaskLifecycleErrorCode, message: string) {
    super(message);
    this.name = "TaskLifecycleError";
    this.code = code;
  }
}

const TRANSITIONS: Readonly<Record<TaskLifecycleState, ReadonlySet<TaskLifecycleState>>> = {
  "new": new Set(["needs-information", "ready", "refused", "blocked", "budget-exhausted", "stopped", "failed", "recovering"]),
  "needs-information": new Set(["ready", "refused", "blocked", "budget-exhausted", "stopped", "failed", "recovering"]),
  "ready": new Set(["planned", "needs-information", "refused", "blocked", "stale-base", "budget-exhausted", "stopped", "failed", "recovering"]),
  "planned": new Set(["awaiting-approval", "approved", "ready", "refused", "blocked", "stale-base", "budget-exhausted", "stopped", "failed", "recovering"]),
  "awaiting-approval": new Set(["approved", "ready", "refused", "blocked", "stale-base", "budget-exhausted", "stopped", "failed", "recovering"]),
  "approved": new Set(["implementing", "ready", "blocked", "stale-base", "budget-exhausted", "stopped", "failed", "recovering"]),
  "implementing": new Set(["validating", "blocked", "stale-base", "budget-exhausted", "stopped", "failed", "recovering"]),
  "validating": new Set(["reviewing", "fixing", "blocked", "stale-base", "budget-exhausted", "stopped", "failed", "recovering"]),
  "reviewing": new Set(["fixing", "draft-pr-open", "blocked", "refused", "stale-base", "budget-exhausted", "stopped", "failed", "recovering"]),
  "fixing": new Set(["validating", "blocked", "stale-base", "budget-exhausted", "stopped", "failed", "recovering"]),
  "draft-pr-open": new Set(["completed", "blocked", "stopped", "failed", "recovering"]),
  "completed": new Set([]),
  "stopped": new Set(["recovering", "ready"]),
  "refused": new Set(["ready"]),
  "blocked": new Set(["recovering", "ready", "stopped"]),
  "stale-base": new Set(["ready", "stopped", "recovering"]),
  "budget-exhausted": new Set(["ready", "stopped", "recovering"]),
  "failed": new Set(["recovering", "ready", "stopped"]),
  "recovering": new Set([
    "new",
    "needs-information",
    "ready",
    "planned",
    "awaiting-approval",
    "approved",
    "implementing",
    "validating",
    "reviewing",
    "fixing",
    "draft-pr-open",
    "completed",
    "stopped",
    "refused",
    "blocked",
    "stale-base",
    "budget-exhausted",
    "failed",
  ]),
};

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TaskLifecycleError("invalid_input", `${label} must be an ISO timestamp`);
  }
}

function assertCommit(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new TaskLifecycleError("invalid_input", `${label} must be a full 40-character Git commit SHA`);
  }
}

function normalizeBudget(budget: TaskBudgetState): TaskBudgetState {
  for (const [label, value] of Object.entries({
    maximum_cost_usd: budget.maximum_cost_usd,
    measured_cost_usd: budget.measured_cost_usd,
    estimated_cost_usd: budget.estimated_cost_usd,
    reserved_cost_usd: budget.reserved_cost_usd,
    model_calls: budget.model_calls,
    maximum_model_calls: budget.maximum_model_calls,
    maximum_runtime_ms: budget.maximum_runtime_ms,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TaskLifecycleError("invalid_input", `task budget ${label} must be a non-negative finite number`);
    }
  }
  if (!Number.isSafeInteger(budget.model_calls) || !Number.isSafeInteger(budget.maximum_model_calls)) {
    throw new TaskLifecycleError("invalid_input", "task model call counters must be safe integers");
  }
  assertTimestamp(budget.started_at, "task budget started_at");
  assertTimestamp(budget.deadline_at, "task budget deadline_at");
  if (Date.parse(budget.deadline_at) <= Date.parse(budget.started_at)) {
    throw new TaskLifecycleError("invalid_input", "task deadline must follow task start");
  }
  return { ...budget };
}

function makeTaskId(repository: RepositoryIdentity, issueNumber: number): string {
  const repositorySlug = taskSlug(repository.full_name, 48);
  return `task-${repositorySlug}-${issueNumber}-${digestTaskValue({ repository, issueNumber }).slice(0, 12)}`;
}

export function taskBranchName(issueNumber: number, issueTitle: string): string {
  return `agentify/issue-${issueNumber}-${taskSlug(issueTitle, 48)}`;
}

export function makeInitialTaskState(input: {
  repository: RepositoryIdentity;
  issue_number: number;
  expected_base_commit: string;
  policy: TaskLifecyclePolicy;
  event_id: string;
  now: string;
  actor?: string;
}): DurableTaskState {
  if (!Number.isSafeInteger(input.issue_number) || input.issue_number < 1) {
    throw new TaskLifecycleError("invalid_input", "issue number must be a positive integer");
  }
  assertCommit(input.expected_base_commit, "expected base commit");
  assertTimestamp(input.now, "task creation timestamp");
  const maximumFixCycles = input.policy.maximum_fix_cycles ?? DEFAULT_MAX_FIX_CYCLES;
  const deadlineAt = new Date(Date.parse(input.now) + input.policy.maximum_runtime_ms).toISOString();
  const withoutDigest: DurableTaskState = {
    format: TASK_STATE_FORMAT,
    schema_version: TASK_LIFECYCLE_SCHEMA_VERSION,
    repository: { ...input.repository },
    issue_number: input.issue_number,
    task_id: makeTaskId(input.repository, input.issue_number),
    revision: 1,
    current_state: "new",
    expected_base_commit: input.expected_base_commit,
    active_branch: null,
    draft_pr: null,
    policy_digest: input.policy.policy_digest,
    plan_digest: null,
    selected_specialist_ids: [],
    selected_procedure_ids: [],
    approval: null,
    budget: normalizeBudget({
      maximum_cost_usd: input.policy.maximum_cost_usd,
      measured_cost_usd: 0,
      estimated_cost_usd: 0,
      reserved_cost_usd: 0,
      model_calls: 0,
      maximum_model_calls: input.policy.maximum_model_calls,
      started_at: input.now,
      deadline_at: deadlineAt,
      maximum_runtime_ms: input.policy.maximum_runtime_ms,
    }),
    active_model_call: null,
    retry_count: 0,
    fix_cycle_count: 0,
    maximum_fix_cycles: maximumFixCycles,
    event_ids: [input.event_id],
    created_at: input.now,
    updated_at: input.now,
    prior_state_digest: null,
    current_digest: "",
    failure_reason: null,
    recovery: null,
    accepted_merge: null,
    accepted_task_evidence_ref: null,
    final_commit: null,
    builder_result_digest: null,
    validation_result_digest: null,
    reviewer_verdict_digest: null,
    last_event: {
      event_id: input.event_id,
      actor: input.actor ?? "trusted-runtime",
      reason: "create durable task state",
      occurred_at: input.now,
    },
  };
  withoutDigest.current_digest = computeTaskStateDigest(withoutDigest);
  assertDurableTaskState(withoutDigest);
  return withoutDigest;
}

export function assertDurableTaskState(state: DurableTaskState): void {
  if (state.format !== TASK_STATE_FORMAT || state.schema_version !== TASK_LIFECYCLE_SCHEMA_VERSION) {
    throw new TaskLifecycleError("corrupt_state", "unsupported Agentify task state format");
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) {
    throw new TaskLifecycleError("corrupt_state", "task state revision is invalid");
  }
  assertCommit(state.expected_base_commit, "task state expected base commit");
  assertTimestamp(state.created_at, "task state created_at");
  assertTimestamp(state.updated_at, "task state updated_at");
  if (Date.parse(state.updated_at) < Date.parse(state.created_at)) {
    throw new TaskLifecycleError("corrupt_state", "task state updated_at precedes created_at");
  }
  if (state.event_ids.length > MAX_TASK_EVENT_IDS || new Set(state.event_ids).size !== state.event_ids.length) {
    throw new TaskLifecycleError("corrupt_state", "task event ledger is duplicated or exceeds its bound");
  }
  if (
    !Number.isSafeInteger(state.fix_cycle_count)
    || !Number.isSafeInteger(state.maximum_fix_cycles)
    || state.fix_cycle_count < 0
    || state.maximum_fix_cycles < 0
    || state.fix_cycle_count > state.maximum_fix_cycles
  ) {
    throw new TaskLifecycleError("corrupt_state", "task fix-cycle counters are invalid");
  }
  normalizeBudget(state.budget);
  assertTimestamp(state.last_event.occurred_at, "task last event timestamp");
  if (!state.last_event.event_id.trim() || !state.last_event.actor.trim() || !state.last_event.reason.trim()) {
    throw new TaskLifecycleError("corrupt_state", "task last event identity is incomplete");
  }
  if (state.last_event.event_id !== state.event_ids.at(-1)) {
    throw new TaskLifecycleError("corrupt_state", "task last event does not match the event ledger tail");
  }
  if (state.active_model_call) {
    assertTimestamp(state.active_model_call.started_at, "active model call started_at");
    if (!state.active_model_call.call_id.trim() || !state.active_model_call.phase.trim()) {
      throw new TaskLifecycleError("corrupt_state", "active model call identity is incomplete");
    }
    if (state.active_model_call.reserved_cost_usd <= 0) {
      throw new TaskLifecycleError("corrupt_state", "active model call reservation must be positive");
    }
    if (state.budget.reserved_cost_usd !== state.active_model_call.reserved_cost_usd) {
      throw new TaskLifecycleError("corrupt_state", "task reserved cost does not match the active model call");
    }
  } else if (state.budget.reserved_cost_usd !== 0) {
    throw new TaskLifecycleError("corrupt_state", "task has reserved cost without an active model call");
  }
  const expectedDigest = computeTaskStateDigest(state);
  if (state.current_digest !== expectedDigest) {
    throw new TaskLifecycleError("corrupt_state", "task state digest does not match its content");
  }
  if (state.approval) assertTaskApproval(state.approval, state, state.updated_at, false);
  if (state.final_commit !== null) assertCommit(state.final_commit, "task final commit");
  for (const [label, value] of Object.entries({
    builder_result_digest: state.builder_result_digest,
    validation_result_digest: state.validation_result_digest,
    reviewer_verdict_digest: state.reviewer_verdict_digest,
  })) {
    if (value !== null && !/^[0-9a-f]{64}$/.test(value)) {
      throw new TaskLifecycleError("corrupt_state", `task ${label} is not a SHA-256 digest`);
    }
  }
  if (state.validation_result_digest !== null && state.builder_result_digest === null) {
    throw new TaskLifecycleError("corrupt_state", "validation evidence cannot exist without builder evidence");
  }
  if (state.reviewer_verdict_digest !== null && state.validation_result_digest === null) {
    throw new TaskLifecycleError("corrupt_state", "review evidence cannot exist without validation evidence");
  }
  if (state.draft_pr && state.draft_pr.draft !== true) {
    throw new TaskLifecycleError("corrupt_state", "Agentify task PR identity must remain draft-only");
  }
  if (state.current_state === "completed" && state.accepted_merge === null) {
    throw new TaskLifecycleError("corrupt_state", "completed task state has no verified accepted merge identity");
  }
  if (state.accepted_merge) {
    const merge = state.accepted_merge;
    if (merge.repository_id !== state.repository.repository_id || merge.task_id !== state.task_id || merge.issue_number !== state.issue_number) {
      throw new TaskLifecycleError("corrupt_state", "accepted merge identity does not match the durable task");
    }
    if (!state.draft_pr || merge.pull_request_number !== state.draft_pr.number || merge.head_branch !== state.draft_pr.head_branch || merge.validated_head_commit !== state.draft_pr.head_commit || merge.validated_head_commit !== state.final_commit) {
      throw new TaskLifecycleError("corrupt_state", "accepted merge identity does not match the validated draft pull request");
    }
  }
}

function assertTransitionAllowed(from: TaskLifecycleState, to: TaskLifecycleState): void {
  if (from === to) return;
  if (!TRANSITIONS[from].has(to)) {
    throw new TaskLifecycleError("invalid_transition", `task state cannot transition from ${from} to ${to}`);
  }
}

function approvalBindingChanged(state: DurableTaskState, next: DurableTaskState): boolean {
  return state.plan_digest !== next.plan_digest
    || state.expected_base_commit !== next.expected_base_commit
    || state.policy_digest !== next.policy_digest;
}

function nextEventLedger(existing: ReadonlyArray<string>, eventId: string): string[] {
  const result = [...existing, eventId];
  return result.length <= MAX_TASK_EVENT_IDS
    ? result
    : result.slice(result.length - MAX_TASK_EVENT_IDS);
}

export function applyTaskStateMutation(
  stateInput: DurableTaskState,
  mutation: TaskStateMutation,
): TaskStateMutationResult {
  assertDurableTaskState(stateInput);
  if (stateInput.event_ids.includes(mutation.event_id)) {
    return { status: "duplicate", state: structuredClone(stateInput) };
  }
  if (mutation.expected_revision !== stateInput.revision) {
    throw new TaskLifecycleError(
      "revision_conflict",
      `task revision ${mutation.expected_revision} is stale; current revision is ${stateInput.revision}`,
    );
  }
  if (mutation.expected_current_state && mutation.expected_current_state !== stateInput.current_state) {
    throw new TaskLifecycleError(
      "revision_conflict",
      `task state is ${stateInput.current_state}, not expected ${mutation.expected_current_state}`,
    );
  }
  assertTimestamp(mutation.now, "task mutation timestamp");
  if (Date.parse(mutation.now) < Date.parse(stateInput.updated_at)) {
    throw new TaskLifecycleError("invalid_input", "task mutation timestamp precedes current state");
  }
  const next = structuredClone(stateInput);
  if (mutation.transition_to) {
    assertTransitionAllowed(stateInput.current_state, mutation.transition_to);
    next.current_state = mutation.transition_to;
  }
  Object.assign(next, mutation.patch ?? {});
  next.selected_specialist_ids = sortedTaskStrings(next.selected_specialist_ids);
  next.selected_procedure_ids = sortedTaskStrings(next.selected_procedure_ids);
  next.budget = normalizeBudget(next.budget);
  if (approvalBindingChanged(stateInput, next)) next.approval = null;
  if (next.fix_cycle_count > next.maximum_fix_cycles) {
    throw new TaskLifecycleError("fix_cycle_exhausted", "task exceeded its maximum builder fix cycles");
  }
  if (next.approval) assertTaskApproval(next.approval, next, mutation.now, false);
  if (next.current_state === "approved" && next.approval === null) {
    throw new TaskLifecycleError("approval_invalid", "approved task state requires a bound approval record");
  }
  next.revision = stateInput.revision + 1;
  next.event_ids = nextEventLedger(stateInput.event_ids, mutation.event_id);
  next.updated_at = mutation.now;
  next.last_event = {
    event_id: mutation.event_id,
    actor: mutation.actor.trim() || "trusted-runtime",
    reason: mutation.reason.trim() || "task state mutation",
    occurred_at: mutation.now,
  };
  next.prior_state_digest = stateInput.current_digest;
  next.current_digest = "";
  next.current_digest = computeTaskStateDigest(next);
  assertDurableTaskState(next);
  return { status: "applied", state: next };
}

export function assertTaskApproval(
  approval: TaskApproval,
  state: DurableTaskState,
  now: string,
  requireUnexpired = true,
): void {
  assertTimestamp(approval.approved_at, "approval timestamp");
  assertTimestamp(approval.expires_at, "approval expiry");
  if (Date.parse(approval.expires_at) <= Date.parse(approval.approved_at)) {
    throw new TaskLifecycleError("approval_invalid", "approval expiry must follow approval timestamp");
  }
  if (approval.plan_digest !== state.plan_digest) {
    throw new TaskLifecycleError("approval_invalid", "approval is bound to a different plan digest");
  }
  if (approval.expected_base_commit !== state.expected_base_commit) {
    throw new TaskLifecycleError("approval_invalid", "approval is bound to a different base commit");
  }
  if (approval.policy_digest !== state.policy_digest) {
    throw new TaskLifecycleError("approval_invalid", "approval is bound to a different policy digest");
  }
  if (requireUnexpired && Date.parse(now) >= Date.parse(approval.expires_at)) {
    throw new TaskLifecycleError("approval_invalid", "approval has expired");
  }
}

export function isTaskWithinBudget(state: DurableTaskState, now: string): boolean {
  const used = state.budget.measured_cost_usd
    + state.budget.estimated_cost_usd
    + state.budget.reserved_cost_usd;
  return used <= state.budget.maximum_cost_usd
    && state.budget.model_calls <= state.budget.maximum_model_calls
    && state.active_model_call === null
    && Date.parse(now) < Date.parse(state.budget.deadline_at);
}

export function isTaskBudgetAvailable(state: DurableTaskState, now: string): boolean {
  return isTaskWithinBudget(state, now)
    && state.budget.measured_cost_usd + state.budget.estimated_cost_usd < state.budget.maximum_cost_usd
    && state.budget.model_calls < state.budget.maximum_model_calls;
}

export function makeTaskApproval(input: {
  state: DurableTaskState;
  approver: string;
  approved_at: string;
  approval_ttl_ms: number;
}): TaskApproval {
  if (!input.state.plan_digest) {
    throw new TaskLifecycleError("approval_invalid", "a plan must be recorded before approval");
  }
  if (!Number.isSafeInteger(input.approval_ttl_ms) || input.approval_ttl_ms <= 0) {
    throw new TaskLifecycleError("invalid_input", "approval TTL must be a positive integer");
  }
  assertTimestamp(input.approved_at, "approval timestamp");
  return {
    approver: input.approver,
    plan_digest: input.state.plan_digest,
    expected_base_commit: input.state.expected_base_commit,
    approved_at: input.approved_at,
    expires_at: new Date(Date.parse(input.approved_at) + input.approval_ttl_ms).toISOString(),
    policy_digest: input.state.policy_digest,
  };
}

function resourceKey(resource: TaskOwnedResource): string {
  return `${resource.kind}:${resource.identity}`;
}

export function reserveTaskModelCall(input: {
  state: DurableTaskState;
  expected_revision: number;
  event_id: string;
  actor: string;
  call_id: string;
  role: TaskModelRole;
  phase: string;
  reservation_cost_usd: number;
  now: string;
}): TaskStateMutationResult {
  if (input.state.active_model_call) {
    if (input.state.active_model_call.call_id === input.call_id) {
      return { status: "duplicate", state: structuredClone(input.state) };
    }
    throw new TaskLifecycleError(
      "resource_conflict",
      `model call ${input.state.active_model_call.call_id} is already active; retry cannot create a second charge`,
    );
  }
  if (!Number.isFinite(input.reservation_cost_usd) || input.reservation_cost_usd <= 0) {
    throw new TaskLifecycleError("invalid_input", "model-call reservation must be a positive finite amount");
  }
  if (!isTaskBudgetAvailable(input.state, input.now)) {
    throw new TaskLifecycleError("invalid_transition", "task budget or deadline is exhausted before model admission");
  }
  const used = input.state.budget.measured_cost_usd + input.state.budget.estimated_cost_usd;
  if (used + input.reservation_cost_usd > input.state.budget.maximum_cost_usd) {
    throw new TaskLifecycleError("invalid_transition", "model-call reservation exceeds the remaining task budget");
  }
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    reason: `reserve bounded ${input.role} model call ${input.phase}`,
    now: input.now,
    patch: {
      active_model_call: {
        call_id: input.call_id,
        role: input.role,
        phase: input.phase,
        reserved_cost_usd: input.reservation_cost_usd,
        started_at: input.now,
      },
      budget: { ...input.state.budget, reserved_cost_usd: input.reservation_cost_usd },
    },
  });
}

export function reconcileTaskModelCall(input: {
  state: DurableTaskState;
  expected_revision: number;
  event_id: string;
  actor: string;
  call_id: string;
  usage: TaskModelUsage;
  now: string;
}): TaskStateMutationResult {
  const active = input.state.active_model_call;
  if (!active || active.call_id !== input.call_id) {
    throw new TaskLifecycleError("resource_conflict", "model-call reconciliation does not match the active reservation");
  }
  if (!Number.isSafeInteger(input.usage.turns) || input.usage.turns < 0) {
    throw new TaskLifecycleError("invalid_input", "model usage turns must be a non-negative integer");
  }
  if (!Number.isSafeInteger(input.usage.runtime_ms) || input.usage.runtime_ms < 0) {
    throw new TaskLifecycleError("invalid_input", "model usage runtime must be a non-negative integer");
  }
  const measured = input.usage.cost_usd;
  if (measured !== null && (!Number.isFinite(measured) || measured < 0)) {
    throw new TaskLifecycleError("invalid_input", "measured model cost must be null or non-negative");
  }
  const measuredDelta = measured ?? 0;
  const estimatedDelta = measured === null ? active.reserved_cost_usd : 0;
  const budget = {
    ...input.state.budget,
    measured_cost_usd: input.state.budget.measured_cost_usd + measuredDelta,
    estimated_cost_usd: input.state.budget.estimated_cost_usd + estimatedDelta,
    reserved_cost_usd: 0,
    model_calls: input.state.budget.model_calls + 1,
  };
  const exhausted = input.usage.aborted
    || budget.model_calls > budget.maximum_model_calls
    || budget.measured_cost_usd + budget.estimated_cost_usd > budget.maximum_cost_usd
    || Date.parse(input.now) >= Date.parse(budget.deadline_at);
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: exhausted ? "budget-exhausted" : undefined,
    reason: `reconcile bounded ${active.role} model call ${active.phase}`,
    now: input.now,
    patch: {
      active_model_call: null,
      budget,
      failure_reason: exhausted
        ? "A model call was aborted or exhausted the configured task budget/deadline."
        : input.state.failure_reason,
    },
  });
}

export function beginTaskRecovery(input: {
  state: DurableTaskState;
  expected_revision: number;
  event_id: string;
  actor: string;
  target_state: TaskLifecycleState;
  checkpoint: TaskExternalMutation | null;
  now: string;
}): TaskStateMutationResult {
  const previous = input.state.recovery;
  const recovery: TaskRecoveryMetadata = previous ?? {
    recovery_id: `recovery-${input.state.task_id}-${input.state.retry_count + 1}`,
    target_state: input.target_state,
    checkpoint: input.checkpoint,
    completed_mutations: [],
    owned_resources: [],
    attempt: input.state.retry_count + 1,
    started_at: input.now,
    updated_at: input.now,
  };
  recovery.target_state = input.target_state;
  recovery.checkpoint = input.checkpoint;
  recovery.updated_at = input.now;
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: "recovering",
    reason: "resume an interrupted trusted mutation",
    now: input.now,
    patch: {
      retry_count: input.state.retry_count + (previous ? 0 : 1),
      recovery,
      failure_reason: null,
    },
  });
}

export function recordTaskExternalMutation(input: {
  state: DurableTaskState;
  expected_revision: number;
  event_id: string;
  actor: string;
  mutation: TaskExternalMutation;
  resource?: TaskOwnedResource;
  now: string;
}): TaskStateMutationResult {
  const recovery = structuredClone(input.state.recovery);
  if (!recovery) {
    throw new TaskLifecycleError("invalid_transition", "external mutation checkpoints require recovering task state");
  }
  if (!recovery.completed_mutations.includes(input.mutation)) {
    recovery.completed_mutations.push(input.mutation);
  }
  if (input.resource) {
    const key = resourceKey(input.resource);
    const existing = recovery.owned_resources.find((resource) => resourceKey(resource) === key);
    if (existing && existing.ownership_digest !== input.resource.ownership_digest) {
      throw new TaskLifecycleError("resource_conflict", `owned ${key} has a conflicting ownership digest`);
    }
    if (!existing) recovery.owned_resources.push(input.resource);
  }
  recovery.completed_mutations = [...new Set(recovery.completed_mutations)];
  recovery.owned_resources = recovery.owned_resources.sort((left, right) =>
    resourceKey(left).localeCompare(resourceKey(right))
  );
  recovery.checkpoint = input.mutation;
  recovery.updated_at = input.now;
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    reason: `record trusted mutation ${input.mutation}`,
    now: input.now,
    patch: { recovery },
  });
}

export function completeTaskRecovery(input: {
  state: DurableTaskState;
  expected_revision: number;
  event_id: string;
  actor: string;
  now: string;
}): TaskStateMutationResult {
  const target = input.state.recovery?.target_state;
  if (!target) throw new TaskLifecycleError("invalid_transition", "task has no active recovery target");
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: target,
    reason: "complete idempotent recovery",
    now: input.now,
    patch: { recovery: null },
  });
}
