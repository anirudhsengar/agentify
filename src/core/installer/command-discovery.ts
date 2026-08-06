import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  InstallerBlocker,
  InstallerCommand,
  InstallerCommandKind,
  InstallerProcessRunner,
} from "./contracts.ts";
import { conciseProcessFailure } from "./process-runner.ts";

const COMMAND_TIMEOUTS: Readonly<Record<InstallerCommandKind, number>> = {
  install: 15 * 60_000,
  build: 10 * 60_000,
  typecheck: 10 * 60_000,
  lint: 10 * 60_000,
  test: 30 * 60_000,
  package: 15 * 60_000,
};

const SCRIPT_NAMES: Readonly<Record<Exclude<InstallerCommandKind, "install">, readonly string[]>> = {
  build: ["build"],
  typecheck: ["typecheck", "type-check"],
  lint: ["lint"],
  test: ["test", "test:all", "check"],
  package: ["test:package", "pack", "package"],
};

const UNSAFE_SCRIPT = /\b(?:deploy|publish|release|terraform\s+apply|kubectl\s+apply|aws\s+|gcloud\s+|az\s+)\b/i;
const PRODUCTION_CREDENTIAL = /\b(?:PROD(?:UCTION)?_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|DATABASE_URL|STRIPE_SECRET_KEY|AWS_SECRET_ACCESS_KEY)\b/;

interface PackageJsonShape {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

function readPackageJson(cwd: string): PackageJsonShape | null {
  const filePath = path.join(cwd, "package.json");
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as PackageJsonShape;
}

function scriptMap(value: PackageJsonShape): Record<string, string> {
  const output: Record<string, string> = {};
  if (!value.scripts || typeof value.scripts !== "object") return output;
  for (const [name, script] of Object.entries(value.scripts)) {
    if (typeof script === "string" && script.trim()) output[name] = script;
  }
  return output;
}

function hasDeclaredDependencies(value: PackageJsonShape): boolean {
  return [value.dependencies, value.devDependencies, value.optionalDependencies]
    .some((dependencies) => (
      dependencies !== null
      && typeof dependencies === "object"
      && !Array.isArray(dependencies)
      && Object.keys(dependencies).length > 0
    ));
}

function commandId(kind: InstallerCommandKind, script: string): string {
  return `${kind}-${script.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

function unsafeReason(script: string): string | null {
  if (UNSAFE_SCRIPT.test(script)) return "script includes a deployment, publication, release, or infrastructure mutation";
  if (PRODUCTION_CREDENTIAL.test(script)) return "script references a production credential or service endpoint";
  return null;
}

function runCommand(
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

export function discoverRepositoryCommands(
  cwd: string,
  runner: InstallerProcessRunner,
  runValidation: boolean,
): { commands: InstallerCommand[]; blockers: InstallerBlocker[] } {
  const packageJson = readPackageJson(cwd);
  if (!packageJson) {
    return {
      commands: [],
      blockers: [{
        code: "unsupported_build_system",
        message: "No supported package.json build contract was found.",
        remediation: "Add a deterministic supported build manifest and explicit validation scripts.",
      }],
    };
  }
  const scripts = scriptMap(packageJson);
  const commands: InstallerCommand[] = [];
  const lockName = ["npm-shrinkwrap.json", "package-lock.json"].find((name) => fs.existsSync(path.join(cwd, name)));
  if (lockName) {
    commands.push({
      command_id: "install-npm-ci",
      kind: "install",
      argv: ["npm", "ci"],
      cwd: ".",
      timeout_ms: COMMAND_TIMEOUTS.install,
      required: false,
      assessment: "characterized",
      exit_code: null,
      output_digest: null,
      detail: `deterministic npm install is locked by ${lockName}; characterized without mutating dependencies`,
    });
  }

  for (const [kind, candidates] of Object.entries(SCRIPT_NAMES) as Array<[
    Exclude<InstallerCommandKind, "install">,
    readonly string[],
  ]>) {
    const scriptName = candidates.find((candidate) => scripts[candidate] !== undefined);
    if (!scriptName) continue;
    const script = scripts[scriptName]!;
    const unsafe = unsafeReason(script);
    const command: InstallerCommand = {
      command_id: commandId(kind, scriptName),
      kind,
      argv: ["npm", "run", scriptName],
      cwd: ".",
      timeout_ms: COMMAND_TIMEOUTS[kind],
      required: kind === "test" || kind === "typecheck" || kind === "lint",
      assessment: unsafe ? "unsafe" : "characterized",
      exit_code: null,
      output_digest: null,
      detail: unsafe ?? "deterministic package script discovered",
    };
    commands.push(runValidation && !unsafe ? runCommand(cwd, runner, command) : command);
  }

  const blockers: InstallerBlocker[] = [];
  if (!lockName && hasDeclaredDependencies(packageJson)) {
    blockers.push({
      code: "missing_dependency_lock",
      message: "Repository validation depends on npm packages but no npm lockfile is committed.",
      remediation: "Commit package-lock.json or npm-shrinkwrap.json so a fresh GitHub checkout can reproduce validation dependencies.",
    });
  }
  const unsafeProduction = commands.some((command) => command.assessment === "unsafe" && /credential|service endpoint/.test(command.detail));
  const unsafeMutation = commands.some((command) => command.assessment === "unsafe" && !/credential|service endpoint/.test(command.detail));
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
      message: "No deterministic test, typecheck, or lint script was discovered.",
      remediation: "Add at least one deterministic application-owned validation script.",
    });
  } else if (runValidation && commands.some((command) => (
    command.kind !== "install" && command.assessment === "failed"
  ))) {
    blockers.push({
      code: "validation_failed",
      message: "At least one required repository validation command did not pass.",
      remediation: "Repair the failing validation command, then rerun the installer verification.",
    });
  }
  return { commands, blockers };
}
