import * as fs from "node:fs";
import * as path from "node:path";
import type { InstallerCommand, InstallerCommandKind } from "../contracts.ts";
import { fileExists, makeCommand, readText, type BuildManifest, type BuildSystemDiscovery } from "./shared.ts";

const SHELL_INTERPRETERS = /\b(?:sh|bash|dash|zsh|ksh|csh|tcsh|fish)\b/;
const SHELL_FILE_EXTENSIONS = /\.(?:sh|bash|zsh|ksh)$/i;

const SHELL_INSTALL_PATTERN = /^(?:get|install|setup|deps|bootstrap|init)(?:[-_.]|$)/i;
const SHELL_BUILD_PATTERN = /^(?:build|compile|make)(?:[-_.]|$)/i;
const SHELL_TEST_PATTERN = /^(?:test|tests|run[-_]tests|check)(?:[-_.]|$)/i;
const SHELL_LINT_PATTERN = /^(?:lint|format|style)(?:[-_.]|$)/i;
const SHELL_TYPECHECK_PATTERN = /^(?:typecheck|type[-_]check)(?:[-_.]|$)/i;

const NETWORK_OPERATION = /\b(?:git\s+(?:clone|pull|fetch)|curl|wget|scp|sftp|ftp|tftp)\b/i;
const PACKAGE_INSTALL = /\b(?:npm\s+install\s+-g|pip\s+install|pip3\s+install|pipenv\s+install|poetry\s+install|conda\s+install|gem\s+install|bundle\s+install|go\s+get|go\s+install|cargo\s+install|apt\s+install|apt-get\s+install|yum\s+install|dnf\s+install|brew\s+install)\b/i;
const DEPLOYMENT_OPERATION = /\b(?:deploy|publish|release|docker\s+push|kubectl\s+apply|terraform\s+apply|aws\s+|gcloud\s+|az\s+)\b/i;
const DESTRUCTIVE_OPERATION = /\brm\s+-rf\s+(?:\/|~)\b/i;
const PRODUCTION_CREDENTIAL = /\b(?:PROD(?:UCTION)?_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|DATABASE_URL|STRIPE_SECRET_KEY|AWS_SECRET_ACCESS_KEY)\b/;

interface ShellScriptClassification {
  name: string;
  kind: InstallerCommandKind;
  required: boolean;
  unsafeReason: string | null;
}

function isShellShebang(firstLine: string): boolean {
  if (!firstLine.startsWith("#!")) return false;
  return SHELL_INTERPRETERS.test(firstLine);
}

function isShellScript(cwd: string, name: string): boolean {
  if (!fileExists(cwd, name)) return false;
  const absolute = path.join(cwd, name);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  if (SHELL_FILE_EXTENSIONS.test(name)) return true;
  const content = readText(cwd, name);
  if (!content) return false;
  const firstLine = content.split(/\r?\n/)[0] ?? "";
  if (isShellShebang(firstLine)) return true;
  // An executable file with a non-shell shebang or no shebang is intentionally
  // not treated as a shell script; it may be a compiled entry point or another
  // ecosystem's script already covered by a standard manifest.
  return false;
}

function scriptArgv(cwd: string, name: string): string[] | null {
  const absolute = path.join(cwd, name);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    return null;
  }
  if (SHELL_FILE_EXTENSIONS.test(name)) {
    return ["bash", name];
  }
  if ((stats.mode & 0o111) !== 0) {
    return process.platform === "win32" ? ["bash", name] : [`./${name}`];
  }
  return null;
}

function classifyShellScript(name: string, content: string): ShellScriptClassification | null {
  const stem = path.basename(name, path.extname(name));
  const baseName = name;
  let kind: InstallerCommandKind | null = null;
  let required = false;

  if (SHELL_INSTALL_PATTERN.test(baseName) || SHELL_INSTALL_PATTERN.test(stem)) {
    kind = "install";
    required = false;
  } else if (SHELL_TEST_PATTERN.test(baseName) || SHELL_TEST_PATTERN.test(stem)) {
    kind = "test";
    required = true;
  } else if (SHELL_LINT_PATTERN.test(baseName) || SHELL_LINT_PATTERN.test(stem)) {
    kind = "lint";
    required = true;
  } else if (SHELL_TYPECHECK_PATTERN.test(baseName) || SHELL_TYPECHECK_PATTERN.test(stem)) {
    kind = "typecheck";
    required = true;
  } else if (SHELL_BUILD_PATTERN.test(baseName) || SHELL_BUILD_PATTERN.test(stem)) {
    kind = "build";
    required = true;
  } else {
    return null;
  }

  const unsafeReason = shellContentUnsafeReason(content, kind);
  return { name, kind, required, unsafeReason };
}

function shellContentUnsafeReason(content: string, kind: InstallerCommandKind): string | null {
  if (kind === "install") return null; // Install scripts are expected to fetch dependencies.
  if (NETWORK_OPERATION.test(content)) {
    return "script accesses the network during build/test";
  }
  if (PACKAGE_INSTALL.test(content)) {
    return "script installs packages during build/test";
  }
  if (DEPLOYMENT_OPERATION.test(content)) {
    return "script includes a deployment, publication, release, or infrastructure mutation";
  }
  if (DESTRUCTIVE_OPERATION.test(content)) {
    return "script includes a destructive operation";
  }
  if (PRODUCTION_CREDENTIAL.test(content)) {
    return "script references a production credential or service endpoint";
  }
  return null;
}

function manifestFromCommands(commands: InstallerCommand[]): BuildManifest {
  const primary = commands.find((command) => command.kind !== "install") ?? commands[0];
  if (!primary) throw new Error("shell build system produced no commands");
  // argv is either ["bash", name] or ["./name"]; the script path is the last element.
  const manifestPath = primary.argv[primary.argv.length - 1];
  if (!manifestPath) throw new Error("shell build command has no manifest path");
  return { path: manifestPath, ecosystem: "shell" };
}

export function discoverShellBuildSystem(cwd: string): BuildSystemDiscovery | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(cwd);
  } catch {
    return null;
  }

  const candidates = entries
    .filter((name) => isShellScript(cwd, name))
    .sort((a, b) => a.localeCompare(b));

  const commands: InstallerCommand[] = [];
  for (const name of candidates) {
    const content = readText(cwd, name) ?? "";
    const classification = classifyShellScript(name, content);
    if (!classification) continue;
    const argv = scriptArgv(cwd, name);
    if (!argv) continue;
    const baseCommand = makeCommand({
      kind: classification.kind,
      label: name,
      argv,
      required: classification.required,
      detail: classification.unsafeReason ?? "shell script validation discovered",
    });
    if (classification.unsafeReason) {
      commands.push({
        ...baseCommand,
        assessment: "unsafe",
        detail: classification.unsafeReason,
      });
    } else {
      commands.push(baseCommand);
    }
  }

  if (commands.length === 0) return null;

  return {
    manifest: manifestFromCommands(commands),
    commands,
    lockfile: null,
    requiresLockfile: false,
  };
}
