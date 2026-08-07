import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { storeLockRelativePath, teamMemoryRoot } from "../paths.ts";
import { TeamMemoryError, type MemoryStoreOptions } from "../contracts.ts";
import {
  DEFAULT_STALE_LOCK_MS,
  assertSafeFileDestination,
  errorCode,
  fsyncDirectory,
  isRecord,
} from "./files.ts";
import { assertRootEntriesSafe } from "./initialization.ts";

interface StoreLockRecord {
  token: string;
  pid: number;
  hostname: string;
  acquired_at: string;
}

function readStoreLockRecord(lockPath: string): StoreLockRecord | null {
  try {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4_096) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.token !== "string"
      || typeof parsed.pid !== "number"
      || typeof parsed.hostname !== "string"
      || typeof parsed.acquired_at !== "string"
    ) return null;
    return {
      token: parsed.token,
      pid: parsed.pid,
      hostname: parsed.hostname,
      acquired_at: parsed.acquired_at,
    };
  } catch {
    return null;
  }
}

function processAppearsAlive(record: StoreLockRecord): boolean {
  if (record.hostname !== os.hostname() || !Number.isSafeInteger(record.pid) || record.pid < 1) {
    return false;
  }
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    return code === "EPERM";
  }
}

export function acquireStoreLock<T>(
  cwd: string,
  options: MemoryStoreOptions | undefined,
  work: () => T,
): T {
  assertRootEntriesSafe(cwd);
  const rootPath = teamMemoryRoot(cwd);
  const runtimePath = path.join(rootPath, "runtime");
  const locksPath = path.join(runtimePath, "locks");
  const rootExisted = fs.existsSync(rootPath);
  const runtimeExisted = fs.existsSync(runtimePath);
  const locksExisted = fs.existsSync(locksPath);
  const relativeLock = storeLockRelativePath();
  const lockPath = assertSafeFileDestination(cwd, relativeLock);
  const staleAfter = options?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const now = (options?.now ?? (() => new Date()))().getTime();
  const token = crypto.randomUUID();
  const record: StoreLockRecord = {
    token,
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: new Date(now).toISOString(),
  };

  const tryOpen = (): number => fs.openSync(lockPath, "wx", 0o600);
  let descriptor: number;
  let staleQuarantine: string | null = null;
  try {
    descriptor = tryOpen();
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw new TeamMemoryError("lock_conflict", "cannot acquire team memory store lock", { cause: error });
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(lockPath);
    } catch (statError) {
      throw new TeamMemoryError("lock_conflict", "cannot inspect team memory store lock", { cause: statError });
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TeamMemoryError("unsafe_path", "team memory store lock is not a regular file");
    }
    const existingRecord = readStoreLockRecord(lockPath);
    if (
      now - stat.mtimeMs <= staleAfter
      || (existingRecord !== null && processAppearsAlive(existingRecord))
    ) {
      throw new TeamMemoryError("lock_conflict", "team memory store is already being updated");
    }
    staleQuarantine = `${lockPath}.stale-${process.pid}-${token}`;
    try {
      fs.renameSync(lockPath, staleQuarantine);
      descriptor = tryOpen();
    } catch (retryError) {
      try {
        if (fs.existsSync(staleQuarantine) && !fs.existsSync(lockPath)) {
          fs.renameSync(staleQuarantine, lockPath);
        }
      } catch {
        // The next invocation will fail closed on whichever lock remains.
      }
      throw new TeamMemoryError(
        "lock_conflict",
        "stale team memory store lock could not be recovered",
        { cause: retryError },
      );
    }
  }

  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf-8");
    fs.fsyncSync(descriptor);
    return work();
  } finally {
    fs.closeSync(descriptor);
    try {
      const current = readStoreLockRecord(lockPath);
      if (current?.token === token) {
        fs.unlinkSync(lockPath);
        fsyncDirectory(path.dirname(lockPath));
      }
    } catch {
      // A later invocation can inspect and recover the retained lock safely.
    }
    if (staleQuarantine !== null) {
      try {
        fs.unlinkSync(staleQuarantine);
      } catch {
        // Best-effort cleanup of the stale lock copy.
      }
    }
    for (const [directory, existed] of [
      [locksPath, locksExisted],
      [runtimePath, runtimeExisted],
      [rootPath, rootExisted],
    ] as const) {
      if (existed) continue;
      try {
        fs.rmdirSync(directory);
      } catch {
        // Keep non-empty or concurrently repopulated operational directories.
      }
    }
  }
}
