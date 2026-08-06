import type {
  BuilderResult,
  DraftPublicationDecision,
  DurableTaskState,
  OrchestratorPlan,
  ReviewerVerdict,
  TaskDraftPullRequestIdentity,
  TaskLifecyclePolicy,
  TaskReadinessDecision,
  TaskStateMutationResult,
  ValidationResult,
} from "./contracts.ts";
import {
  applyTaskStateMutation,
  assertTaskApproval,
  isTaskBudgetAvailable,
  makeTaskApproval,
  taskBranchName,
  TaskLifecycleError,
} from "./state-machine.ts";
import { digestTaskValue } from "./serialization.ts";

export function recordTaskReadiness(input: {
  state: DurableTaskState;
  decision: TaskReadinessDecision;
  expected_revision: number;
  event_id: string;
  actor: string;
  now: string;
}): TaskStateMutationResult {
  const transition = (() => {
    switch (input.decision.disposition) {
      case "ready": return "ready" as const;
      case "needs-information": return "needs-information" as const;
      case "refused": return "refused" as const;
      case "blocked": return "blocked" as const;
      case "stale-base": return "stale-base" as const;
    }
  })();
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: transition,
    reason: `readiness decision: ${input.decision.disposition}`,
    now: input.now,
    patch: {
      failure_reason: input.decision.reasons.map((reason) => reason.message).join(" ") || null,
    },
  });
}

export function recordTaskPlan(input: {
  state: DurableTaskState;
  plan: OrchestratorPlan;
  policy: TaskLifecyclePolicy;
  expected_revision: number;
  event_id: string;
  actor: string;
  now: string;
}): TaskStateMutationResult {
  if (input.state.current_state !== "ready") {
    throw new TaskLifecycleError("invalid_transition", "task must be ready before recording a plan");
  }
  if (
    input.plan.task_id !== input.state.task_id
    || input.plan.issue_number !== input.state.issue_number
    || input.plan.expected_base_commit !== input.state.expected_base_commit
    || input.plan.policy_digest !== input.state.policy_digest
  ) {
    throw new TaskLifecycleError("invalid_input", "orchestrator plan is not bound to the current task state");
  }
  const selectedSpecialistIds = input.plan.selected_specialists.map((selection) => selection.specialist_id);
  const selectedProcedureIds = input.plan.selected_procedures.map((selection) => selection.procedure_id);
  const transition = input.plan.approval_required ? "awaiting-approval" as const : "approved" as const;
  const provisional = applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: `${input.event_id}:plan`,
    actor: input.actor,
    transition_to: "planned",
    reason: "record typed orchestrator plan",
    now: input.now,
    patch: {
      plan_digest: input.plan.plan_digest,
      selected_specialist_ids: selectedSpecialistIds,
      selected_procedure_ids: selectedProcedureIds,
      approval: null,
      failure_reason: null,
    },
  }).state;
  const approval = input.plan.approval_required
    ? null
    : makeTaskApproval({
        state: provisional,
        approver: "policy:auto-approval",
        approved_at: input.now,
        approval_ttl_ms: input.policy.approval_ttl_ms,
      });
  const final = applyTaskStateMutation(provisional, {
    expected_revision: provisional.revision,
    event_id: `${input.event_id}:approval-gate`,
    actor: input.actor,
    transition_to: transition,
    reason: input.plan.approval_required ? "await explicit maintainer approval" : "apply policy auto-approval",
    now: input.now,
    patch: { approval },
  });
  return { ...final, intermediate_states: [provisional] };
}

export function approveTask(input: {
  state: DurableTaskState;
  policy: TaskLifecyclePolicy;
  expected_revision: number;
  event_id: string;
  approver: string;
  now: string;
}): TaskStateMutationResult {
  if (input.state.current_state !== "awaiting-approval") {
    throw new TaskLifecycleError("invalid_transition", "task is not awaiting approval");
  }
  const approval = makeTaskApproval({
    state: input.state,
    approver: input.approver,
    approved_at: input.now,
    approval_ttl_ms: input.policy.approval_ttl_ms,
  });
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.approver,
    transition_to: "approved",
    reason: "authorized maintainer approved the bound plan",
    now: input.now,
    patch: { approval, failure_reason: null },
  });
}

export function beginTaskImplementation(input: {
  state: DurableTaskState;
  issue_title: string;
  current_base_commit: string;
  conflicting_branch: boolean;
  conflicting_pull_request: number | null;
  expected_revision: number;
  event_id: string;
  actor: string;
  now: string;
}): TaskStateMutationResult {
  if (input.state.current_state !== "approved") {
    throw new TaskLifecycleError("invalid_transition", "task must be approved before implementation");
  }
  if (input.current_base_commit !== input.state.expected_base_commit) {
    return applyTaskStateMutation(input.state, {
      expected_revision: input.expected_revision,
      event_id: input.event_id,
      actor: input.actor,
      transition_to: "stale-base",
      reason: "base moved before source mutation",
      now: input.now,
      patch: { approval: null, failure_reason: "Expected base commit is stale; replan before implementation." },
    });
  }
  if (input.conflicting_branch || input.conflicting_pull_request !== null) {
    return applyTaskStateMutation(input.state, {
      expected_revision: input.expected_revision,
      event_id: input.event_id,
      actor: input.actor,
      transition_to: "blocked",
      reason: "owned branch or pull request conflict",
      now: input.now,
      patch: { failure_reason: "A conflicting branch or pull request already claims this task." },
    });
  }
  if (!input.state.approval) throw new TaskLifecycleError("approval_invalid", "task approval is missing");
  assertTaskApproval(input.state.approval, input.state, input.now, true);
  if (!isTaskBudgetAvailable(input.state, input.now)) {
    return applyTaskStateMutation(input.state, {
      expected_revision: input.expected_revision,
      event_id: input.event_id,
      actor: input.actor,
      transition_to: "budget-exhausted",
      reason: "task budget or deadline exhausted before implementation",
      now: input.now,
      patch: { failure_reason: "Task budget or deadline is exhausted." },
    });
  }
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: "implementing",
    reason: "begin one-writer builder phase",
    now: input.now,
    patch: {
      active_branch: taskBranchName(input.state.issue_number, input.issue_title),
      failure_reason: null,
    },
  });
}

export function recordBuilderCompletion(input: {
  state: DurableTaskState;
  builder: BuilderResult;
  assessment: { passed: boolean; reasons: string[] };
  expected_revision: number;
  event_id: string;
  actor: string;
  now: string;
}): TaskStateMutationResult {
  const allowedStates = new Set(["implementing", "fixing"]);
  if (input.state.active_model_call !== null) {
    throw new TaskLifecycleError("invalid_transition", "builder model call must be reconciled before recording completion");
  }
  if (!allowedStates.has(input.state.current_state)) {
    throw new TaskLifecycleError("invalid_transition", "builder completion is not expected in the current task state");
  }
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: input.assessment.passed ? "validating" : "blocked",
    reason: "validate typed builder result",
    now: input.now,
    patch: {
      failure_reason: input.assessment.passed ? null : input.assessment.reasons.join(" "),
      final_commit: input.assessment.passed ? input.builder.final_commit : input.state.final_commit,
      builder_result_digest: input.assessment.passed ? digestTaskValue(input.builder) : input.state.builder_result_digest,
      validation_result_digest: input.assessment.passed ? null : input.state.validation_result_digest,
      reviewer_verdict_digest: input.assessment.passed ? null : input.state.reviewer_verdict_digest,
    },
  });
}

export function recordValidationCompletion(input: {
  state: DurableTaskState;
  validation: ValidationResult;
  assessment: { passed: boolean; reasons: string[] };
  expected_revision: number;
  event_id: string;
  actor: string;
  now: string;
}): TaskStateMutationResult {
  if (input.state.current_state !== "validating") {
    throw new TaskLifecycleError("invalid_transition", "task is not validating");
  }
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: input.assessment.passed ? "reviewing" : "blocked",
    reason: "record application-owned deterministic validation",
    now: input.now,
    patch: {
      failure_reason: input.assessment.passed ? null : input.assessment.reasons.join(" "),
      final_commit: input.assessment.passed ? input.validation.final_commit : input.state.final_commit,
      validation_result_digest: input.assessment.passed ? digestTaskValue(input.validation) : input.state.validation_result_digest,
      reviewer_verdict_digest: input.assessment.passed ? null : input.state.reviewer_verdict_digest,
    },
  });
}

export function recordReviewerVerdict(input: {
  state: DurableTaskState;
  reviewer: ReviewerVerdict;
  assessment: { passed: boolean; reasons: string[] };
  expected_revision: number;
  event_id: string;
  actor: string;
  now: string;
}): TaskStateMutationResult {
  if (input.state.active_model_call !== null) {
    throw new TaskLifecycleError("invalid_transition", "reviewer model call must be reconciled before recording its verdict");
  }
  if (input.state.current_state !== "reviewing") {
    throw new TaskLifecycleError("invalid_transition", "task is not awaiting role-separated automated review");
  }
  if (!input.assessment.passed) {
    return applyTaskStateMutation(input.state, {
      expected_revision: input.expected_revision,
      event_id: input.event_id,
      actor: input.actor,
      transition_to: "blocked",
      reason: "review boundary validation failed",
      now: input.now,
      patch: {
        failure_reason: input.assessment.reasons.join(" "),
        reviewer_verdict_digest: digestTaskValue(input.reviewer),
      },
    });
  }
  if (input.reviewer.verdict === "approved") {
    return applyTaskStateMutation(input.state, {
      expected_revision: input.expected_revision,
      event_id: input.event_id,
      actor: input.actor,
      reason: "role-separated automated reviewer approved the stable validated commit",
      now: input.now,
      patch: {
        failure_reason: null,
        reviewer_verdict_digest: input.reviewer.verdict_digest,
      },
    });
  }
  if (input.reviewer.verdict === "changes_requested") {
    if (input.state.fix_cycle_count >= input.state.maximum_fix_cycles) {
      return applyTaskStateMutation(input.state, {
        expected_revision: input.expected_revision,
        event_id: input.event_id,
        actor: input.actor,
        transition_to: "blocked",
        reason: "bounded builder fix cycle exhausted",
        now: input.now,
        patch: {
          failure_reason: "Role-separated automated review requested further changes after the maximum fix cycles.",
          reviewer_verdict_digest: input.reviewer.verdict_digest,
        },
      });
    }
    return applyTaskStateMutation(input.state, {
      expected_revision: input.expected_revision,
      event_id: input.event_id,
      actor: input.actor,
      transition_to: "fixing",
      reason: "return actionable review findings to the same builder",
      now: input.now,
      patch: {
        fix_cycle_count: input.state.fix_cycle_count + 1,
        failure_reason: input.reviewer.findings.map((finding) => finding.required_change ?? finding.statement).join(" "),
        reviewer_verdict_digest: input.reviewer.verdict_digest,
      },
    });
  }
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: input.reviewer.verdict === "unsafe" ? "refused" : "blocked",
    reason: `role-separated automated reviewer returned ${input.reviewer.verdict}`,
    now: input.now,
    patch: {
      failure_reason: input.reviewer.summary,
      reviewer_verdict_digest: input.reviewer.verdict_digest,
    },
  });
}

export function recordDraftPublication(input: {
  state: DurableTaskState;
  publication: DraftPublicationDecision;
  pull_request: TaskDraftPullRequestIdentity;
  evidence_ref: string;
  expected_revision: number;
  event_id: string;
  actor: string;
  now: string;
}): TaskStateMutationResult {
  if (!input.publication.allowed || input.publication.draft !== true || input.pull_request.draft !== true) {
    throw new TaskLifecycleError("invalid_input", "trusted publisher may create only an admitted draft pull request");
  }
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: "draft-pr-open",
    reason: "record one owned unmerged draft pull request",
    now: input.now,
    patch: {
      draft_pr: input.pull_request,
      accepted_task_evidence_ref: input.evidence_ref,
      failure_reason: null,
    },
  });
}

export function stopTask(input: {
  state: DurableTaskState;
  expected_revision: number;
  event_id: string;
  actor: string;
  now: string;
}): TaskStateMutationResult {
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: "stopped",
    reason: "authorized maintainer requested stop",
    now: input.now,
    patch: { failure_reason: "Stopped by an authorized maintainer." },
  });
}

export function replanTask(input: {
  state: DurableTaskState;
  new_base_commit: string;
  expected_revision: number;
  event_id: string;
  actor: string;
  now: string;
}): TaskStateMutationResult {
  return applyTaskStateMutation(input.state, {
    expected_revision: input.expected_revision,
    event_id: input.event_id,
    actor: input.actor,
    transition_to: "ready",
    reason: "authorized maintainer requested replan",
    now: input.now,
    patch: {
      expected_base_commit: input.new_base_commit,
      plan_digest: null,
      selected_specialist_ids: [],
      selected_procedure_ids: [],
      approval: null,
      active_branch: null,
      final_commit: null,
      builder_result_digest: null,
      validation_result_digest: null,
      reviewer_verdict_digest: null,
      accepted_task_evidence_ref: null,
      failure_reason: null,
    },
  });
}
