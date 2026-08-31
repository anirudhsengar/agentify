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
import { verifiedRepositoryTestCommands } from "./validation-contract.ts";

const TASK_POLICY_RELATIVE_PATH = ".github/agentify-task-policy.json";
const SHA256 = /^[0-9a-f]{64}$/;
export const TASK_POLICY_FORMAT = "agentify_task_policy_configuration";

/**
 * Ownership probe for the installed policy file. The namespaced JSON artifact
 * carries a self-describing format marker, so Agentify can recognize its own
 * earlier writes — including a fail-closed placeholder left by an interrupted
 * install — even when the content has since drifted. Content drift is handled
 * separately by validation-approval freshness checks; this answers only "did
 * Agentify write this file", so the installer does not mistake its own
 * previous output for a user-owned file.
 */
export function isAgentifyOwnedTaskPolicyFile(policyPath: string): boolean {
  try {
    if (!fs.existsSync(policyPath)) return false;
    const value = JSON.parse(fs.readFileSync(policyPath, "utf8")) as Record<string, unknown> | null;
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && value.format === TASK_POLICY_FORMAT
      && typeof value.schema_version === "string";
  } catch {
    return false;
  }
}

export const VALIDATION_EXECUTION: RepositoryValidationExecution = {
  mode: "maintainer-approved-unsandboxed",
  child_environment_credentials: "removed",
  repository_mutation: "disposable-checkout",
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
    if (value.format !== TASK_POLICY_FORMAT || value.schema_version !== "2") return null;
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
    if (value.format !== TASK_POLICY_FORMAT) return "invalid";
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
  const hasVerifiedRepositoryTest = verifiedRepositoryTestCommands(preflight.commands).length > 0;
  const approvalCurrent = repositoryValidationApprovalCurrent({
    cwd,
    preflight,
    approval: validationApproval,
  });
  const configured = preflight.disposition === "ready"
    && preflight.identity !== null
    && commands.length > 0
    && hasVerifiedRepositoryTest
    && preflight.allowed_write_paths.length > 0
    && approvalCurrent;
  if (!configured) {
    return {
      format: TASK_POLICY_FORMAT,
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
      instructions: [
        "Execution is disabled. A validated specialist team may be analysis-ready; this policy grants no autonomous mutation, issue intake, PR publication, or learning authority.",
        ...preflight.blockers.map((blocker) => `[${blocker.code}] ${blocker.message} ${blocker.remediation}`),
        "To enable execution, rerun Agentify after repository-owned deterministic tests and reproducible dependency inputs are verified at the current HEAD, with current maintainer attestation of the credential-scrubbed, disposable-checkout, unsandboxed network/OS posture.",
        "Do not manufacture a repository lockfile to enable installation. External evaluation locks are harness-only artifacts, never repository-owned evidence or execution approval.",
      ].join("\n"),
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
    format: TASK_POLICY_FORMAT,
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
    instructions: "This repository-specific policy was generated from verified repository identity, tracked application paths, validation passed in a disposable exact-HEAD checkout, and installer attestation of the remaining unsandboxed network/OS posture.",
  };
}
