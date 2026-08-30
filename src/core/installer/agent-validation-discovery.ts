import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodebaseMap } from "../audit/schema.ts";
import type {
  InstallerCommand,
  InstallerCommandKind,
  InstallerProcessResult,
  InstallerProcessRunner,
  RepositoryInstallationPreflight,
  RepositoryValidationApproval,
} from "./contracts.ts";
import { DEFAULT_INSTALLER_PROCESS_RUNNER } from "./process-runner.ts";
import {
  commandId,
  COMMAND_TIMEOUTS,
  runValidationCommandSet,
  unsafeReason,
} from "./build-systems/shared.ts";
import { createRepositoryValidationApproval } from "./task-policy.ts";
import { packageRoot } from "../pi-sdk-runtime.ts";
import {
  AGENTIFY_VALIDATION_SMOKE_COMMAND_ID,
  isVerifiedRepositoryTestCommand,
} from "./validation-contract.ts";
import {
  hasCommittedGitCheckout,
  runInDisposableValidationCheckout,
  type ValidationCheckoutResult,
} from "./validation-isolation.ts";

export interface ParsedCommandTarget {
  program: string;
  args: string[];
  cwdRelative: string;
}

const INSTALL_SCRIPT_PATTERN = /\b(?:get|setup|install|deps|bootstrap|init)\.sh\b/i;
const PACKAGE_INSTALL_PATTERN = /\b(?:npm|pnpm|yarn|bun|pip|pip3|poetry|gem|bundle|cargo|go)\s+install\b/i;

function resolveExecutable(program: string): string {
  if (program === "python" && process.platform !== "win32") {
    // On many modern Linux distributions (Arch, Debian, etc.), python3 is the standard binary
    return "python3";
  }
  return program;
}

export function parseCommandString(raw: string): ParsedCommandTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let workingDir = ".";
  let commandBody = trimmed;

  const cdMatch = /^cd\s+([^\s&]+)\s*&&\s*(.+)$/i.exec(trimmed);
  if (cdMatch && cdMatch[1] && cdMatch[2]) {
    workingDir = cdMatch[1].trim();
    commandBody = cdMatch[2].trim();
  }

  // Tokenize arguments respecting quotes
  const tokens: string[] = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(commandBody)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1]);
    } else if (match[2] !== undefined) {
      tokens.push(match[2]);
    } else if (match[0] !== undefined) {
      tokens.push(match[0]);
    }
  }

  if (tokens.length === 0 || !tokens[0]) return null;
  return {
    program: resolveExecutable(tokens[0]),
    args: tokens.slice(1),
    cwdRelative: workingDir,
  };
}

export interface AuditedCommandCandidate {
  command: string;
  kind: InstallerCommandKind;
}

function inferredAuditedCommandKind(command: string): InstallerCommandKind {
  const normalized = command.trim().toLowerCase();
  if (
    /(?:^|[\s:_-])(?:test|tests|pytest|jest|vitest|rspec|ctest)(?:$|[\s:_-])/.test(normalized)
    || /\b(?:go|cargo|mvn|gradle|gradlew|make)\s+test\b/.test(normalized)
    || /\btox\b/.test(normalized)
  ) return "test";
  if (
    /(?:^|[\s:_-])(?:lint|fmt|format)(?:$|[\s:_-])/.test(normalized)
    || /\b(?:eslint|ruff|golangci-lint|gofmt|prettier|clippy)\b/.test(normalized)
  ) return "lint";
  if (
    /(?:^|[\s:_-])(?:typecheck|type-check|vet)(?:$|[\s:_-])/.test(normalized)
    || /\b(?:tsc|mypy|pyright)\b/.test(normalized)
    || /\bcargo\s+check\b/.test(normalized)
  ) return "typecheck";
  if (/(?:^|[\s:_-])(?:package|pack)(?:$|[\s:_-])/.test(normalized)) return "package";
  return "build";
}

export function extractAuditedCommandCandidates(map: CodebaseMap): AuditedCommandCandidate[] {
  const candidates: AuditedCommandCandidate[] = [];

  const add = (command: unknown, kind: InstallerCommandKind): void => {
    if (typeof command !== "string" || command.trim().length === 0) return;
    candidates.push({ command: command.trim(), kind });
  };

  add(map.validation_surface?.test_command, "test");
  add(map.validation_surface?.e2e_command, "test");
  add(map.validation_surface?.lint_command, "lint");
  add(map.validation_surface?.typecheck_command, "typecheck");

  const perChange = map.validation_surface?.per_change_type;
  if (perChange) {
    for (const group of [
      perChange.feature,
      perChange.bug,
      perChange.chore,
      perChange.refactor,
      perChange.security,
    ]) {
      if (Array.isArray(group?.mandatory)) {
        for (const cmd of group.mandatory) {
          if (typeof cmd === "string") add(cmd, inferredAuditedCommandKind(cmd));
        }
      }
    }
  }

  const unique = new Map<string, AuditedCommandCandidate>();
  for (const candidate of candidates) {
    if (
      INSTALL_SCRIPT_PATTERN.test(candidate.command)
      || PACKAGE_INSTALL_PATTERN.test(candidate.command)
    ) continue;
    const key = `${candidate.kind}\u0000${candidate.command}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()].sort((left, right) => {
    const testPriority = Number(right.kind === "test") - Number(left.kind === "test");
    return testPriority !== 0
      ? testPriority
      : left.command.localeCompare(right.command);
  });
}

export function testAuditedValidationCommand(
  cwd: string,
  commandStr: string,
  runner: InstallerProcessRunner,
  kind: InstallerCommandKind = "test",
  dependencyCommand?: InstallerCommand,
): InstallerCommand | null {
  if (INSTALL_SCRIPT_PATTERN.test(commandStr) || PACKAGE_INSTALL_PATTERN.test(commandStr)) {
    return null;
  }

  const parsed = parseCommandString(commandStr);
  if (!parsed) return null;

  const unsafe = unsafeReason(commandStr);
  if (unsafe) return null;

  const execute = (checkoutCwd: string): {
    program: string;
    result: InstallerProcessResult;
  } | null => {
    if (dependencyCommand !== undefined) {
      const [provisioned] = runValidationCommandSet(checkoutCwd, runner, [{
        ...dependencyCommand,
        assessment: "characterized",
      }]);
      if (provisioned?.assessment !== "verified") return null;
    }
    const executionCwd = path.resolve(checkoutCwd, parsed.cwdRelative);
    if (!fs.existsSync(executionCwd)) return null;
    const result = runner.run({
      program: parsed.program,
      args: parsed.args,
      cwd: executionCwd,
      timeoutMs: Math.min(COMMAND_TIMEOUTS[kind], 60_000),
    });
    if (result.status === 0 && !result.timedOut && result.errorMessage === null) {
      return { program: parsed.program, result };
    }
    if (parsed.program !== "python3") return null;
    const fallbackResult = runner.run({
      program: "python",
      args: parsed.args,
      cwd: executionCwd,
      timeoutMs: Math.min(COMMAND_TIMEOUTS[kind], 60_000),
    });
    return fallbackResult.status === 0
      && !fallbackResult.timedOut
      && fallbackResult.errorMessage === null
      ? { program: "python", result: fallbackResult }
      : null;
  };
  const execution: ValidationCheckoutResult<ReturnType<typeof execute>> = hasCommittedGitCheckout(cwd)
    ? runInDisposableValidationCheckout({ cwd, operation: execute })
    : { ok: true, value: execute(cwd) };
  if (!execution.ok || execution.value === null) return null;

  const { program, result } = execution.value;
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    command_id: commandId(kind, `audited-${program}-${parsed.args[0] ?? "run"}`),
    kind,
    argv: [program, ...parsed.args],
    cwd: parsed.cwdRelative,
    timeout_ms: COMMAND_TIMEOUTS[kind],
    required: true,
    assessment: "verified",
    exit_code: result.status,
    output_digest: crypto.createHash("sha256").update(output).digest("hex"),
    detail: `verified from agent audit validation surface (${commandStr})`,
  };
}

export const VALIDATION_SMOKE_RELATIVE_PATH = ".github/agentify/validation-smoke.mjs";

/**
 * Install the Agentify-owned validation smoke asset. The asset embeds the
 * managed marker, so byte-identical reinstalls are no-ops and marker-bearing
 * earlier copies may be refreshed; a marker-less file at the path belongs to
 * the user and is never clobbered here (the scaffold installer reports the
 * conflict instead).
 */
function installValidationSmokeAsset(cwd: string): boolean {
  const source = path.join(packageRoot(), "scaffold", ...VALIDATION_SMOKE_RELATIVE_PATH.split("/"));
  const destination = path.join(cwd, ...VALIDATION_SMOKE_RELATIVE_PATH.split("/"));
  let content: Buffer;
  try {
    content = fs.readFileSync(source);
  } catch {
    return false;
  }
  try {
    if (fs.existsSync(destination)) {
      const existing = fs.readFileSync(destination);
      if (Buffer.compare(existing, content) === 0) return true;
      if (!existing.toString("utf-8").includes("// agentify:managed")) return false;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, { mode: 0o755 });
    return true;
  } catch {
    return false;
  }
}

/**
 * When no repository validation command verifies, Agentify installs a bounded
 * diagnostic: an Agentify-owned, dependency-free smoke validator under
 * `.github/agentify/` that checks tracked JSON validity, JavaScript syntax,
 * and committed-secret patterns. Returns the
 * verified diagnostic command, or null when the validator could not be
 * installed or did not pass on the current tree. Callers must never treat this
 * command as repository behavioral validation.
 */
export function scaffoldValidationSmokeCommand(
  cwd: string,
  runner: InstallerProcessRunner,
): InstallerCommand | null {
  if (!installValidationSmokeAsset(cwd)) return null;
  const execute = (checkoutCwd: string) => runner.run({
    program: "node",
    args: [VALIDATION_SMOKE_RELATIVE_PATH],
    cwd: checkoutCwd,
    timeoutMs: 60_000,
  });
  const execution = hasCommittedGitCheckout(cwd)
    ? runInDisposableValidationCheckout({
      cwd,
      overlayPaths: [".github/agentify"],
      operation: execute,
    })
    : { ok: true as const, value: execute(cwd) };
  if (!execution.ok) return null;
  const result = execution.value;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0 || result.timedOut || result.errorMessage !== null) return null;
  return {
    command_id: AGENTIFY_VALIDATION_SMOKE_COMMAND_ID,
    kind: "test",
    argv: ["node", VALIDATION_SMOKE_RELATIVE_PATH],
    cwd: ".",
    timeout_ms: 60_000,
    required: true,
    assessment: "verified",
    exit_code: result.status,
    output_digest: crypto.createHash("sha256").update(output).digest("hex"),
    detail: "Agentify-installed deterministic validation smoke: tracked JSON validity, JavaScript syntax, and committed-secret scan",
  };
}

export function refinePreflightWithAudit(input: {
  cwd: string;
  preflight: RepositoryInstallationPreflight;
  map: CodebaseMap | null;
  runner?: InstallerProcessRunner;
}): {
  preflight: RepositoryInstallationPreflight;
  validationApproval: RepositoryValidationApproval | null;
} {
  const runner = input.runner ?? DEFAULT_INSTALLER_PROCESS_RUNNER;
  let preflight = { ...input.preflight };
  let commands = [...preflight.commands];

  const hasPassingRequiredTest = commands.some(isVerifiedRepositoryTestCommand);

  if (hasPassingRequiredTest && preflight.disposition === "ready") {
    return { preflight: input.preflight, validationApproval: null };
  }

  if (!hasPassingRequiredTest && input.map) {
    const candidates = extractAuditedCommandCandidates(input.map);
    const dependencyCommand = commands.find((command) => (
      command.kind === "install" && command.assessment === "verified"
    ));
    for (const candidate of candidates) {
      if (candidate.kind !== "test") continue;
      const verified = testAuditedValidationCommand(
        input.cwd,
        candidate.command,
        runner,
        candidate.kind,
        dependencyCommand,
      );
      if (verified) {
        commands = [
          ...commands.filter((command) => !(
            command.kind === verified.kind
            && command.required
            && command.assessment === "failed"
          )),
          verified,
        ];
        break;
      }
    }
  }

  // If no repository validation command verifies, install and run the
  // Agentify-owned smoke as a bounded diagnostic. It never substitutes for a
  // repository-owned test and it does not erase failed repository commands.
  const stillNoRepositoryTest = !commands.some(isVerifiedRepositoryTestCommand);
  const hasAnyVerified = commands.some(
    (command) => command.kind !== "install"
      && command.required
      && command.assessment === "verified",
  );
  if (stillNoRepositoryTest && !hasAnyVerified) {
    const scaffolded = scaffoldValidationSmokeCommand(input.cwd, runner);
    if (scaffolded) {
      commands = [
        ...commands.filter((command) =>
          command.command_id !== AGENTIFY_VALIDATION_SMOKE_COMMAND_ID
        ),
        scaffolded,
      ];
    }
  }

  // A formatter, linter, build, or Agentify-owned smoke check is useful
  // evidence, but none proves the repository's application behavior. Issue
  // intake and draft publication require one repository-owned test command.
  const hasNowPassingTest = commands.some(isVerifiedRepositoryTestCommand);
  const hasFailedRequiredValidation = commands.some((command) =>
    command.kind !== "install"
    && command.required
    && command.assessment === "failed"
  );

  let blockers = preflight.blockers.filter((blocker) => {
    if (blocker.code === "missing_deterministic_validation") return !hasNowPassingTest;
    if (blocker.code === "validation_failed") {
      return hasFailedRequiredValidation;
    }
    return true;
  });
  if (
    !hasNowPassingTest
    && !blockers.some((blocker) => blocker.code === "missing_deterministic_validation")
  ) {
    blockers = [
      ...blockers,
      {
        code: "missing_deterministic_validation",
        message: "No repository-owned test command completed successfully.",
        remediation:
          "Record and repair one deterministic repository test command. Formatting, lint, build, typecheck, and Agentify smoke checks cannot establish application readiness by themselves.",
      },
    ];
  }

  preflight = {
    ...preflight,
    commands,
    blockers,
    disposition: blockers.length === 0 && preflight.analysis_allowed && preflight.identity !== null
      ? "ready"
      : preflight.analysis_allowed
        ? "analyzable-only"
        : "blocked",
  };

  const validationApproval = preflight.disposition === "ready"
    ? createRepositoryValidationApproval({
        cwd: input.cwd,
        preflight,
        approvedBy: preflight.identity?.actor_login ?? "maintainer",
      })
    : null;

  return { preflight, validationApproval };
}
