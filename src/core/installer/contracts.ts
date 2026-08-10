import type { TaskLifecyclePolicy } from "../task-lifecycle/contracts.ts";

export type InstallerDisposition =
  | "ready"
  | "partially-ready"
  | "analyzable-only"
  | "blocked";

export type InstallerBlockerCode =
  | "not_git_repository"
  | "repository_root_mismatch"
  | "no_git_history"
  | "non_github_remote"
  | "github_cli_unavailable"
  | "github_auth_unavailable"
  | "repository_identity_mismatch"
  | "missing_github_permission"
  | "unknown_branch_policy"
  | "unsupported_build_system"
  | "missing_dependency_lock"
  | "missing_deterministic_validation"
  | "validation_consent_required"
  | "validation_policy_stale"
  | "unsafe_production_credentials"
  | "unsafe_network_or_deployment"
  | "unsupported_provider_or_model"
  | "ambiguous_agentify_state"
  | "user_owned_workflow_conflict"
  | "validation_failed"
  | "github_configuration_failed"
  | "installation_canary_failed";

export interface InstallerBlocker {
  code: InstallerBlockerCode;
  message: string;
  remediation: string;
}

export interface RepositoryInstallationIdentity {
  repository_id: string;
  full_name: string;
  default_branch: string;
  current_commit: string;
  current_branch: string;
  origin_url: string;
  actor_login: string;
  actor_permission: "admin" | "maintain" | "write" | "triage" | "read" | "none";
  default_branch_policy: "protected" | "unprotected" | "unknown";
}

export type InstallerCommandKind =
  | "install"
  | "build"
  | "typecheck"
  | "lint"
  | "test"
  | "package";

export type InstallerCommandAssessment =
  | "verified"
  | "characterized"
  | "failed"
  | "unsafe";

export interface InstallerCommand {
  command_id: string;
  kind: InstallerCommandKind;
  argv: string[];
  cwd: string;
  timeout_ms: number;
  required: boolean;
  assessment: InstallerCommandAssessment;
  exit_code: number | null;
  output_digest: string | null;
  detail: string;
}

export interface RepositoryInstallationPreflight {
  disposition: InstallerDisposition;
  analysis_allowed: boolean;
  identity: RepositoryInstallationIdentity | null;
  commands: InstallerCommand[];
  allowed_write_paths: string[];
  protected_paths: string[];
  blockers: InstallerBlocker[];
}

export interface RepositoryTaskPolicyConfiguration {
  format: "agentify_task_policy_configuration";
  schema_version: "2";
  configured: boolean;
  repository: RepositoryInstallationIdentity | null;
  model_network_posture: "denied-by-default";
  dependency_change_policy: "maintainer-approval-required";
  application_merge: "disabled";
  application_deployment: "disabled";
  protected_path_policy_known: boolean;
  validation_services_attested: boolean;
  validation_execution: RepositoryValidationExecution;
  validation_approval: RepositoryValidationApproval | null;
  policy: TaskLifecyclePolicy | null;
  instructions: string;
}

export interface RepositoryValidationExecution {
  mode: "maintainer-approved-unsandboxed";
  child_environment_credentials: "removed";
  repository_mutation: "detected-and-rejected";
  network_isolation: "not-provided";
  os_sandbox: "not-provided";
}

export interface RepositoryValidationApproval {
  mode: "maintainer-approved-unsandboxed";
  approved_by: string;
  approved_at: string;
  /** SHA-256 of the primary build manifest at approval time. */
  package_json_sha256: string;
  /** Primary build manifest path; defaults to package.json when absent. */
  manifest_path?: string;
  lockfile: {
    path: string;
    sha256: string;
  } | null;
  commands_sha256: string;
}

export interface InstallerProcessRequest {
  program: string;
  args: ReadonlyArray<string>;
  cwd: string;
  timeoutMs: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstallerProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorMessage: string | null;
}

export interface InstallerProcessRunner {
  run(request: InstallerProcessRequest): InstallerProcessResult;
}

export interface InspectRepositoryOptions {
  cwd: string;
  runner?: InstallerProcessRunner;
  runValidation?: boolean;
}

export interface GitHubConfigurationInput {
  cwd: string;
  repository: RepositoryInstallationIdentity;
  agentifyVersion: string;
  provider: string | null;
  model: string | null;
  providerSecret?: {
    name: string;
    value: string;
    explicitConsent: true;
  };
  automationSecret?: {
    name: "AGENT_PAT";
    value: string;
    explicitConsent: true;
  };
  runner?: InstallerProcessRunner;
}

export interface GitHubConfigurationResult {
  labels_configured: number;
  variables_configured: string[];
  provider_secret_configured: string | null;
  automation_secret_configured: "AGENT_PAT" | null;
}

export interface InstallationCanaryResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

export interface OneTimeInstallationReport {
  disposition: InstallerDisposition;
  repository: RepositoryInstallationIdentity | null;
  specialists_installed: number;
  procedures_installed: number;
  validation_commands_verified: number;
  github_issue_intake_enabled: boolean;
  draft_pr_publication_enabled: boolean;
  automatic_knowledge_refresh_enabled: boolean;
  automatic_application_merge_enabled: false;
  repaired_paths: string[];
  blockers: InstallerBlocker[];
}
