// tests/webhook/queue.test.ts — JSONL queue + claim fence unit tests.
//
// Covers:
//   - appendRecord adds lines atomically with O_APPEND
//   - rebuildQueue partitions into pending/in-flight/terminal
//   - transitions: queued -> claimed -> running -> done
//   - tryClaim returns null when another worker holds the claim
//   - releaseClaim removes the sidecar
//   - recoverStaleClaims resets orphaned in-flight tasks
//   - malformed lines are skipped, not thrown
//   - writeTaskState / readTaskState round-trip
//   - file is created with 0600 mode

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendRecord,
  ensureQueueDirs,
  makeQueuedRecord,
  queuePaths,
  readTaskState,
  rebuildQueue,
  recoverStaleClaims,
  releaseClaim,
  transitionRecord,
  tryClaim,
  writeTaskState,
} from "../../src/core/webhook/queue.ts";
import { TaskStatus, type WebhookTaskRecord } from "../../src/core/webhook/state.ts";

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-webhook-queue-"));
}

function tempHttp() {
  return {
    method: "POST",
    path: "/webhooks/test",
    remote_addr: "127.0.0.1",
    user_agent: "curl/8.0",
    content_type: "application/json",
    body_size: 13,
  };
}

function tempPrompt() {
  return {
    template: "/implement",
    args: { body: "hi" },
    cwd: "/tmp",
    tools: ["read", "write"],
    model: null,
    thinking_level: null,
  };
}

async function testAppendAndRebuild(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);

  const r1 = makeQueuedRecord({
    triggerId: "t1",
    http: tempHttp(),
    prompt: tempPrompt(),
    taskId: "a".repeat(16),
  });
  appendRecord(paths, r1);

  const r2 = transitionRecord(r1, TaskStatus.Claimed);
  appendRecord(paths, r2);

  const r3 = transitionRecord(r2, TaskStatus.Running);
  appendRecord(paths, r3);

  const r4 = transitionRecord(r3, TaskStatus.Done, {
    turns: 3,
    cost_usd: 0.01,
    implement_result_path: null,
    error_message: null,
  });
  appendRecord(paths, r4);

  const state = rebuildQueue(paths);
  assert.equal(state.pending.length, 0);
  assert.equal(state.inFlight.length, 0);
  assert.equal(state.terminal.length, 1);
  assert.equal(state.byId.get(r1.task_id)?.status, TaskStatus.Done);
  // Terminal sort: ended_at desc — only one element, fine.
  assert.equal(state.terminal[0].task_id, r1.task_id);
}

async function testPartitionPending(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);

  // Two queued, one claimed, one done
  const r1 = makeQueuedRecord({ triggerId: "t1", http: tempHttp(), prompt: tempPrompt(), taskId: "1".repeat(16) });
  const r2 = makeQueuedRecord({ triggerId: "t1", http: tempHttp(), prompt: tempPrompt(), taskId: "2".repeat(16), receivedAt: "2025-01-01T00:00:00.000Z" });
  const r3 = makeQueuedRecord({ triggerId: "t1", http: tempHttp(), prompt: tempPrompt(), taskId: "3".repeat(16) });
  const r4 = makeQueuedRecord({ triggerId: "t1", http: tempHttp(), prompt: tempPrompt(), taskId: "4".repeat(16) });
  appendRecord(paths, r1);
  appendRecord(paths, r2);
  appendRecord(paths, r3);
  appendRecord(paths, transitionRecord(r3, TaskStatus.Claimed));
  appendRecord(paths, transitionRecord(r4, TaskStatus.Done));

  const state = rebuildQueue(paths);
  assert.equal(state.pending.length, 2);
  assert.equal(state.inFlight.length, 1);
  assert.equal(state.terminal.length, 1);
  // pending sort: by received_at asc
  assert.equal(state.pending[0].received_at, r2.received_at);
  assert.equal(state.pending[1].received_at, r1.received_at);
}

async function testClaimAndRelease(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);

  const taskId = "f".repeat(16);
  const claim1 = tryClaim(paths, taskId, 111);
  assert.ok(claim1);
  assert.equal(claim1?.pid, 111);

  // Another worker (different pid) is locked out
  const claim2 = tryClaim(paths, taskId, 222);
  assert.equal(claim2, null);

  // Same pid re-claiming its own live claim is also refused —
  // prevents accidental double-dispatch if a tick fires before
  // runTask has released the previous claim.
  const claim3 = tryClaim(paths, taskId, 111);
  assert.equal(claim3, null);

  // After release, another worker can claim
  releaseClaim(paths, claim1!);
  const claim4 = tryClaim(paths, taskId, 222);
  assert.ok(claim4);
  assert.equal(claim4?.pid, 222);

  releaseClaim(paths, claim4!);
}

async function testRecoverStaleClaims(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);

  const taskId = "9".repeat(16);
  const r1 = makeQueuedRecord({ triggerId: "t1", http: tempHttp(), prompt: tempPrompt(), taskId });
  appendRecord(paths, r1);
  appendRecord(paths, transitionRecord(r1, TaskStatus.Claimed));
  appendRecord(paths, transitionRecord({ ...r1, status: TaskStatus.Claimed }, TaskStatus.Running));

  const state = rebuildQueue(paths);
  assert.equal(state.inFlight.length, 1);

  // No claim file exists; recovery should reset to queued.
  const recovered = recoverStaleClaims(paths, state, 999);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, TaskStatus.Queued);

  // Re-rebuild: should be pending now
  const state2 = rebuildQueue(paths);
  assert.equal(state2.pending.length, 1);
  assert.equal(state2.inFlight.length, 0);
}

async function testMalformedLinesSkipped(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);

  // Write a mix of valid + garbage + empty lines
  fs.writeFileSync(paths.queueFile,
    '{"task_id":"a1","status":"queued","received_at":"2025-01-01T00:00:00.000Z",' +
    '"trigger_id":"t1","http":{"method":"POST","path":"/","remote_addr":null,' +
    '"user_agent":null,"content_type":null,"body_size":0},' +
    '"prompt":{"template":"/x","args":{},"cwd":"/","tools":[],"model":null,"thinking_level":null}}\n' +
    "{ this is not json\n" +
    "\n",
    { mode: 0o600 },
  );
  const state = rebuildQueue(paths);
  assert.equal(state.byId.size, 1);
}

async function testQueueFileMode(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);
  // ensureQueueDirs writes the file with 0600
  const stat = fs.statSync(paths.queueFile);
  assert.equal(stat.mode & 0o777, 0o600);
}

async function testTaskStateRoundTrip(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);

  const taskId = "c".repeat(16);
  const record: WebhookTaskRecord = {
    ...makeQueuedRecord({ triggerId: "t1", http: tempHttp(), prompt: tempPrompt(), taskId }),
    result: {
      turns: 4,
      cost_usd: 0.05,
      implement_result_path: "/tmp/result.json",
      error_message: null,
    },
  };
  writeTaskState(paths, taskId, record);
  const read = readTaskState(paths, taskId);
  assert.ok(read);
  assert.equal(read?.task_id, taskId);
  assert.equal(read?.result?.turns, 4);
  // Task state directory is 0700
  const stat = fs.statSync(paths.tasksRoot);
  assert.equal(stat.mode & 0o777, 0o700);
}

await testAppendAndRebuild();
await testPartitionPending();
await testClaimAndRelease();
await testRecoverStaleClaims();
await testMalformedLinesSkipped();
await testQueueFileMode();
await testTaskStateRoundTrip();

console.log("webhook queue tests passed.");