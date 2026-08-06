import {
  TASK_LIFECYCLE_SCHEMA_VERSION,
  TASK_RUNTIME_PROTECTED_PATHS,
  type BuilderResult,
  type DurableTaskState,
  type OrchestratorPlan,
  type TaskLifecyclePolicy,
  type ValidationPlan,
  type ValidationResult,
} from "../contracts.ts";
import { digestTaskValue, normalizeTaskPaths, sortedTaskStrings } from "../serialization.ts";
import { TaskLifecycleError } from "../state-machine.ts";
import { fileInsideAnyTaskScope, type BoundaryAssessment } from "./boundary.ts";

export function buildValidationPlan(input: {
  state: DurableTaskState;
  plan: OrchestratorPlan;
  builder: BuilderResult;
  policy: TaskLifecyclePolicy;
}): ValidationPlan {
  const policyCommands = new Map(
    input.policy.validation_commands.map((command) => [command.command_id, command]),
  );
  const commands = input.plan.validation_commands.map((planned) => {
    const admitted = policyCommands.get(planned.command_id);
    if (!admitted) {
      throw new TaskLifecycleError(
        "invalid_input",
        `validation command ${planned.command_id} is not admitted by repository policy`,
      );
    }
    if (digestTaskValue(planned) !== digestTaskValue(admitted)) {
      throw new TaskLifecycleError(
        "invalid_input",
        `validation command ${planned.command_id} differs from its repository-policy definition`,
      );
    }
    return { ...admitted, argv: [...admitted.argv] };
  });
  if (commands.length === 0 || !commands.some((command) => command.required)) {
    throw new TaskLifecycleError("invalid_input", "validation plan lacks a required repository-policy command");
  }
  return {
    schema_version: TASK_LIFECYCLE_SCHEMA_VERSION,
    task_id: input.state.task_id,
    expected_base_commit: input.state.expected_base_commit,
    expected_branch: input.builder.branch,
    expected_builder_commit: input.builder.final_commit,
    commands: commands.map((command) => ({ ...command, argv: [...command.argv] })),
    protected_paths: normalizeTaskPaths([
      ...TASK_RUNTIME_PROTECTED_PATHS,
      ...input.policy.protected_paths,
      ...input.plan.excluded_paths,
    ]),
    allowed_changed_paths: normalizeTaskPaths(input.plan.in_scope_paths),
    deadline_at: input.state.budget.deadline_at,
    plan_digest: input.plan.plan_digest,
  };
}

export function assessValidationResult(
  plan: ValidationPlan,
  result: ValidationResult,
  now: string,
): BoundaryAssessment {
  const reasons: string[] = [];
  if (result.task_id !== plan.task_id) reasons.push("validation result is bound to a different task");
  if (result.expected_base_commit !== plan.expected_base_commit) reasons.push("validation base commit drifted");
  if (result.expected_branch !== plan.expected_branch) reasons.push("validation ran on a different branch");
  if (result.builder_commit !== plan.expected_builder_commit) reasons.push("validation did not start from the builder commit");
  if (result.final_commit !== plan.expected_builder_commit) reasons.push("repository mutated after builder completion");
  if (Date.parse(now) >= Date.parse(plan.deadline_at)) reasons.push("validation completed after the task deadline");
  if (result.untracked_files.length > 0) reasons.push("validation left untracked files");
  const specs = new Map(plan.commands.map((command) => [command.command_id, command]));
  const seen = new Set<string>();
  for (const command of result.commands) {
    const spec = specs.get(command.command_id);
    if (!spec) {
      reasons.push(`validation ran command outside policy: ${command.command_id}`);
      continue;
    }
    if (seen.has(command.command_id)) reasons.push(`validation duplicated command ${command.command_id}`);
    seen.add(command.command_id);
    if (command.timed_out) reasons.push(`validation command timed out: ${command.command_id}`);
    if (spec.required && command.exit_code !== 0) reasons.push(`required validation command failed: ${command.command_id}`);
    if (command.head_before !== command.head_after) reasons.push(`validation command changed HEAD: ${command.command_id}`);
    if (!spec.mutation_allowed && command.tree_digest_before !== command.tree_digest_after) {
      reasons.push(`validation command mutated the repository: ${command.command_id}`);
    }
  }
  for (const spec of plan.commands) {
    if (spec.required && !seen.has(spec.command_id)) reasons.push(`required validation command is missing: ${spec.command_id}`);
  }
  const changed = normalizeTaskPaths(result.changed_files, "validated changed file");
  for (const file of changed) {
    if (!fileInsideAnyTaskScope(file, plan.allowed_changed_paths)) reasons.push(`validated diff contains out-of-scope path ${file}`);
    if (fileInsideAnyTaskScope(file, plan.protected_paths)) reasons.push(`validated diff contains protected path ${file}`);
  }
  if (result.policy_verdict !== "passed") reasons.push(...result.policy_reasons.map((reason) => `validation policy: ${reason}`));
  return { passed: reasons.length === 0, reasons: sortedTaskStrings(reasons) };
}
