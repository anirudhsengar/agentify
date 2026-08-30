import * as fs from "node:fs";
import * as path from "node:path";
import type { InstallerCommand, InstallerCommandKind } from "../contracts.ts";
import {
  COMMAND_TIMEOUTS,
  commandId,
  fileExists,
  type BuildSystemDiscovery,
  unsafeReason,
  VALIDATION_SCRIPT_NAMES,
} from "./shared.ts";

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

export function discoverNodeBuildSystem(cwd: string): BuildSystemDiscovery | null {
  const packageJson = readPackageJson(cwd);
  if (!packageJson) return null;
  const scripts = scriptMap(packageJson);
  const commands: InstallerCommand[] = [];
  const lockName = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]
    .find((name) => fileExists(cwd, name));
  if (lockName) {
    const installArgv = lockName === "pnpm-lock.yaml"
      ? ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]
      : lockName === "yarn.lock"
        ? ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"]
        : lockName === "bun.lock"
          ? ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]
          : ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
    commands.push({
      command_id: commandId("install", "install"),
      kind: "install",
      argv: installArgv,
      cwd: ".",
      timeout_ms: COMMAND_TIMEOUTS.install,
      required: false,
      assessment: "characterized",
      exit_code: null,
      output_digest: null,
      detail: `deterministic install is locked by ${lockName}; characterized without mutating dependencies`,
    });
  }
  for (const [kind, candidates] of Object.entries(VALIDATION_SCRIPT_NAMES) as Array<[
    Exclude<InstallerCommandKind, "install">,
    readonly string[],
  ]>) {
    const scriptName = candidates.find((candidate) => scripts[candidate] !== undefined);
    if (!scriptName) continue;
    const script = scripts[scriptName]!;
    const unsafe = unsafeReason(script);
    commands.push({
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
    });
  }
  return {
    manifest: { path: "package.json", ecosystem: "node" },
    commands,
    lockfile: lockName ? { path: lockName } : null,
    requiresLockfile: hasDeclaredDependencies(packageJson),
  };
}
