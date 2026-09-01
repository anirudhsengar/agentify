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

const NESTED_MANIFESTS = new Set([
  "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py",
  "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts",
  "Gemfile", "Makefile", "makefile",
]);
const IGNORED_NESTED_AREAS = new Set([
  ".git", ".venv", "build", "dist", "generated", "node_modules", "target", "vendor", "venv",
]);
const MAX_NESTED_MANIFEST_DIRECTORIES = 64;

function nestedManifestDirectories(cwd: string): string[] {
  const listed = spawnSync(
    "git",
    ["-C", cwd, "ls-tree", "-r", "--name-only", "-z", "HEAD", "--"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (listed.status !== 0) return [];
  const directories = new Set<string>();
  for (const repositoryPath of listed.stdout.split("\0")) {
    if (!repositoryPath.includes("/")) continue;
    const parts = repositoryPath.split("/");
    const basename = parts.pop();
    if (basename === undefined || !NESTED_MANIFESTS.has(basename)) continue;
    if (parts.length > 4 || parts.some((part) => IGNORED_NESTED_AREAS.has(part))) continue;
    directories.add(parts.join("/"));
  }
  return [...directories].sort().slice(0, MAX_NESTED_MANIFEST_DIRECTORIES);
}

function prefixDiscovery(discovery: BuildSystemDiscovery, directory: string): BuildSystemDiscovery {
  const prefix = (relative: string): string => path.posix.join(directory, relative === "." ? "" : relative);
  return {
    manifest: { ...discovery.manifest, path: prefix(discovery.manifest.path) },
    commands: discovery.commands.map((command) => ({ ...command, cwd: prefix(command.cwd) })),
    lockfile: discovery.lockfile === null
      ? null
      : { path: prefix(discovery.lockfile.path) },
    requiresLockfile: discovery.requiresLockfile,
  };
}

function discoveryRank(discovery: BuildSystemDiscovery, root: boolean): number {
  const safe = discovery.commands.filter((command) => command.assessment !== "unsafe");
  if (safe.some((command) => command.kind === "test" && command.required)) return 100 + Number(root);
  if (safe.some((command) => command.kind !== "install")) return 10 + Number(root);
  return Number(root);
}

function selectBuildSystem(cwd: string): BuildSystemDiscovery | null {
  const candidates: Array<{ discovery: BuildSystemDiscovery; root: boolean; priority: number }> = [];
  for (const [priority, discover] of DISCOVERERS.entries()) {
    const discovery = discover(cwd);
    if (discovery !== null) candidates.push({ discovery, root: true, priority });
  }
  for (const directory of nestedManifestDirectories(cwd)) {
    const absolute = path.join(cwd, ...directory.split("/"));
    for (const [priority, discover] of DISCOVERERS.entries()) {
      const discovery = discover(absolute);
      if (discovery !== null) candidates.push({
        discovery: prefixDiscovery(discovery, directory),
        root: false,
        priority,
      });
    }
  }
  return candidates.sort((left, right) =>
    discoveryRank(right.discovery, right.root) - discoveryRank(left.discovery, left.root)
    || left.priority - right.priority
    || left.discovery.manifest.path.localeCompare(right.discovery.manifest.path)
  )[0]?.discovery ?? null;
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
import { spawnSync } from "node:child_process";
import * as path from "node:path";
