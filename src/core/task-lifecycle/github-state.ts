import {
  MAX_TASK_COMMENT_BYTES,
  TASK_STATE_COMMENT_MARKER,
  type DurableTaskState,
  type TaskLifecycleState,
} from "./contracts.ts";
import { parseTaskStateComment, redactTaskText, renderTaskStateComment } from "./serialization.ts";
import { assertDurableTaskState, TaskLifecycleError } from "./state-machine.ts";

export interface GitHubIssueCommentSnapshot {
  comment_id: number;
  author_login: string;
  author_type: "Bot" | "User" | "Organization" | "Unknown";
  body: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubTaskStateRecord {
  comment_id: number;
  author_login: string;
  state: DurableTaskState;
}

const STATE_LABELS: Readonly<Record<TaskLifecycleState, string>> = {
  "new": "agentify:new",
  "needs-information": "agentify:needs-information",
  "ready": "agentify:ready",
  "planned": "agentify:planned",
  "awaiting-approval": "agentify:awaiting-approval",
  "approved": "agentify:approved",
  "implementing": "agentify:implementing",
  "validating": "agentify:validating",
  "reviewing": "agentify:reviewing",
  "fixing": "agentify:fixing",
  "draft-pr-open": "agentify:draft-pr-open",
  "completed": "agentify:completed",
  "stopped": "agentify:stopped",
  "refused": "agentify:refused",
  "blocked": "agentify:blocked",
  "stale-base": "agentify:stale-base",
  "budget-exhausted": "agentify:budget-exhausted",
  "failed": "agentify:failed",
  "recovering": "agentify:recovering",
};

export const TASK_STATE_PROJECTION_LABELS = Object.values(STATE_LABELS);

export function projectionLabelsForTask(state: DurableTaskState): string[] {
  return [STATE_LABELS[state.current_state]];
}

export function serializeGitHubTaskState(state: DurableTaskState): string {
  assertDurableTaskState(state);
  return renderTaskStateComment(state);
}

export function findGitHubTaskStateRecord(input: {
  comments: ReadonlyArray<GitHubIssueCommentSnapshot>;
  trusted_bot_logins: ReadonlyArray<string>;
  expected_task_id?: string;
}): GitHubTaskStateRecord | null {
  const trusted = new Set(input.trusted_bot_logins);
  const candidates = input.comments.filter((comment) =>
    comment.body.includes(`<!-- ${TASK_STATE_COMMENT_MARKER} `)
  );
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new TaskLifecycleError("resource_conflict", "multiple machine-owned task state comments claim this issue");
  }
  const comment = candidates[0];
  if (comment.author_type !== "Bot" || !trusted.has(comment.author_login)) {
    throw new TaskLifecycleError("resource_conflict", "task state comment is not owned by the trusted Agentify bot");
  }
  if (Buffer.byteLength(comment.body, "utf8") > MAX_TASK_COMMENT_BYTES) {
    throw new TaskLifecycleError("corrupt_state", "task state comment exceeds its bounded size");
  }
  const parsed = parseTaskStateComment(comment.body) as DurableTaskState;
  assertDurableTaskState(parsed);
  if (input.expected_task_id && parsed.task_id !== input.expected_task_id) {
    throw new TaskLifecycleError("resource_conflict", "task state comment belongs to a different stable task ID");
  }
  return { comment_id: comment.comment_id, author_login: comment.author_login, state: parsed };
}

export function taskExplanation(state: DurableTaskState): string {
  const approval = state.approval
    ? `Approval by ${state.approval.approver} expires at ${state.approval.expires_at}.`
    : "No valid approval is recorded.";
  const failure = state.failure_reason
    ? ` Bounded reason: ${redactTaskText(state.failure_reason, 600)}`
    : "";
  return redactTaskText(
    `Task ${state.task_id} is ${state.current_state} at revision ${state.revision}. `
      + `It is bound to base ${state.expected_base_commit}. ${approval}${failure}`,
    1_500,
  );
}
