import {
  TASK_LIFECYCLE_SCHEMA_VERSION,
  TASK_RUNTIME_PROTECTED_PATHS,
  type BuilderRequest,
  type BuilderResult,
  type DurableTaskState,
  type OrchestratorPlan,
  type TaskLifecyclePolicy,
} from "../contracts.ts";
import {
  normalizeTaskPaths,
  pathWithinTaskScope,
  sortedTaskStrings,
} from "../serialization.ts";
import { validateBuilderRequest } from "../schema.ts";
import { TaskLifecycleError } from "../state-machine.ts";
import { createTaskRoleAuthorities, executionPolicyDigest } from "./authority.ts";
import { fileInsideAnyTaskScope, type BoundaryAssessment } from "./boundary.ts";

export function buildBuilderRequest(input: {
  cwd: string;
  state: DurableTaskState;
  plan: OrchestratorPlan;
  specialist_findings: BuilderRequest["specialist_findings"];
  policy: TaskLifecyclePolicy;
  reviewer_findings?: BuilderRequest["reviewer_findings"];
}): BuilderRequest {
  if (input.state.current_state !== "implementing" && input.state.current_state !== "fixing") {
    throw new TaskLifecycleError("invalid_transition", "builder request requires implementing or fixing task state");
  }
  if (!input.state.active_branch) {
    throw new TaskLifecycleError("invalid_input", "builder request requires the owned task branch");
  }
  if (input.state.plan_digest !== input.plan.plan_digest || input.state.expected_base_commit !== input.plan.expected_base_commit) {
    throw new TaskLifecycleError("invalid_input", "builder request plan is not bound to the current task state");
  }
  const protectedPaths = normalizeTaskPaths([
    ...TASK_RUNTIME_PROTECTED_PATHS,
    ...input.policy.protected_paths,
    ...input.plan.excluded_paths,
  ]);
  const allowedPaths = normalizeTaskPaths(input.plan.in_scope_paths);
  const policyWritePaths = normalizeTaskPaths(input.policy.allowed_write_paths, "policy write path");
  if (allowedPaths.some((candidate) => !policyWritePaths.some((scope) => pathWithinTaskScope(candidate, scope)))) {
    throw new TaskLifecycleError("invalid_input", "builder request plan exceeds repository policy write authority");
  }
  if (allowedPaths.length === 0) {
    throw new TaskLifecycleError("invalid_input", "builder request has no approved application write scope");
  }
  const builder = createTaskRoleAuthorities({
    cwd: input.cwd,
    write_root: allowedPaths[0],
    allowed_paths: allowedPaths,
    protected_paths: protectedPaths,
  }).find((authority) => authority.role === "builder");
  if (!builder) throw new TaskLifecycleError("invalid_input", "builder authority is unavailable");
  return validateBuilderRequest({
    schema_version: TASK_LIFECYCLE_SCHEMA_VERSION,
    task_id: input.state.task_id,
    repository: { ...input.state.repository },
    issue_number: input.state.issue_number,
    expected_base_commit: input.state.expected_base_commit,
    branch: input.state.active_branch,
    write_root: allowedPaths[0],
    protected_paths: protectedPaths,
    allowed_paths: allowedPaths,
    plan: input.plan,
    specialist_findings: input.specialist_findings,
    selected_procedure_ids: input.plan.selected_procedures.map((selection) => selection.procedure_id),
    memory_record_ids: [...input.plan.memory_record_ids],
    fix_cycle: input.state.fix_cycle_count,
    reviewer_findings: input.reviewer_findings ?? [],
    execution_policy_digest: executionPolicyDigest(builder),
  });
}

export function assessBuilderResult(
  request: BuilderRequest,
  result: BuilderResult,
  policy: TaskLifecyclePolicy,
  now: string,
): BoundaryAssessment {
  const reasons: string[] = [];
  if (result.task_id !== request.task_id || result.issue_number !== request.issue_number) {
    reasons.push("builder result is bound to a different task or issue");
  }
  if (result.expected_base_commit !== request.expected_base_commit) {
    reasons.push("builder result expected base commit does not match the request");
  }
  if (result.branch !== request.branch) reasons.push("builder result used a different task branch");
  if (result.commit_shas.length === 0 || result.final_commit !== result.commit_shas.at(-1)) {
    reasons.push("builder result must identify at least one commit and a matching final commit");
  }
  if (result.changed_files.length === 0) reasons.push("builder produced no application change");
  if (result.untracked_files.length > 0) reasons.push("builder left untracked files");
  const changed = normalizeTaskPaths(result.changed_files, "builder changed file");
  const allowed = normalizeTaskPaths(request.allowed_paths, "builder allowed path");
  const protectedPaths = normalizeTaskPaths(request.protected_paths, "protected path");
  for (const file of changed) {
    if (!fileInsideAnyTaskScope(file, allowed)) reasons.push(`builder changed out-of-scope path ${file}`);
    if (fileInsideAnyTaskScope(file, protectedPaths)) reasons.push(`builder changed protected path ${file}`);
  }
  if (Date.parse(result.completed_at) < Date.parse(result.started_at)) {
    reasons.push("builder completion time precedes its start time");
  }
  const cost = result.cost_usd ?? 0;
  if (cost > policy.maximum_cost_usd) reasons.push("builder exceeded the task cost budget");
  if (result.runtime_ms > policy.maximum_runtime_ms || Date.parse(now) > Date.parse(request.plan.created_at) + policy.maximum_runtime_ms) {
    reasons.push("builder exceeded the task runtime deadline");
  }
  return { passed: reasons.length === 0, reasons: sortedTaskStrings(reasons) };
}
