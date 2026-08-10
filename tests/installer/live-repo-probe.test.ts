#!/usr/bin/env node
/** Live repo discovery/validation probe for validation campaign. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverRepositoryCommands } from "../../src/core/installer/command-discovery.ts";
import { inspectRepositoryForInstallation } from "../../src/core/installer/repository-inspection.ts";
import { DEFAULT_INSTALLER_PROCESS_RUNNER } from "../../src/core/installer/process-runner.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const LIVE = path.join(ROOT, ".tmp-live");
const RUN_VALIDATION = process.env.AGENTIFY_LIVE_RUN_VALIDATION === "1";

function goOk(): boolean {
  return spawnSync("go", ["version"], { encoding: "utf-8", windowsHide: true }).status === 0;
}

function toolOk(command: string, args: string[] = ["--version"]): boolean {
  return spawnSync(command, args, { encoding: "utf-8", windowsHide: true }).status === 0;
}

function canValidateRepo(ecosystem: string | undefined, discoveryBlockers: string[]): boolean {
  if (!RUN_VALIDATION) return false;
  if (discoveryBlockers.includes("missing_dependency_lock")) return false;
  switch (ecosystem) {
    case "node":
      return true;
    case "go":
      return goOk();
    case "rust":
      return toolOk("cargo");
    case "python":
      return toolOk("uv") || toolOk("pytest") || toolOk("make");
    case "gradle":
    case "maven":
      return toolOk("java");
    case "ruby":
      return toolOk("ruby") && toolOk("bundle", ["--version"]);
    case "make":
      return toolOk("make") || toolOk("gmake");
    default:
      return false;
  }
}

const repos = fs.existsSync(LIVE)
  ? fs.readdirSync(LIVE, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(LIVE, e.name))
  : [];

if (repos.length === 0) {
  console.log("  skip live-repo-probe (no .tmp-live clones)");
  process.exit(0);
}

let passed = 0;
for (const cwd of repos) {
  const name = path.basename(cwd);
  const discoveryOnly = discoverRepositoryCommands(cwd, DEFAULT_INSTALLER_PROCESS_RUNNER, false);
  const validate = canValidateRepo(
    discoveryOnly.manifest?.ecosystem,
    discoveryOnly.blockers.map((b) => b.code),
  );
  const discovery = validate
    ? discoverRepositoryCommands(cwd, DEFAULT_INSTALLER_PROCESS_RUNNER, true)
    : discoveryOnly;
  const preflight = inspectRepositoryForInstallation({ cwd, runValidation: validate });
  const blockerCodes = [...new Set([
    ...discovery.blockers.map((b) => b.code),
    ...preflight.blockers.map((b) => b.code),
  ])].sort();
  const manifest = discovery.manifest?.path ?? "none";
  const required = discovery.commands
    .filter((c) => c.required && c.kind !== "install")
    .map((c) => `${c.argv.join(" ")}:${c.assessment}${c.exit_code === null ? "" : `:${c.exit_code}`}`)
    .join("; ");
  console.log(
    `  ok ${name}: manifest=${manifest} validate=${validate} blockers=[${blockerCodes.join(", ")}] validation="${required}"`,
  );
  passed += 1;
}
console.log(`live repo probe passed (${passed}/${repos.length}).`);
