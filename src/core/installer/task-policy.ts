import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidationCommandSpec } from "../task-lifecycle/contracts.ts";
import {
  digestTaskValue,
  normalizeTaskPaths,
  sortedTaskStrings,
} from "../task-lifecycle/serialization.ts";
import { validateTaskLifecyclePolicy } from "../task-lifecycle/schema.ts";
import { discoverRepositoryBuildSystem } from "./build-systems/index.ts";
import type {
  RepositoryInstallationPreflight,
  RepositoryTaskPolicyConfiguration,
  RepositoryValidationApproval,
  RepositoryValidationExecution,
} from "./contracts.ts";

const TASK_POLICY_RELATIVE_PATH = ".github/agentify-task-policy.json";
const SHA256 = /^[0-9a-f]{64}$/;

export const VALIDATION_EXECUTION: RepositoryValidationExecution = {
  mode: "maintainer-approved-unsandboxed",
  child_environment_credentials: "removed",
  repository_mutation: "detected-and-rejected",
  network_isolation: "not-provided",
  os_sandbox: "not-provided",
};

const FORBIDDEN_ACTIONS = [
  "application merge",
  "auto-merge",
  "application deployment",
  "default-branch application write",
  "force-push",
  "credential exposure",
  "policy expansion by model output",
  "unapproved dependency change",
];

const KNOWN_LOCKFILES = [
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "gradle.lockfile",
] as const;

function commandSpec(command: RepositoryInstallationPreflight["commands"][number]): ValidationCommandSpec {
  return {
    command_id: command.command_id,
    argv: [...command.argv],
    cwd: command.cwd,
    timeout_ms: command.timeout_ms,
    required: true,
    mutation_allowed: false,
    source: "repository-policy" as const,
  };
}

function validationCommands(preflight: RepositoryInstallationPreflight): ValidationCommandSpec[] {
  return preflight.commands
    .filter((command) => command.kind !== "install")
    .filter((command) => command.required && command.assessment === "verified")
    .map(commandSpec);
}

function fileSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function approvalCommandDigest(preflight: RepositoryInstallationPreflight): string {
  return digestTaskValue(preflight.commands
    .filter((command) => command.kind !== "install" && command.required)
    .map(commandSpec));
}

function primaryManifestPath(cwd: string): string {
  return discoverRepositoryBuildSystem(cwd).manifest?.path ?? "package.json";
}

function lockfileApproval(cwd: string): RepositoryValidationApproval["lockfile"] {
  for (const name of KNOWN_LOCKFILES) {
    const absolute = path.join(cwd, name);
    if (fs.existsSync(absolute)) return { path: name, sha256: fileSha256(absolute) };
  }
  return null;
}

export function createRepositoryValidationApproval(input: {
  cwd: string;
  preflight: RepositoryInstallationPreflight;
  approvedBy: string;
  approvedAt?: string;
}): RepositoryValidationApproval {
  const manifestPath = primaryManifestPath(input.cwd);
  const manifestAbsolute = path.join(input.cwd, manifestPath);
  if (!fs.existsSync(manifestAbsolute)) {
    throw new Error(`validation approval requires ${manifestPath}`);
  }
  if (!input.approvedBy.trim()) throw new Error("validation approval requires an approving maintainer");
  return {
    mode: "maintainer-approved-unsandboxed",
    approved_by: input.approvedBy.trim(),
    approved_at: input.approvedAt ?? new Date().toISOString(),
    package_json_sha256: fileSha256(manifestAbsolute),
    manifest_path: manifestPath,
    lockfile: lockfileApproval(input.cwd),
    commands_sha256: approvalCommandDigest(input.preflight),
  };
}

export function repositoryValidationApprovalCurrent(input: {
  cwd: string;
  preflight: RepositoryInstallationPreflight;
  approval: RepositoryValidationApproval | null | undefined;
}): boolean {
  const approval = input.approval;
  if (
    !approval
    || approval.mode !== "maintainer-approved-unsandboxed"
    || !approval.approved_by.trim()
    || !Number.isFinite(Date.parse(approval.approved_at))
    || !SHA256.test(approval.package_json_sha256)
    || !SHA256.test(approval.commands_sha256)
  ) return false;
  const manifestPath = approval.manifest_path ?? "package.json";
  const manifestAbsolute = path.join(input.cwd, manifestPath);
  if (!fs.existsSync(manifestAbsolute) || fileSha256(manifestAbsolute) !== approval.package_json_sha256) return false;
  const currentLockfile = lockfileApproval(input.cwd);
  if (currentLockfile?.path !== approval.lockfile?.path || currentLockfile?.sha256 !== approval.lockfile?.sha256) return false;
  return approvalCommandDigest(input.preflight) === approval.commands_sha256;
}

export function readRepositoryTaskPolicyConfiguration(cwd: string): RepositoryTaskPolicyConfiguration | null {
  const policyPath = path.join(cwd, TASK_POLICY_RELATIVE_PATH);
  if (!fs.existsSync(policyPath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(policyPath, "utf8")) as Partial<RepositoryTaskPolicyConfiguration>;
    if (value.format !== "agentify_task_policy_configuration" || value.schema_version !== "2") return null;
    return value as RepositoryTaskPolicyConfiguration;
  } catch {
    return null;
  }
}

export function repositoryTaskPolicySchemaStatus(cwd: string): "absent" | "legacy" | "current" | "invalid" {
  const policyPath = path.join(cwd, TASK_POLICY_RELATIVE_PATH);
  if (!fs.existsSync(policyPath)) return "absent";
  try {
    const value = JSON.parse(fs.readFileSync(policyPath, "utf8")) as { format?: unknown; schema_version?: unknown };
    if (value.format !== "agentify_task_policy_configuration") return "invalid";
    if (value.schema_version === "2") return "current";
    if (value.schema_version === "1") return "legacy";
    return "invalid";
  } catch {
    return "invalid";
  }
}

export function buildRepositoryTaskPolicyConfiguration(
  preflight: RepositoryInstallationPreflight,
  validationApproval: RepositoryValidationApproval | null = null,
  cwd = process.cwd(),
): RepositoryTaskPolicyConfiguration {
  const commands = validationCommands(preflight);
  const approvalCurrent = repositoryValidationApprovalCurrent({
    cwd,
    preflight,
    approval: validationApproval,
  });
  const configured = preflight.disposition === "ready"
    && preflight.identity !== null
    && commands.length > 0
    && preflight.allowed_write_paths.length > 0
    && approvalCurrent;
  if (!configured) {
    return {
      format: "agentify_task_policy_configuration",
      schema_version: "2",
      configured: false,
      repository: preflight.identity,
      model_network_posture: "denied-by-default",
      dependency_change_policy: "maintainer-approval-required",
      application_merge: "disabled",
      application_deployment: "disabled",
      protected_path_policy_known: false,
      validation_services_attested: false,
      validation_execution: VALIDATION_EXECUTION,
      validation_approval: approvalCurrent ? validationApproval : null,
      policy: null,
      instructions: "Agentify remains fail-closed until every installer readiness blocker is resolved, a maintainer explicitly approves unsandboxed repository validation, and validation passes.",
    };
  }

  const draft = {
    policy_digest: "",
    approval_required: true,
    approval_ttl_ms: 24 * 60 * 60 * 1_000,
    maximum_cost_usd: 5,
    maximum_runtime_ms: 60 * 60 * 1_000,
    maximum_model_calls: 12,
    maximum_fix_cycles: 2,
    protected_paths: normalizeTaskPaths(preflight.protected_paths, "protected path"),
    allowed_write_paths: normalizeTaskPaths(preflight.allowed_write_paths, "allowed write path"),
    validation_commands: commands,
    forbidden_actions: sortedTaskStrings(FORBIDDEN_ACTIONS),
  };
  const policy = validateTaskLifecyclePolicy({
    ...draft,
    policy_digest: digestTaskValue({ ...draft, policy_digest: undefined }),
  });
  return {
    format: "agentify_task_policy_configuration",
    schema_version: "2",
    configured: true,
    repository: preflight.identity,
    model_network_posture: "denied-by-default",
    dependency_change_policy: "maintainer-approval-required",
    application_merge: "disabled",
    application_deployment: "disabled",
    protected_path_policy_known: policy.protected_paths.length > 0,
    validation_services_attested: true,
    validation_execution: VALIDATION_EXECUTION,
    validation_approval: validationApproval,
    policy,
    instructions: "This repository-specific policy was generated from verified repository identity, tracked application paths, and passing validation commands, and explicit maintainer approval of unsandboxed repository validation.",
  };
}
