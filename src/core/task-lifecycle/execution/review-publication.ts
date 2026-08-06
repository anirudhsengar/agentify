import type {
  BuilderResult,
  DraftPublicationAssessmentInput,
  DraftPublicationDecision,
  ReviewerVerdict,
  ValidationResult,
} from "../contracts.ts";
import { digestTaskValue, redactTaskText, sortedTaskStrings } from "../serialization.ts";
import { assertTaskApproval, isTaskWithinBudget } from "../state-machine.ts";
import type { BoundaryAssessment } from "./boundary.ts";

export function assessReviewerVerdict(input: {
  reviewer: ReviewerVerdict;
  builder: BuilderResult;
  validation: ValidationResult;
}): BoundaryAssessment {
  const reasons: string[] = [];
  const verdict = input.reviewer;
  if (verdict.task_id !== input.builder.task_id || verdict.issue_number !== input.builder.issue_number) {
    reasons.push("reviewer verdict is bound to a different task or issue");
  }
  if (verdict.builder_agent_id !== input.builder.builder_agent_id) {
    reasons.push("reviewer verdict names a different builder identity");
  }
  if (verdict.reviewer_agent_id === verdict.builder_agent_id) {
    reasons.push("builder cannot approve its own result");
  }
  if (verdict.reviewed_commit !== input.validation.final_commit) {
    reasons.push("reviewer did not inspect the stable validated commit");
  }
  const expectedDigest = digestTaskValue({ ...verdict, verdict_digest: undefined });
  if (verdict.verdict_digest !== expectedDigest) reasons.push("reviewer verdict digest is invalid");
  if (verdict.verdict === "approved" && verdict.findings.some((finding) => finding.severity === "critical")) {
    reasons.push("approved reviewer verdict cannot retain a critical finding");
  }
  if (verdict.verdict === "changes_requested" && verdict.findings.length === 0) {
    reasons.push("changes_requested reviewer verdict must contain actionable findings");
  }
  return { passed: reasons.length === 0, reasons: sortedTaskStrings(reasons) };
}

function publicationBody(input: DraftPublicationAssessmentInput): string {
  const changedFiles = input.validation.changed_files.map((file) => `- \`${file}\``).join("\n");
  const validations = input.validation.commands.map((command) =>
    `- \`${command.command_id}\`: ${command.exit_code === 0 && !command.timed_out ? "passed" : "failed"}; output digest \`${command.output_digest}\``
  ).join("\n");
  const specialists = input.plan.selected_specialists.map((item) => `\`${item.specialist_id}\``).join(", ") || "none";
  const procedures = input.plan.selected_procedures.map((item) => `\`${item.procedure_id}\``).join(", ") || "none";
  const body = [
    `Implements #${input.state.issue_number}.`,
    "",
    "## Implementation summary",
    redactTaskText(input.plan.task_summary, 4_000),
    "",
    "## Bound plan",
    `- Plan digest: \`${input.plan.plan_digest}\``,
    `- Expected base: \`${input.state.expected_base_commit}\``,
    `- Final commit: \`${input.validation.final_commit}\``,
    `- Selected specialists: ${specialists}`,
    `- Selected procedures: ${procedures}`,
    "",
    "## Changed files",
    changedFiles || "- none",
    "",
    "## Deterministic validation",
    validations,
    `- Policy verdict: **${input.validation.policy_verdict}**`,
    "",
    "## Role-separated automated review",
    `- Verdict: **${input.reviewer.verdict}**`,
    `- Reviewer: \`${input.reviewer.reviewer_agent_id}\``,
    `- Verdict digest: \`${input.reviewer.verdict_digest}\``,
    "",
    "## Risks and limitations",
    ...input.plan.security_controls.map((control) => `- ${redactTaskText(control.description, 1_000)}`),
    ...input.plan.escalation_conditions.map((condition) => `- ${redactTaskText(condition, 1_000)}`),
    "",
    "## Cost and runtime",
    `- Measured task cost: $${input.state.budget.measured_cost_usd.toFixed(6)}`,
    `- Estimated task cost: $${input.state.budget.estimated_cost_usd.toFixed(6)}`,
    `- Model calls: ${input.state.budget.model_calls}/${input.state.budget.maximum_model_calls}`,
    `- Builder runtime: ${Math.max(0, Date.parse(input.validation.completed_at) - Date.parse(input.state.budget.started_at))} ms elapsed through validation`,
    "",
    "## Accepted-task evidence",
    `- Artifact: \`${redactTaskText(input.accepted_task_evidence_ref, 2_000)}\``,
    "",
    "This pull request is intentionally **draft and unmerged**. Agentify never merges, enables auto-merge, deploys, force-pushes, or writes application changes directly to the default branch. Human maintainers retain merge or rejection authority.",
  ].join("\n");
  return body.slice(0, 60_000);
}

export function assessDraftPublication(input: DraftPublicationAssessmentInput): DraftPublicationDecision {
  const reasons: string[] = [];
  if (input.state.current_state !== "reviewing") reasons.push("task state is not ready for publication");
  if (!input.state.active_branch) reasons.push("task state has no active implementation branch");
  if (input.state.plan_digest !== input.plan.plan_digest) reasons.push("task state plan digest does not match publication plan");
  if (input.current_base_commit !== input.state.expected_base_commit) reasons.push("base branch moved after approval");
  if (input.current_head_commit !== input.validation.final_commit) reasons.push("branch head moved after validation or review");
  if (input.current_tree_digest !== input.validation.final_tree_digest) reasons.push("worktree changed after deterministic validation");
  if (!input.branch_owned) reasons.push("implementation branch ownership could not be verified");
  if (input.conflicting_pull_request !== null) reasons.push(`conflicting pull request #${input.conflicting_pull_request} already exists`);
  if (input.validation.policy_verdict !== "passed") reasons.push("required deterministic validation did not pass");
  if (input.reviewer.verdict !== "approved") reasons.push(`automated reviewer verdict is ${input.reviewer.verdict}`);
  if (input.reviewer.reviewed_commit !== input.validation.final_commit) reasons.push("reviewer did not approve the final validated commit");
  if (!input.accepted_task_evidence_ref.trim()) reasons.push("accepted-task-evidence artifact reference is missing");
  if (!isTaskWithinBudget(input.state, input.approval_now)) reasons.push("task budget or deadline is exhausted");
  if (!input.state.approval) reasons.push("task has no approval record");
  else {
    try {
      assertTaskApproval(input.state.approval, input.state, input.approval_now, true);
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : "approval is invalid");
    }
  }
  return {
    allowed: reasons.length === 0,
    reasons: sortedTaskStrings(reasons),
    title: redactTaskText(input.plan.task_summary, 200),
    body: publicationBody(input),
    head_branch: input.state.active_branch ?? "",
    base_branch: input.state.repository.default_branch,
    draft: true,
  };
}
