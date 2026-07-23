// Local file-lock with exclusive creation. Used to serialize concurrent
// local shadow runs against the same repository / engagement / issue tuple.
// Stale locks are NOT removed silently — the inspect helper exposes them so
// the operator can decide whether the prior process is still alive.

import * as fs from "node:fs";
import * as path from "node:path";

export interface LockFileContents {
  pid: number;
  host: string;
  startedAt: string;
  repo: string;
  engagementId: string;
  issueNumber: number;
  localRunId: string;
}

export interface AcquiredLock {
  lockPath: string;
  release: () => void;
}

function safeHostname(): string {
  try { return require("node:os").hostname(); } catch { return "unknown-host"; }
}

function lockContents(input: Omit<LockFileContents, "pid" | "host" | "startedAt">): LockFileContents {
  return {
    pid: process.pid,
    host: safeHostname(),
    startedAt: new Date().toISOString(),
    ...input,
  };
}

function writeExclusive(filePath: string, contents: string): void {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
}

export function lockPathFor(workspaceRoot: string, repo: string, engagementId: string, issueNumber: number): string {
  const safe = `${repo.replace(/[^A-Za-z0-9_.-]+/g, "_")}__${engagementId.replace(/[^A-Za-z0-9_.-]+/g, "_")}__${issueNumber}.lock`;
  return path.join(workspaceRoot, "locks", safe);
}

/**
 * Acquire an exclusive lock. Throws with a clear actionable error when the
 * lock is already held; never silently removes a foreign lock.
 */
export function acquireLock(
  workspaceRoot: string,
  input: { repo: string; engagementId: string; issueNumber: number; localRunId: string },
): AcquiredLock {
  const dir = path.join(workspaceRoot, "locks");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = lockPathFor(workspaceRoot, input.repo, input.engagementId, input.issueNumber);
  const payload = JSON.stringify(lockContents({ repo: input.repo, engagementId: input.engagementId, issueNumber: input.issueNumber, localRunId: input.localRunId }), null, 2);
  let acquired = false;
  try {
    writeExclusive(lockPath, payload);
    acquired = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!acquired) {
    const existing = readLock(lockPath);
    throw new Error(
      `another local shadow run holds ${lockPath} (pid=${existing?.pid ?? "?"} started=${existing?.startedAt ?? "?"}); wait for it to complete or inspect with status-local`,
    );
  }
  return {
    lockPath,
    release: () => {
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    },
  };
}

/** Read an existing lock without removing it. Returns null when absent. */
export function readLock(lockPath: string): LockFileContents | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as LockFileContents;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Remove a lock only when the recorded pid is no longer running. Returns a
 * structured outcome so callers can require explicit operator intent before
 * removing a lock that looks live.
 */
export function removeIfStale(lockPath: string): { removed: boolean; reason: string } {
  const existing = readLock(lockPath);
  if (!existing) return { removed: false, reason: "lock is absent" };
  if (isPidAlive(existing.pid)) return { removed: false, reason: `pid ${existing.pid} is still alive on ${existing.host}` };
  fs.unlinkSync(lockPath);
  return { removed: true, reason: `pid ${existing.pid} no longer running; lock removed` };
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM means the process exists but we cannot signal it — treat as alive.
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}