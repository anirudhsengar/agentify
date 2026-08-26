import * as fs from "node:fs";
import * as path from "node:path";
import { digestCanonical } from "../memory/serialization.ts";

const TASK_POLICY_RELATIVE_PATH = ".github/agentify-task-policy.json";
const TEAM_MANIFEST_RELATIVE_PATH = ".agentify/manifest.json";
const AGENTIFY_VALIDATION_SMOKE_COMMAND_ID = "test-agentify-validation-smoke";
const DIGEST = /^[0-9a-f]{64}$/;

function normalizedArgv(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return null;
  const argv: string[] = [];
  for (const token of value) {
    if (
      typeof token !== "string"
      || token.length === 0
      || token.length > 2_048
      || /[\u0000-\u001f\u007f]/.test(token)
    ) return null;
    argv.push(token);
  }
  return argv;
}

function trustedPolicyCommands(value: unknown): string[][] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  const policyDigest = policy.policy_digest;
  if (
    typeof policyDigest !== "string"
    || !DIGEST.test(policyDigest)
    || digestCanonical({ ...policy, policy_digest: undefined }) !== policyDigest
    || !Array.isArray(policy.validation_commands)
  ) return null;

  const commands: string[][] = [];
  for (const value of policy.validation_commands) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const command = value as Record<string, unknown>;
    if (
      typeof command.command_id !== "string"
      || command.command_id.trim().length === 0
      || typeof command.cwd !== "string"
      || command.cwd.trim().length === 0
      || typeof command.timeout_ms !== "number"
      || !Number.isSafeInteger(command.timeout_ms)
      || command.timeout_ms <= 0
      || command.required !== true
      || command.mutation_allowed !== false
      || command.source !== "repository-policy"
    ) return null;
    if (command.command_id === AGENTIFY_VALIDATION_SMOKE_COMMAND_ID) continue;
    const argv = normalizedArgv(command.argv);
    if (argv === null) return null;
    commands.push(argv);
  }
  return commands;
}

/**
 * Read the installed trusted task-policy command allowlist without importing
 * the installer or task-lifecycle layers. Before persistent installation, an
 * absent policy preserves discovery's historical map-only behavior. Once a
 * team manifest exists, a missing, malformed, unconfigured, or digest-invalid
 * policy returns an empty allowlist and therefore fails closed.
 */
export function readInstalledTrustedValidationArgv(
  cwd: string,
): string[][] | undefined {
  const absolute = path.join(cwd, ...TASK_POLICY_RELATIVE_PATH.split("/"));
  if (!fs.existsSync(absolute)) {
    const installedManifest = path.join(cwd, ...TEAM_MANIFEST_RELATIVE_PATH.split("/"));
    return fs.existsSync(installedManifest) ? [] : undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as {
      format?: unknown;
      schema_version?: unknown;
      configured?: unknown;
      policy?: unknown;
    };
    if (
      parsed.format !== "agentify_task_policy_configuration"
      || parsed.schema_version !== "2"
      || parsed.configured !== true
    ) return [];
    return trustedPolicyCommands(parsed.policy) ?? [];
  } catch {
    return [];
  }
}
