import { spawnSync } from "node:child_process";
import type { InstallerCommand } from "../contracts.ts";
import {
  fileExists,
  makefileCommands,
  makeCommand,
  mergeValidationCommands,
  readText,
  type BuildSystemDiscovery,
} from "./shared.ts";

function hasPythonDependencies(cwd: string, content: string): boolean {
  if (/\[(?:project|tool\.poetry)\]/.test(content) && /\bdependencies\b/.test(content)) return true;
  if (fileExists(cwd, "requirements.txt")) {
    const requirements = readText(cwd, "requirements.txt") ?? "";
    return requirements.split("\n").some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
  }
  return fileExists(cwd, "Pipfile");
}

function pythonRunner(cwd: string): { prefix: string[]; install: string[] | null } {
  if (fileExists(cwd, "uv.lock")) {
    return { prefix: ["uv", "run"], install: ["uv", "sync", "--frozen"] };
  }
  if (fileExists(cwd, "poetry.lock")) {
    return { prefix: ["poetry", "run"], install: ["poetry", "install", "--no-root"] };
  }
  if (fileExists(cwd, "Pipfile.lock")) {
    return { prefix: ["pipenv", "run"], install: ["pipenv", "install", "--deploy"] };
  }
  return { prefix: [], install: fileExists(cwd, "requirements.txt") ? ["pip", "install", "-r", "requirements.txt"] : null };
}

function hashLockedRequirements(cwd: string): boolean {
  const content = readText(cwd, "requirements.txt");
  if (content === null) return false;
  const entries = content.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("--"));
  return entries.length > 0 && entries.every((entry) =>
    /^[A-Za-z0-9_.-]+==[^\s]+\b/.test(entry)
    && /(?:^|\s)--hash=sha256:[a-f0-9]{64}(?:\s|$)/i.test(entry)
  );
}

/**
 * A project that configures mypy's `files` scope (pyproject `[tool.mypy]`, a
 * mypy ini, or setup.cfg) has deliberately chosen what gets type-checked.
 * Appending `.` on the command line would override that scope and pull in
 * trees the project intentionally leaves unchecked (for example untyped
 * tests), so the discovered command must run bare `mypy` there.
 */
function mypyHasConfiguredScope(cwd: string, pyprojectContent: string): boolean {
  const section = /\[tool\.mypy\]([\s\S]*?)(?=\n\[|\s*$)/.exec(pyprojectContent);
  if (section && /^\s*files\s*=/m.test(section[1] ?? "")) return true;
  if (fileExists(cwd, "mypy.ini") || fileExists(cwd, ".mypy.ini")) return true;
  const setupCfg = readText(cwd, "setup.cfg") ?? "";
  return /\[mypy\][\s\S]*?^\s*files\s*=/m.test(setupCfg);
}

const NETWORK_MODULE = /^(?:aiohttp|http\.client|httpx|requests|socket|urllib3|urllib\.request)(?:\.|$)/;

function headText(cwd: string, relativePath: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "show", `HEAD:./${relativePath}`], {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

function importedModules(source: string): string[] {
  const modules = new Set<string>();
  for (const match of source.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/gm)) {
    if (match[1]) modules.add(match[1]);
  }
  for (const match of source.matchAll(/^\s*import\s+([^#\n]+)/gm)) {
    for (const entry of (match[1] ?? "").split(",")) {
      const module = entry.trim().split(/\s+as\s+/)[0];
      if (module) modules.add(module);
    }
  }
  return [...modules];
}

function pythonTestUsesNetwork(
  cwd: string,
  sourcePath: string,
  trackedSources: ReadonlySet<string>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(sourcePath) || visited.size >= 128) return false;
  visited.add(sourcePath);
  const source = headText(cwd, sourcePath);
  if (source === null) return true;
  const imports = importedModules(source);
  if (imports.some((module) => NETWORK_MODULE.test(module))) return true;
  return imports.some((module) => {
    const modulePath = module.replaceAll(".", "/");
    const localPath = [`${modulePath}.py`, `${modulePath}/__init__.py`]
      .find((candidate) => trackedSources.has(candidate));
    return localPath !== undefined && pythonTestUsesNetwork(cwd, localPath, trackedSources, visited);
  });
}

function trackedPythonSources(cwd: string): string[] | null {
  const result = spawnSync(
    "git",
    ["-C", cwd, "ls-tree", "-r", "--name-only", "-z", "HEAD", "--"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) return null;
  return result.stdout.split("\0").filter((entry) => entry.endsWith(".py")).slice(0, 1_024);
}

function documentedOfflineUnittest(
  cwd: string,
  testPaths: readonly string[],
  trackedSources: ReadonlySet<string>,
): string | null {
  const candidates = new Set(testPaths);
  let individualFormDocumented = false;
  for (const readme of ["README.md", "README.rst", "README.txt"]) {
    const content = headText(cwd, readme);
    if (content === null) continue;
    for (const line of content.split(/\r?\n/)) {
      const match = /^(?:\$\s*)?(?:python|python3)\s+-m\s+unittest\s+(tests?\/test[^\s]*\.py)\s*$/.exec(line.trim());
      const testPath = match?.[1];
      if (testPath && candidates.has(testPath)) individualFormDocumented = true;
    }
  }
  if (!individualFormDocumented) return null;
  return [...testPaths].sort().find((testPath) => (
    !pythonTestUsesNetwork(cwd, testPath, trackedSources)
  )) ?? null;
}

function pythonToolCommands(cwd: string, runner: ReturnType<typeof pythonRunner>): InstallerCommand[] {
  const content = readText(cwd, "pyproject.toml") ?? "";
  const commands: InstallerCommand[] = [];
  const hasTests = fileExists(cwd, "tests") || fileExists(cwd, "test");
  const hasPytest = /\bpytest\b/.test(content);
  const hasRuff = /\bruff\b/.test(content);
  const hasMypy = /\bmypy\b/.test(content);
  if (hasPytest) {
    commands.push(makeCommand({
      kind: "test",
      label: "pytest",
      argv: [...runner.prefix, "pytest"],
      detail: "Python pytest validation discovered",
    }));
  } else if (hasTests) {
    const testDirectory = fileExists(cwd, "tests") ? "tests" : "test";
    const pythonSources = trackedPythonSources(cwd);
    const trackedSources = new Set(pythonSources ?? []);
    const trackedTests = pythonSources?.filter((entry) => (
      new RegExp(`^${testDirectory}/test[^/]*\\.py$`).test(entry)
    )) ?? null;
    const broadSuiteUsesNetwork = trackedTests !== null
      && trackedTests.some((testPath) => pythonTestUsesNetwork(cwd, testPath, trackedSources));
    const focusedTest = broadSuiteUsesNetwork
      ? documentedOfflineUnittest(cwd, trackedTests, trackedSources)
      : null;
    if (!broadSuiteUsesNetwork || focusedTest !== null) {
      commands.push(makeCommand({
        kind: "test",
        label: "unittest",
        argv: [...runner.prefix, "python", "-m", "unittest", ...(focusedTest === null
          ? ["discover", testDirectory]
          : [focusedTest])],
        detail: focusedTest === null
          ? "Python standard-library unittest discovery found tracked tests"
          : "README-documented offline Python unittest selected because broad discovery imports a network client",
      }));
    }
  }
  if (hasRuff) {
    commands.push(makeCommand({
      kind: "lint",
      label: "ruff",
      argv: [...runner.prefix, "ruff", "check", "."],
      detail: "Python ruff lint discovered",
    }));
  }
  if (hasMypy) {
    const scoped = mypyHasConfiguredScope(cwd, content);
    commands.push(makeCommand({
      kind: "typecheck",
      label: "mypy",
      argv: scoped ? [...runner.prefix, "mypy"] : [...runner.prefix, "mypy", "."],
      detail: scoped
        ? "Python mypy typecheck discovered; the project's configured file scope is respected"
        : "Python mypy typecheck discovered",
    }));
  }
  return commands;
}

export function discoverPythonBuildSystem(cwd: string): BuildSystemDiscovery | null {
  const manifest = fileExists(cwd, "pyproject.toml")
    ? "pyproject.toml"
    : fileExists(cwd, "setup.py")
      ? "setup.py"
      : fileExists(cwd, "requirements.txt")
        ? "requirements.txt"
        : null;
  if (!manifest) return null;
  const content = readText(cwd, manifest) ?? "";
  const runner = pythonRunner(cwd);
  const commands: InstallerCommand[] = [];
  if (runner.install) {
    commands.push(makeCommand({
      kind: "install",
      label: "install",
      argv: runner.install,
      required: false,
      detail: "deterministic Python dependency install discovered",
    }));
  }
  commands.push(...pythonToolCommands(cwd, runner));
  commands.push(...makefileCommands(cwd));
  const lockfile = ["uv.lock", "poetry.lock", "Pipfile.lock"]
    .map((name) => (fileExists(cwd, name) ? { path: name } : null))
    .find((entry) => entry !== null)
    ?? (hashLockedRequirements(cwd) ? { path: "requirements.txt" } : null);
  return {
    manifest: { path: manifest, ecosystem: "python" },
    commands: mergeValidationCommands(commands),
    lockfile,
    requiresLockfile: hasPythonDependencies(cwd, content),
  };
}
