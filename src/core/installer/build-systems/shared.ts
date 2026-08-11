import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  InstallerBlocker,
  InstallerCommand,
  InstallerCommandKind,
  InstallerProcessRunner,
} from "../contracts.ts";
import { conciseProcessFailure } from "../process-runner.ts";

export const COMMAND_TIMEOUTS: Readonly<Record<InstallerCommandKind, number>> = {
  install: 15 * 60_000,
  build: 10 * 60_000,
  typecheck: 10 * 60_000,
  lint: 10 * 60_000,
  test: 30 * 60_000,
  // Exact-artifact qualification packs, installs, and smoke-runs the real
  // tarball five times; on Windows hosts under load this exceeds 30 minutes
  // even when healthy (each smoke performs a full npm install of the tarball).
  package: 90 * 60_000,
};

export const VALIDATION_SCRIPT_NAMES: Readonly<Record<
  Exclude<InstallerCommandKind, "install">,
  readonly string[]
>> = {
  build: ["build"],
  typecheck: ["typecheck", "type-check"],
  lint: ["lint"],
  test: ["test", "test:all", "check"],
  package: ["test:package", "pack", "package"],
};

export const UNSAFE_SCRIPT = /\b(?:deploy|publish|release|terraform\s+apply|kubectl\s+apply|aws\s+|gcloud\s+|az\s+)\b/i;
export const PRODUCTION_CREDENTIAL = /\b(?:PROD(?:UCTION)?_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|DATABASE_URL|STRIPE_SECRET_KEY|AWS_SECRET_ACCESS_KEY)\b/;

export interface BuildManifest {
  path: string;
  ecosystem: string;
}

export interface BuildSystemDiscovery {
  manifest: BuildManifest;
  commands: InstallerCommand[];
  lockfile: { path: string } | null;
  requiresLockfile: boolean;
}

export function fileExists(cwd: string, relative: string): boolean {
  return fs.existsSync(path.join(cwd, relative));
}

export function readText(cwd: string, relative: string): string | null {
  const absolute = path.join(cwd, relative);
  if (!fs.existsSync(absolute)) return null;
  return fs.readFileSync(absolute, "utf-8");
}

export function firstExisting(cwd: string, candidates: readonly string[]): string | null {
  return candidates.find((candidate) => fileExists(cwd, candidate)) ?? null;
}

export function commandId(kind: InstallerCommandKind, label: string): string {
  return `${kind}-${label.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

export function unsafeReason(script: string): string | null {
  if (UNSAFE_SCRIPT.test(script)) return "script includes a deployment, publication, release, or infrastructure mutation";
  if (PRODUCTION_CREDENTIAL.test(script)) return "script references a production credential or service endpoint";
  return null;
}

export function makeCommand(input: {
  kind: InstallerCommandKind;
  label: string;
  argv: string[];
  required?: boolean;
  detail?: string;
}): InstallerCommand {
  const script = input.argv.join(" ");
  const unsafe = unsafeReason(script);
  return {
    command_id: commandId(input.kind, input.label),
    kind: input.kind,
    argv: input.argv,
    cwd: ".",
    timeout_ms: COMMAND_TIMEOUTS[input.kind],
    required: input.required ?? (input.kind === "test" || input.kind === "typecheck" || input.kind === "lint"),
    assessment: unsafe ? "unsafe" : "characterized",
    exit_code: null,
    output_digest: null,
    detail: unsafe ?? input.detail ?? "deterministic validation command discovered",
  };
}

export function runCommand(
  cwd: string,
  runner: InstallerProcessRunner,
  command: InstallerCommand,
): InstallerCommand {
  const result = runner.run({
    program: command.argv[0]!,
    args: command.argv.slice(1),
    cwd,
    timeoutMs: command.timeout_ms,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    ...command,
    assessment: result.status === 0 ? "verified" : "failed",
    exit_code: result.status,
    output_digest: crypto.createHash("sha256").update(output).digest("hex"),
    detail: result.status === 0
      ? "completed successfully under the configured timeout and sanitized environment"
      : conciseProcessFailure(result),
  };
}

export function runDiscoveredCommands(
  cwd: string,
  runner: InstallerProcessRunner,
  commands: InstallerCommand[],
  runValidation: boolean,
): InstallerCommand[] {
  return commands.map((command) => (
    runValidation && command.assessment === "characterized" && command.kind !== "install"
      ? runCommand(cwd, runner, command)
      : command
  ));
}

export function makefileTargets(cwd: string): Set<string> {
  const content = readText(cwd, "Makefile") ?? readText(cwd, "makefile");
  if (!content) return new Set();
  const targets = new Set<string>();
  for (const match of content.matchAll(/^([a-zA-Z0-9_.-]+)\s*(?::[^=\n]*)?$/gm)) {
    const name = match[1];
    if (name && !name.startsWith(".")) targets.add(name);
  }
  return targets;
}

export function makefileCommands(cwd: string): InstallerCommand[] {
  const targets = makefileTargets(cwd);
  const commands: InstallerCommand[] = [];
  for (const [kind, names] of Object.entries(VALIDATION_SCRIPT_NAMES) as Array<[
    Exclude<InstallerCommandKind, "install">,
    readonly string[],
  ]>) {
    const target = names.find((name) => targets.has(name));
    if (!target) continue;
    commands.push(makeCommand({
      kind,
      label: `make-${target}`,
      argv: process.platform === "win32" ? ["make", target] : ["make", target],
      detail: `Makefile target '${target}' discovered`,
    }));
  }
  return commands;
}

export function mergeValidationCommands(commands: InstallerCommand[]): InstallerCommand[] {
  const byKind = new Map<InstallerCommandKind, InstallerCommand>();
  for (const command of commands) {
    const existing = byKind.get(command.kind);
    if (!existing || (command.required && !existing.required)) byKind.set(command.kind, command);
  }
  return [...byKind.values()];
}

export function collectBlockers(
  discovery: BuildSystemDiscovery,
  commands: InstallerCommand[],
  runValidation: boolean,
): InstallerBlocker[] {
  const blockers: InstallerBlocker[] = [];
  if (discovery.requiresLockfile && !discovery.lockfile) {
    blockers.push({
      code: "missing_dependency_lock",
      message: `Repository validation depends on ${discovery.manifest.ecosystem} packages but no lockfile is committed.`,
      remediation: `Commit a deterministic ${discovery.manifest.ecosystem} lockfile so a fresh GitHub checkout can reproduce validation dependencies.`,
    });
  }
  const unsafeProduction = commands.some((command) => (
    command.assessment === "unsafe" && /credential|service endpoint/.test(command.detail)
  ));
  const unsafeMutation = commands.some((command) => (
    command.assessment === "unsafe" && !/credential|service endpoint/.test(command.detail)
  ));
  const validation = commands.filter((command) => command.kind !== "install" && command.required);
  if (unsafeProduction) {
    blockers.push({
      code: "unsafe_production_credentials",
      message: "A validation script requires production credentials or a production service endpoint.",
      remediation: "Provide a test-safe validation command that runs without production credentials.",
    });
  }
  if (unsafeMutation) {
    blockers.push({
      code: "unsafe_network_or_deployment",
      message: "A repository script performs deployment, publication, release, or infrastructure mutation.",
      remediation: "Separate deterministic validation from external mutation and deployment commands.",
    });
  }
  if (validation.length === 0) {
    blockers.push({
      code: "missing_deterministic_validation",
      message: "No deterministic test, typecheck, or lint command was discovered.",
      remediation: "Add at least one deterministic application-owned validation command.",
    });
  } else if (runValidation && commands.some((command) => (
    command.kind !== "install" && command.assessment === "failed"
  ))) {
    const failing = commands
      .filter((command) => command.kind !== "install" && command.assessment === "failed")
      .map((command) => `${command.command_id}: ${command.detail}`)
      .join(" | ");
    blockers.push({
      code: "validation_failed",
      message: "At least one required repository validation command did not pass.",
      remediation: `Repair the failing validation command, then rerun the installer verification. Failing: ${failing}`,
    });
  }
  return blockers;
}
