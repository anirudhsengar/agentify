import * as path from "node:path";
import {
  createOrchestratorExecutionPolicy,
  createReadOnlyExecutionPolicy,
  createRepositoryWriteExecutionPolicy,
} from "../../security/execution-policy.ts";
import type { TaskRoleAuthority } from "../contracts.ts";
import { digestTaskValue, normalizeTaskPath, normalizeTaskPaths } from "../serialization.ts";
import { TaskLifecycleError } from "../state-machine.ts";

function absoluteTaskPaths(cwd: string, values: ReadonlyArray<string>): string[] {
  return normalizeTaskPaths(values).map((value) => path.resolve(cwd, value));
}

export function createTaskRoleAuthorities(input: {
  cwd: string;
  write_root: string;
  allowed_paths?: string[];
  protected_paths: string[];
}): TaskRoleAuthority[] {
  const protectedPaths = absoluteTaskPaths(input.cwd, input.protected_paths);
  const writeRoots = (input.allowed_paths && input.allowed_paths.length > 0
    ? absoluteTaskPaths(input.cwd, input.allowed_paths)
    : [path.resolve(input.cwd, normalizeTaskPath(input.write_root, "builder write root"))]);
  const authorities: TaskRoleAuthority[] = [
    {
      role: "orchestrator",
      application_source_write: false,
      github_write: false,
      may_approve_result: false,
      execution_policy: createOrchestratorExecutionPolicy(input.cwd),
      trusted_custom_tools: [],
    },
    {
      role: "specialist",
      application_source_write: false,
      github_write: false,
      may_approve_result: false,
      execution_policy: createReadOnlyExecutionPolicy({
        cwd: input.cwd,
        mode: "audit-readonly",
        tools: [],
        protectedPaths,
      }),
      trusted_custom_tools: ["submit_specialist_findings"],
    },
    {
      role: "builder",
      application_source_write: true,
      github_write: false,
      may_approve_result: false,
      execution_policy: createRepositoryWriteExecutionPolicy({
        cwd: input.cwd,
        tools: [],
        writableRoots: writeRoots,
        protectedPaths,
        allowDevelopmentCommands: false,
      }),
      trusted_custom_tools: ["submit_builder_result"],
    },
    {
      role: "reviewer",
      application_source_write: false,
      github_write: false,
      may_approve_result: true,
      execution_policy: createReadOnlyExecutionPolicy({
        cwd: input.cwd,
        mode: "review-readonly",
        tools: [],
        protectedPaths,
      }),
      trusted_custom_tools: ["submit_reviewer_verdict"],
    },
  ];
  const writers = authorities.filter((authority) => authority.application_source_write);
  if (writers.length !== 1 || writers[0].role !== "builder") {
    throw new TaskLifecycleError("invalid_input", "exactly one builder must hold application-source write authority");
  }
  if (authorities.some((authority) => authority.github_write)) {
    throw new TaskLifecycleError("invalid_input", "model roles cannot receive GitHub write authority");
  }
  return authorities;
}

export function executionPolicyDigest(authority: TaskRoleAuthority): string {
  return digestTaskValue({
    role: authority.role,
    application_source_write: authority.application_source_write,
    github_write: authority.github_write,
    may_approve_result: authority.may_approve_result,
    execution_policy: authority.execution_policy,
    trusted_custom_tools: authority.trusted_custom_tools,
  });
}
