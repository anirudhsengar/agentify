// queue.ts — JSONL append log with claim-fence for the webhook subsystem.
//
// The queue is an append-only file of JSON Lines:
//   ~/.agentify/queue/tasks.jsonl
// Each line is a WebhookTaskRecord snapshot. The current "live" status
// of a task is the LAST entry for its task_id in the file (write-once
// per transition).
//
// Concurrency model: a worker claims a task by writing a sidecar file
//   ~/.agentify/queue/<task_id>.claim
// atomically (write-temp-then-rename). If the sidecar already exists,
// the task is already claimed by another worker. This is a simple
// advisory lock; v1 assumes a single server process and the worker
// lives in the same process, so collisions should be rare. v1.1 may
// upgrade to SQLite WAL when multi-process workers are wanted.
//
// Recovery: on worker start, we re-scan the file and rebuild an
// in-memory map of task_id -> latest record. Any task whose latest
// status is "claimed" or "running" with a stale claim sidecar is
// reset to "queued" by appending a new record (crash recovery).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  generateTaskId,
  TaskStatus,
  type WebhookTaskRecord,
} from "./state.ts";

export interface QueuePaths {
  queueDir: string;
  queueFile: string;
  tasksRoot: string;
}

export function queuePaths(configDir: string): QueuePaths {
  const queueDir = path.join(configDir, "queue");
  const queueFile = path.join(queueDir, "tasks.jsonl");
  const tasksRoot = path.join(configDir, "tasks");
  return { queueDir, queueFile, tasksRoot };
}

export function ensureQueueDirs(paths: QueuePaths): void {
  fs.mkdirSync(paths.queueDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.tasksRoot, { recursive: true, mode: 0o700 });
  // Touch the file if missing so the first append doesn't race.
  if (!fs.existsSync(paths.queueFile)) {
    fs.writeFileSync(paths.queueFile, "", { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------
// Append a record (transition)
// ---------------------------------------------------------------------------

export function appendRecord(
  paths: QueuePaths,
  record: WebhookTaskRecord,
): void {
  ensureQueueDirs(paths);
  const line = JSON.stringify(record) + "\n";
  // Append atomically with O_APPEND; the file was created 0600.
  const fd = fs.openSync(paths.queueFile, "a");
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Build / update helpers
// ---------------------------------------------------------------------------

export function makeQueuedRecord(params: {
  triggerId: string;
  http: WebhookTaskRecord["http"];
  prompt: WebhookTaskRecord["prompt"];
  taskId?: string;
  receivedAt?: string;
}): WebhookTaskRecord {
  return {
    task_id: params.taskId ?? generateTaskId(),
    trigger_id: params.triggerId,
    status: TaskStatus.Queued,
    received_at: params.receivedAt ?? new Date().toISOString(),
    http: params.http,
    prompt: params.prompt,
  };
}

export function transitionRecord(
  record: WebhookTaskRecord,
  status: typeof TaskStatus[keyof typeof TaskStatus],
  result?: WebhookTaskRecord["result"],
  timestamp: string = new Date().toISOString(),
): WebhookTaskRecord {
  const updated: WebhookTaskRecord = {
    ...record,
    status,
  };
  if (status === TaskStatus.Claimed) updated.claimed_at = timestamp;
  if (status === TaskStatus.Running) updated.started_at = timestamp;
  if (status === TaskStatus.Done || status === TaskStatus.Error || status === TaskStatus.Aborted) {
    updated.ended_at = timestamp;
  }
  if (result) updated.result = result;
  return updated;
}

// ---------------------------------------------------------------------------
// Read API — rebuild state by streaming the log
// ---------------------------------------------------------------------------

export interface QueueState {
  byId: Map<string, WebhookTaskRecord>;
  pending: WebhookTaskRecord[];
  inFlight: WebhookTaskRecord[];
  terminal: WebhookTaskRecord[];
}

const TERMINAL_STATUSES = new Set<string>([
  TaskStatus.Done,
  TaskStatus.Error,
  TaskStatus.Aborted,
  TaskStatus.Rejected,
]);

export function rebuildQueue(paths: QueuePaths): QueueState {
  ensureQueueDirs(paths);
  const byId = new Map<string, WebhookTaskRecord>();
  if (!fs.existsSync(paths.queueFile)) {
    return emptyQueueState(byId);
  }
  const raw = fs.readFileSync(paths.queueFile, "utf-8");
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: WebhookTaskRecord;
    try {
      parsed = JSON.parse(trimmed) as WebhookTaskRecord;
    } catch {
      // Skip malformed lines; do not throw — a partial write must not
      // brick the queue.
      continue;
    }
    byId.set(parsed.task_id, parsed);
  }
  return partition(byId);
}

function emptyQueueState(byId: Map<string, WebhookTaskRecord>): QueueState {
  return { byId, pending: [], inFlight: [], terminal: [] };
}

function partition(byId: Map<string, WebhookTaskRecord>): QueueState {
  const pending: WebhookTaskRecord[] = [];
  const inFlight: WebhookTaskRecord[] = [];
  const terminal: WebhookTaskRecord[] = [];
  for (const record of byId.values()) {
    if (TERMINAL_STATUSES.has(record.status)) {
      terminal.push(record);
    } else if (record.status === TaskStatus.Queued) {
      pending.push(record);
    } else {
      inFlight.push(record);
    }
  }
  // Stable ordering: pending by received_at asc, terminal by ended_at desc.
  pending.sort((a, b) => a.received_at.localeCompare(b.received_at));
  terminal.sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));
  inFlight.sort((a, b) => (a.claimed_at ?? a.received_at).localeCompare(b.claimed_at ?? b.received_at));
  return { byId, pending, inFlight, terminal };
}

// ---------------------------------------------------------------------------
// Claim fence
// ---------------------------------------------------------------------------

export interface ClaimHandle {
  taskId: string;
  pid: number;
  claimedAt: string;
  path: string;
}

const STALE_CLAIM_MS = 10 * 60 * 1000; // 10 min — long enough to recover from a transient pause

function claimPath(paths: QueuePaths, taskId: string): string {
  return path.join(paths.queueDir, `${taskId}.claim`);
}

/**
 * Try to claim a task. Returns the claim handle on success, or null
 * if another worker already holds the claim. The handle records the
 * claimer's pid + timestamp so stale claims can be reaped.
 *
 * Important: re-claiming our own (same pid) live claim returns null,
 * not the existing handle. This prevents accidental double-dispatch
 * if a tick fires before runTask has finished releasing the previous
 * claim. Idempotent re-claim by the same pid is a footgun.
 */
export function tryClaim(paths: QueuePaths, taskId: string, pid: number): ClaimHandle | null {
  ensureQueueDirs(paths);
  const finalPath = claimPath(paths, taskId);
  if (fs.existsSync(finalPath)) {
    const existing = readClaim(finalPath);
    if (existing && !isStale(existing.claimedAt) && existing.pid !== pid) {
      return null;
    }
    if (existing && existing.pid === pid && !isStale(existing.claimedAt)) {
      // Our own live claim; refuse to re-claim. The original owner
      // must release before another claim can succeed.
      return null;
    }
    // Stale claim (from any pid); unlink so the new claim is clean.
    try {
      fs.unlinkSync(finalPath);
    } catch {
      // ignore
    }
  }
  const handle: ClaimHandle = {
    taskId,
    pid,
    claimedAt: new Date().toISOString(),
    path: finalPath,
  };
  // Atomic write: temp file in same dir, then rename.
  const tmp = `${finalPath}.${pid}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(handle), { mode: 0o600 });
  try {
    fs.renameSync(tmp, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return null;
  }
  return handle;
}

export function releaseClaim(_paths: QueuePaths, handle: ClaimHandle): void {
  try {
    if (fs.existsSync(handle.path)) {
      const existing = readClaim(handle.path);
      if (existing && existing.pid === handle.pid) {
        fs.unlinkSync(handle.path);
      }
    }
  } catch {
    // Best effort.
  }
}

function readClaim(p: string): ClaimHandle | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ClaimHandle;
  } catch {
    return null;
  }
}

function isStale(claimedAt: string): boolean {
  const t = Date.parse(claimedAt);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > STALE_CLAIM_MS;
}

/**
 * On worker boot (or periodically), scan in-flight records (status =
 * claimed or running) whose claim file is missing or stale. Reset them
 * to "queued" by appending a transition record so the worker
 * re-picks them up.
 *
 * Note: a live claim owned by the same pid is NOT stale — it means
 * the current worker still owns the task. We must leave it alone.
 */
export function recoverStaleClaims(
  paths: QueuePaths,
  state: QueueState,
  pid: number,
): WebhookTaskRecord[] {
  const recovered: WebhookTaskRecord[] = [];
  for (const record of state.inFlight) {
    const claim = claimPath(paths, record.task_id);
    let needsReset = false;
    if (!fs.existsSync(claim)) {
      needsReset = true;
    } else {
      const handle = readClaim(claim);
      if (!handle) {
        // Garbled claim file; treat as stale.
        try { fs.unlinkSync(claim); } catch { /* ignore */ }
        needsReset = true;
      } else if (handle.pid === pid) {
        // Our own live claim — do NOT reset. This is the active run.
        continue;
      } else if (isStale(handle.claimedAt)) {
        // Different pid, but stale — reap.
        try { fs.unlinkSync(claim); } catch { /* ignore */ }
        needsReset = true;
      }
      // else: another live worker owns this task; leave it alone.
    }
    if (needsReset) {
      const reset = transitionRecord(record, TaskStatus.Queued);
      appendRecord(paths, reset);
      recovered.push(reset);
    }
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// Task state directory helpers
// ---------------------------------------------------------------------------

export function taskStateDir(paths: QueuePaths, taskId: string): string {
  return path.join(paths.tasksRoot, taskId);
}

export function taskStateFile(paths: QueuePaths, taskId: string): string {
  return path.join(taskStateDir(paths, taskId), "state.json");
}

export function writeTaskState(
  paths: QueuePaths,
  taskId: string,
  record: WebhookTaskRecord,
): void {
  const dir = taskStateDir(paths, taskId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const finalPath = taskStateFile(paths, taskId);
  const tmp = `${finalPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, finalPath);
}

export function readTaskState(
  paths: QueuePaths,
  taskId: string,
): WebhookTaskRecord | null {
  const finalPath = taskStateFile(paths, taskId);
  if (!fs.existsSync(finalPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(finalPath, "utf-8")) as WebhookTaskRecord;
  } catch {
    return null;
  }
}