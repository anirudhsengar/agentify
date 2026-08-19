import type { InstallerBlocker, InstallerCommand, InstallerProcessRunner } from "../contracts.ts";
import { discoverGoBuildSystem } from "./go.ts";
import { discoverJavaBuildSystem } from "./java.ts";
import { discoverMakefileBuildSystem } from "./makefile.ts";
import { discoverNodeBuildSystem } from "./node.ts";
import { discoverPythonBuildSystem } from "./python.ts";
import { discoverRubyBuildSystem } from "./ruby.ts";
import { discoverRustBuildSystem } from "./rust.ts";
import { discoverShellBuildSystem } from "./shell.ts";
import {
  collectBlockers,
  runDiscoveredCommands,
  type BuildManifest,
  type BuildSystemDiscovery,
} from "./shared.ts";

const DISCOVERERS = [
  discoverNodeBuildSystem,
  discoverRustBuildSystem,
  discoverGoBuildSystem,
  discoverPythonBuildSystem,
  discoverJavaBuildSystem,
  discoverRubyBuildSystem,
  discoverMakefileBuildSystem,
  discoverShellBuildSystem,
] as const;

function selectBuildSystem(cwd: string): BuildSystemDiscovery | null {
  for (const discover of DISCOVERERS) {
    const result = discover(cwd);
    if (result && result.commands.some((command) => command.kind !== "install")) return result;
  }
  for (const discover of DISCOVERERS) {
    const result = discover(cwd);
    if (result) return result;
  }
  return null;
}

export function discoverRepositoryBuildSystem(cwd: string): {
  manifest: BuildManifest | null;
  discovery: BuildSystemDiscovery | null;
} {
  const discovery = selectBuildSystem(cwd);
  return {
    manifest: discovery?.manifest ?? null,
    discovery,
  };
}

export function discoverRepositoryCommands(
  cwd: string,
  runner: InstallerProcessRunner,
  runValidation: boolean,
): { commands: InstallerCommand[]; blockers: InstallerBlocker[]; manifest: BuildManifest | null } {
  const discovery = selectBuildSystem(cwd);
  if (!discovery) {
    return {
      commands: [],
      manifest: null,
      blockers: [{
        code: "unsupported_build_system",
        message: "No supported build manifest was found.",
        remediation: "Add a deterministic build manifest (package.json, pyproject.toml, Cargo.toml, go.mod, pom.xml, build.gradle, Gemfile, Makefile, or root shell scripts such as build.sh/compile.sh/test.sh/lint.sh) with explicit validation commands.",
      }],
    };
  }
  const commands = runDiscoveredCommands(cwd, runner, discovery.commands, runValidation);
  return {
    commands,
    manifest: discovery.manifest,
    blockers: collectBlockers(discovery, commands, runValidation),
  };
}

export { type BuildManifest, type BuildSystemDiscovery } from "./shared.ts";
