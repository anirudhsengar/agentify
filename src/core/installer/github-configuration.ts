import type {
  GitHubConfigurationInput,
  GitHubConfigurationResult,
  InstallerProcessResult,
} from "./contracts.ts";
import {
  conciseProcessFailure,
  DEFAULT_INSTALLER_PROCESS_RUNNER,
} from "./process-runner.ts";

const REQUIRED_LABELS: ReadonlyArray<{
  name: string;
  color: string;
  description: string;
}> = [
  { name: "agentify:queue", color: "5319E7", description: "Queue an authorized issue for Agentify" },
  { name: "agentify:draft", color: "BFDADC", description: "Agentify-owned unmerged draft PR" },
  { name: "agentify:new", color: "D4C5F9", description: "Agentify task state initialized" },
  { name: "agentify:needs-information", color: "FBCA04", description: "Maintainer clarification required" },
  { name: "agentify:ready", color: "C2E0C6", description: "Ready for typed planning" },
  { name: "agentify:planned", color: "C2E0C6", description: "Typed plan recorded" },
  { name: "agentify:awaiting-approval", color: "FBCA04", description: "Maintainer approval required" },
  { name: "agentify:approved", color: "0E8A16", description: "Plan approved by an authorized maintainer" },
  { name: "agentify:implementing", color: "1D76DB", description: "One builder is implementing" },
  { name: "agentify:validating", color: "1D76DB", description: "Deterministic validation in progress" },
  { name: "agentify:reviewing", color: "6E7781", description: "Role-separated automated read-only review in progress" },
  { name: "agentify:fixing", color: "FBCA04", description: "Bounded builder fix cycle" },
  { name: "agentify:draft-pr-open", color: "BFDADC", description: "Unmerged draft pull request open" },
  { name: "agentify:completed", color: "0E8A16", description: "Completed after human disposition" },
  { name: "agentify:stopped", color: "D93F0B", description: "Stopped by an authorized maintainer" },
  { name: "agentify:refused", color: "D93F0B", description: "Request refused by policy" },
  { name: "agentify:blocked", color: "D93F0B", description: "Human intervention required" },
  { name: "agentify:stale-base", color: "D93F0B", description: "Expected base commit is stale" },
  { name: "agentify:budget-exhausted", color: "D93F0B", description: "Bounded task budget exhausted" },
  { name: "agentify:failed", color: "D93F0B", description: "Trusted lifecycle failed closed" },
  { name: "agentify:recovering", color: "FBCA04", description: "Recovering an owned external mutation" },
];

function assertSuccess(label: string, result: InstallerProcessResult): void {
  if (result.status !== 0 || result.timedOut || result.errorMessage !== null) {
    throw new Error(`${label} failed: ${conciseProcessFailure(result)}`);
  }
}

function setVariable(
  runner: NonNullable<GitHubConfigurationInput["runner"]>,
  input: GitHubConfigurationInput,
  name: string,
  value: string,
): void {
  const result = runner.run({
    program: "gh",
    args: ["variable", "set", name, "--body", value, "--repo", input.repository.full_name],
    cwd: input.cwd,
    timeoutMs: 30_000,
  });
  assertSuccess(`GitHub variable ${name}`, result);
}

function removeLegacyVariables(
  runner: NonNullable<GitHubConfigurationInput["runner"]>,
  input: GitHubConfigurationInput,
): void {
  const listed = runner.run({
    program: "gh",
    args: ["variable", "list", "--repo", input.repository.full_name, "--json", "name"],
    cwd: input.cwd,
    timeoutMs: 30_000,
  });
  assertSuccess("GitHub variable inventory", listed);
  let names: Set<string>;
  try {
    const parsed = JSON.parse(listed.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error("invalid response");
    names = new Set(parsed.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid entry");
      const name = (entry as Record<string, unknown>).name;
      if (typeof name !== "string") throw new Error("invalid name");
      return name;
    }));
  } catch {
    throw new Error("GitHub variable inventory returned an invalid response");
  }
  for (const name of ["PI_VERSION", "AGENT_BOT_LOGIN"]) {
    if (!names.has(name)) continue;
    const removed = runner.run({
      program: "gh",
      args: ["variable", "delete", name, "--repo", input.repository.full_name],
      cwd: input.cwd,
      timeoutMs: 30_000,
    });
    assertSuccess(`legacy GitHub variable ${name} removal`, removed);
  }
}

function configureDraftPullRequestPermission(
  runner: NonNullable<GitHubConfigurationInput["runner"]>,
  input: GitHubConfigurationInput,
): void {
  const current = runner.run({
    program: "gh",
    args: ["api", `repos/${input.repository.full_name}/actions/permissions/workflow`],
    cwd: input.cwd,
    timeoutMs: 30_000,
  });
  assertSuccess("GitHub Actions workflow permissions inspection", current);
  let defaultPermission: "read" | "write";
  try {
    const parsed = JSON.parse(current.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid response");
    const value = (parsed as Record<string, unknown>).default_workflow_permissions;
    if (value !== "read" && value !== "write") throw new Error("invalid default permission");
    defaultPermission = value;
  } catch {
    throw new Error("GitHub Actions workflow permissions inspection returned an invalid response");
  }
  const update = runner.run({
    program: "gh",
    args: [
      "api", "--method", "PUT",
      `repos/${input.repository.full_name}/actions/permissions/workflow`,
      "-f", `default_workflow_permissions=${defaultPermission}`,
      "-F", "can_approve_pull_request_reviews=true",
    ],
    cwd: input.cwd,
    timeoutMs: 30_000,
  });
  assertSuccess("GitHub Actions draft pull-request permission", update);
}

export function configureGitHubInstallation(
  input: GitHubConfigurationInput,
): GitHubConfigurationResult {
  const runner = input.runner ?? DEFAULT_INSTALLER_PROCESS_RUNNER;
  configureDraftPullRequestPermission(runner, input);
  removeLegacyVariables(runner, input);
  for (const label of REQUIRED_LABELS) {
    const result = runner.run({
      program: "gh",
      args: [
        "label", "create", label.name,
        "--force",
        "--color", label.color,
        "--description", label.description,
        "--repo", input.repository.full_name,
      ],
      cwd: input.cwd,
      timeoutMs: 30_000,
    });
    assertSuccess(`GitHub label ${label.name}`, result);
  }

  const variables = new Map<string, string>([
    ["AGENTIFY_REPOSITORY_ID", input.repository.repository_id],
    ["AGENTIFY_DEFAULT_BRANCH", input.repository.default_branch],
    ["AGENTIFY_VERSION", input.agentifyVersion],
  ]);
  if (input.provider) variables.set("PI_PROVIDER", input.provider);
  if (input.model) variables.set("PI_MODEL", input.model);
  for (const [name, value] of variables) setVariable(runner, input, name, value);

  let providerSecret: string | null = null;
  if (input.providerSecret) {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(input.providerSecret.name)) {
      throw new Error("provider secret name must be an uppercase GitHub secret identifier");
    }
    if (!input.providerSecret.value) throw new Error("provider secret value cannot be empty");
    const result = runner.run({
      program: "gh",
      args: ["secret", "set", input.providerSecret.name, "--repo", input.repository.full_name],
      cwd: input.cwd,
      timeoutMs: 30_000,
      input: input.providerSecret.value,
    });
    assertSuccess(`GitHub secret ${input.providerSecret.name}`, result);
    providerSecret = input.providerSecret.name;
  }

  let credentialSecret: "PI_AUTH_JSON" | null = null;
  if (input.credentialSecret) {
    if (input.credentialSecret.name !== "PI_AUTH_JSON") {
      throw new Error("provider credential payload must use the managed PI_AUTH_JSON name");
    }
    const bytes = Buffer.byteLength(input.credentialSecret.value, "utf8");
    if (bytes < 2 || bytes > 256 * 1024) throw new Error("provider credential payload is outside its bounded size");
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.credentialSecret.value);
    } catch {
      throw new Error("provider credential payload is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("provider credential payload must contain a provider credential object");
    }
    const result = runner.run({
      program: "gh",
      args: ["secret", "set", "PI_AUTH_JSON", "--repo", input.repository.full_name],
      cwd: input.cwd,
      timeoutMs: 30_000,
      input: input.credentialSecret.value,
    });
    assertSuccess("GitHub secret PI_AUTH_JSON", result);
    credentialSecret = "PI_AUTH_JSON";
  }

  let automationSecret: "AGENT_PAT" | null = null;
  if (input.automationSecret) {
    if (input.automationSecret.name !== "AGENT_PAT") {
      throw new Error("GitHub automation secret must use the managed AGENT_PAT name");
    }
    if (!input.automationSecret.value) throw new Error("GitHub automation token cannot be empty");
    const result = runner.run({
      program: "gh",
      args: ["secret", "set", "AGENT_PAT", "--repo", input.repository.full_name],
      cwd: input.cwd,
      timeoutMs: 30_000,
      input: input.automationSecret.value,
    });
    assertSuccess("GitHub automation secret AGENT_PAT", result);
    automationSecret = "AGENT_PAT";
  }

  return {
    labels_configured: REQUIRED_LABELS.length,
    variables_configured: [...variables.keys()],
    provider_secret_configured: providerSecret,
    credential_secret_configured: credentialSecret,
    automation_secret_configured: automationSecret,
  };
}
