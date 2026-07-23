// Conservative local file lock for one repository / engagement / issue tuple.
// This is host-local coordination, not distributed locking.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LockFileContents {
  schemaVersion: "1";
  pid: number;
  host: string;
  processStartIdentity: string | null;
  nonce: string;
  startedAt: string;
  repo: string;
  engagementId: string;
  issueNumber: number;
  localRunId: string;
}

export interface AcquiredLock { lockPath: string; release: () => void }

function processStartIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.split(" ")[21] ?? null;
  } catch { return null; }
}

function lockContents(input: Omit<LockFileContents, "schemaVersion" | "pid" | "host" | "processStartIdentity" | "nonce" | "startedAt">): LockFileContents {
  return {
    schemaVersion: "1",
    pid: process.pid,
    host: os.hostname(),
    processStartIdentity: processStartIdentity(process.pid),
    nonce: randomUUID(),
    startedAt: new Date().toISOString(),
    ...input,
  };
}

function assertRegularLock(filePath: string): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("lock path is not a regular file");
}

export function lockPathFor(workspaceRoot: string, repo: string, engagementId: string, issueNumber: number): string {
  const safe = `${repo.replace(/[^A-Za-z0-9_.-]+/g, "_")}__${engagementId.replace(/[^A-Za-z0-9_.-]+/g, "_")}__${issueNumber}.lock`;
  return path.join(workspaceRoot, "locks", safe);
}

export function acquireLock(
  workspaceRoot: string,
  input: { repo: string; engagementId: string; issueNumber: number; localRunId: string },
): AcquiredLock {
  const dir = path.join(workspaceRoot, "locks");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("lock directory cannot be a symlink");
  const lockPath = lockPathFor(workspaceRoot, input.repo, input.engagementId, input.issueNumber);
  const contents = lockContents(input);
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    try { fs.writeSync(fd, JSON.stringify(contents, null, 2)); }
    finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readLock(lockPath);
    throw new Error(`another local shadow run holds this repository/engagement/issue lock (pid=${existing?.pid ?? "?"} started=${existing?.startedAt ?? "?"}); inspect with status-local`);
  }
  return {
    lockPath,
    release: () => {
      try {
        const current = readLock(lockPath);
        if (current?.nonce === contents.nonce) fs.unlinkSync(lockPath);
      } catch { /* best-effort cleanup without removing a replacement lock */ }
    },
  };
}

export function readLock(lockPath: string): LockFileContents | null {
  try {
    assertRegularLock(lockPath);
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockFileContents>;
    if (parsed.schemaVersion !== "1" || !Number.isInteger(parsed.pid) || typeof parsed.host !== "string"
      || typeof parsed.nonce !== "string" || typeof parsed.startedAt !== "string"
      || typeof parsed.repo !== "string" || typeof parsed.engagementId !== "string"
      || !Number.isInteger(parsed.issueNumber) || typeof parsed.localRunId !== "string") {
      throw new Error("lock file is corrupt or uses an unsupported schema");
    }
    return parsed as LockFileContents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Explicit recovery helper. Unknown, foreign-host, or PID-reused locks are kept. */
export function removeIfStale(lockPath: string): { removed: boolean; reason: string } {
  const existing = readLock(lockPath);
  if (!existing) return { removed: false, reason: "lock is absent" };
  if (existing.host !== os.hostname()) return { removed: false, reason: "lock belongs to another host; manual inspection required" };
  const currentStart = processStartIdentity(existing.pid);
  if (currentStart !== null && existing.processStartIdentity !== null && currentStart === existing.processStartIdentity) {
    return { removed: false, reason: `pid ${existing.pid} is still alive with the recorded process identity` };
  }
  if (currentStart !== null && existing.processStartIdentity === null) {
    return { removed: false, reason: `pid ${existing.pid} exists but lock lacks process-start identity` };
  }
  assertRegularLock(lockPath);
  fs.unlinkSync(lockPath);
  return { removed: true, reason: "recorded process identity is no longer active; lock removed" };
}
