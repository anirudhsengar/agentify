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

function pythonToolCommands(cwd: string, runner: ReturnType<typeof pythonRunner>): InstallerCommand[] {
  const content = readText(cwd, "pyproject.toml") ?? "";
  const commands: InstallerCommand[] = [];
  const hasPytest = /\bpytest\b/.test(content) || fileExists(cwd, "tests") || fileExists(cwd, "test");
  const hasRuff = /\bruff\b/.test(content);
  const hasMypy = /\bmypy\b/.test(content);
  if (hasPytest) {
    commands.push(makeCommand({
      kind: "test",
      label: "pytest",
      argv: [...runner.prefix, "pytest"],
      detail: "Python pytest validation discovered",
    }));
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
    commands.push(makeCommand({
      kind: "typecheck",
      label: "mypy",
      argv: [...runner.prefix, "mypy", "."],
      detail: "Python mypy typecheck discovered",
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
    .find((entry) => entry !== null) ?? null;
  return {
    manifest: { path: manifest, ecosystem: "python" },
    commands: mergeValidationCommands(commands),
    lockfile,
    requiresLockfile: hasPythonDependencies(cwd, content),
  };
}
