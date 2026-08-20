import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodebaseMap } from "../audit/schema.ts";
import type {
  InstallerCommand,
  InstallerCommandKind,
  InstallerProcessRunner,
  RepositoryInstallationPreflight,
  RepositoryValidationApproval,
} from "./contracts.ts";
import { DEFAULT_INSTALLER_PROCESS_RUNNER } from "./process-runner.ts";
import { commandId, COMMAND_TIMEOUTS, unsafeReason } from "./build-systems/shared.ts";
import { createRepositoryValidationApproval } from "./task-policy.ts";
import { packageRoot } from "../pi-sdk-runtime.ts";

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

export function extractAuditedCommandCandidates(map: CodebaseMap): string[] {
  const candidates: string[] = [];

  if (typeof map.validation_surface?.test_command === "string") {
    candidates.push(map.validation_surface.test_command);
  }
  if (typeof map.validation_surface?.lint_command === "string") {
    candidates.push(map.validation_surface.lint_command);
  }
  if (typeof map.validation_surface?.typecheck_command === "string") {
    candidates.push(map.validation_surface.typecheck_command);
  }

  const perChange = map.validation_surface?.per_change_type;
  if (perChange) {
    for (const group of [perChange.feature, perChange.bug, perChange.chore]) {
      if (Array.isArray(group?.mandatory)) {
        for (const cmd of group.mandatory) {
          if (typeof cmd === "string") candidates.push(cmd);
        }
      }
    }
  }

  return [...new Set(candidates.map((c) => c.trim()).filter(Boolean))]
    .filter((cmd) => !INSTALL_SCRIPT_PATTERN.test(cmd) && !PACKAGE_INSTALL_PATTERN.test(cmd));
}

export function testAuditedValidationCommand(
  cwd: string,
  commandStr: string,
  runner: InstallerProcessRunner,
  kind: InstallerCommandKind = "test",
): InstallerCommand | null {
  if (INSTALL_SCRIPT_PATTERN.test(commandStr) || PACKAGE_INSTALL_PATTERN.test(commandStr)) {
    return null;
  }

  const parsed = parseCommandString(commandStr);
  if (!parsed) return null;

  const unsafe = unsafeReason(commandStr);
  if (unsafe) return null;

  const executionCwd = path.resolve(cwd, parsed.cwdRelative);
  if (!fs.existsSync(executionCwd)) return null;

  const result = runner.run({
    program: parsed.program,
    args: parsed.args,
    cwd: executionCwd,
    timeoutMs: Math.min(COMMAND_TIMEOUTS[kind], 60_000),
  });

  if (result.status !== 0 || result.timedOut) {
    // If python3 failed, fallback retry with python
    if (parsed.program === "python3") {
      const fallbackResult = runner.run({
        program: "python",
        args: parsed.args,
        cwd: executionCwd,
        timeoutMs: Math.min(COMMAND_TIMEOUTS[kind], 60_000),
      });
      if (fallbackResult.status === 0 && !fallbackResult.timedOut) {
        const output = `${fallbackResult.stdout}\n${fallbackResult.stderr}`;
        return {
          command_id: commandId(kind, `audited-python-${parsed.args[0] ?? "run"}`),
          kind,
          argv: ["python", ...parsed.args],
          cwd: parsed.cwdRelative,
          timeout_ms: COMMAND_TIMEOUTS[kind],
          required: true,
          assessment: "verified",
          exit_code: fallbackResult.status,
          output_digest: crypto.createHash("sha256").update(output).digest("hex"),
          detail: `verified from agent audit validation surface (${commandStr})`,
        };
      }
    }
    return null;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  return {
    command_id: commandId(kind, `audited-${parsed.program}-${parsed.args[0] ?? "run"}`),
    kind,
    argv: [parsed.program, ...parsed.args],
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
 * When no repository validation command verifies, Agentify adds one: an
 * Agentify-owned, dependency-free smoke validator installed under
 * `.github/agentify/` that checks tracked JSON validity, JavaScript syntax,
 * and committed-secret patterns. Returns the
 * verified command, or null when the validator could not be installed or did
 * not pass on the current tree.
 */
export function scaffoldValidationSmokeCommand(
  cwd: string,
  runner: InstallerProcessRunner,
): InstallerCommand | null {
  if (!installValidationSmokeAsset(cwd)) return null;
  const result = runner.run({
    program: "node",
    args: [VALIDATION_SMOKE_RELATIVE_PATH],
    cwd,
    timeoutMs: 60_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0 || result.timedOut) return null;
  return {
    command_id: commandId("test", "agentify-validation-smoke"),
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

  const hasPassingRequired = commands.some(
    (c) => c.kind !== "install" && c.required && c.assessment === "verified",
  );

  if (hasPassingRequired && preflight.disposition === "ready") {
    return { preflight: input.preflight, validationApproval: null };
  }

  if (!hasPassingRequired && input.map) {
    const candidates = extractAuditedCommandCandidates(input.map);
    for (const candidate of candidates) {
      const verified = testAuditedValidationCommand(input.cwd, candidate, runner);
      if (verified) {
        commands = [
          ...commands.filter((c) => c.assessment !== "failed" || !c.required),
          verified,
        ];
        break;
      }
    }
  }

  // If no repository validation command verifies, Agentify adds one itself:
  // install the Agentify-owned validation smoke asset and verify it.
  const stillNoVerified = !commands.some(
    (c) => c.kind !== "install" && c.required && c.assessment === "verified",
  );
  if (stillNoVerified) {
    const scaffolded = scaffoldValidationSmokeCommand(input.cwd, runner);
    if (scaffolded) {
      commands = [
        ...commands.filter((c) => c.assessment !== "failed" || !c.required),
        scaffolded,
      ];
    }
  }

  // Filter out blockers that were fixed by finding a verified validation command
  const hasNowPassing = commands.some(
    (c) => c.kind !== "install" && c.required && c.assessment === "verified",
  );

  let blockers = preflight.blockers;
  if (hasNowPassing) {
    blockers = blockers.filter(
      (b) => b.code !== "validation_failed" && b.code !== "missing_deterministic_validation",
    );
  }

  preflight = {
    ...preflight,
    commands,
    blockers,
    disposition: blockers.length === 0 ? "ready" : "analyzable-only",
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
