import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";

const MANAGED_INSTALLATION_PATHS = [
  ".agentify",
  ".github/agentify",
  ".github/agentify-task-policy.json",
  ".github/scripts/complete-accepted-task-merge.mjs",
  ".github/scripts/publish-task-draft.mjs",
  ".github/scripts/run-task-lifecycle.mjs",
  ".github/scripts/task-state-github.mjs",
  ".github/workflows/agentify-issue.yml",
  ".github/workflows/agentify-learn.yml",
  "AGENTS.md",
  "SETUP.md",
] as const;

interface SnapshotEntry {
  relativePath: string;
  kind: "file" | "directory" | "symlink";
  linkTarget: string | null;
}

interface PendingInstallation {
  cwd: string;
  snapshotRoot: string;
  entries: SnapshotEntry[];
  freshAgentifyRoot: boolean;
}

const pendingInstallations = new Map<string, PendingInstallation>();

function normalizedRoot(cwd: string): string {
  return path.resolve(cwd);
}

function snapshotDestination(snapshotRoot: string, relativePath: string): string {
  return path.join(snapshotRoot, "snapshot", ...relativePath.split("/"));
}

function copyIntoSnapshot(
  source: string,
  destination: string,
  stat: fs.Stats,
): SnapshotEntry["kind"] {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  if (stat.isDirectory()) {
    fs.cpSync(source, destination, {
      recursive: true,
      preserveTimestamps: true,
    });
    return "directory";
  }
  if (!stat.isFile()) {
    throw new Error(`unsupported Agentify installation path type: ${source}`);
  }
  fs.copyFileSync(source, destination);
  return "file";
}

function removeSnapshot(snapshotRoot: string): void {
  fs.rmSync(snapshotRoot, { recursive: true, force: true });
}

function cleanStalePending(cwd: string): void {
  const current = pendingInstallations.get(cwd);
  if (current === undefined) return;
  if (fs.existsSync(cwd)) return;
  removeSnapshot(current.snapshotRoot);
  pendingInstallations.delete(cwd);
}

/**
 * Capture every repository path Agentify may mutate during installation.
 * Repeated calls in one CLI process share the same transaction.
 */
export function beginPendingInstallation(cwd: string): void {
  const root = normalizedRoot(cwd);
  cleanStalePending(root);
  if (pendingInstallations.has(root)) return;

  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-install-transaction-"));
  const entries: SnapshotEntry[] = [];
  try {
    for (const relativePath of MANAGED_INSTALLATION_PATHS) {
      const source = path.join(root, ...relativePath.split("/"));
      if (!fs.existsSync(source)) continue;
      const stat = fs.lstatSync(source);
      const destination = snapshotDestination(snapshotRoot, relativePath);
      const kind = copyIntoSnapshot(source, destination, stat);
      entries.push({
        relativePath,
        kind,
        linkTarget: kind === "symlink" ? fs.readlinkSync(source) : null,
      });
    }
    pendingInstallations.set(root, {
      cwd: root,
      snapshotRoot,
      entries,
      freshAgentifyRoot: !fs.existsSync(path.join(root, ".agentify")),
    });
  } catch (error) {
    removeSnapshot(snapshotRoot);
    throw error;
  }
}

function restoreEntry(pending: PendingInstallation, entry: SnapshotEntry): void {
  const destination = path.join(pending.cwd, ...entry.relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (entry.kind === "symlink") {
    if (entry.linkTarget === null) {
      throw new Error(`missing symlink target for ${entry.relativePath}`);
    }
    fs.symlinkSync(entry.linkTarget, destination);
    return;
  }
  const source = snapshotDestination(pending.snapshotRoot, entry.relativePath);
  if (entry.kind === "directory") {
    fs.cpSync(source, destination, {
      recursive: true,
      preserveTimestamps: true,
    });
  } else {
    fs.copyFileSync(source, destination);
  }
}

/**
 * Restore the repository to its exact pre-installation state. A fresh failed
 * audit retains only its canonical diagnostic map; no identities, policies,
 * procedures, workflows, or manifest survive.
 */
export function rollbackPendingInstallation(cwd: string): boolean {
  const root = normalizedRoot(cwd);
  const pending = pendingInstallations.get(root);
  if (pending === undefined) return false;

  const diagnosticMapPath = path.join(
    root,
    ...`${AUDIT_STATE_RELATIVE_DIR}/codebase_map.json`.split("/"),
  );
  const diagnosticMap = pending.freshAgentifyRoot && fs.existsSync(diagnosticMapPath)
    ? fs.readFileSync(diagnosticMapPath)
    : null;

  try {
    for (const relativePath of MANAGED_INSTALLATION_PATHS) {
      fs.rmSync(path.join(root, ...relativePath.split("/")), {
        recursive: true,
        force: true,
      });
    }
    for (const entry of pending.entries) restoreEntry(pending, entry);
    if (diagnosticMap !== null) {
      fs.mkdirSync(path.dirname(diagnosticMapPath), { recursive: true });
      fs.writeFileSync(diagnosticMapPath, diagnosticMap);
    }
    return true;
  } finally {
    removeSnapshot(pending.snapshotRoot);
    pendingInstallations.delete(root);
  }
}

/** Commit the repository-side installation transaction. */
export function commitPendingInstallation(cwd: string): boolean {
  const root = normalizedRoot(cwd);
  const pending = pendingInstallations.get(root);
  if (pending === undefined) return false;
  removeSnapshot(pending.snapshotRoot);
  pendingInstallations.delete(root);
  return true;
}

export function pendingInstallationActive(cwd: string): boolean {
  return pendingInstallations.has(normalizedRoot(cwd));
}

process.once("exit", () => {
  for (const pending of pendingInstallations.values()) {
    removeSnapshot(pending.snapshotRoot);
  }
  pendingInstallations.clear();
});
