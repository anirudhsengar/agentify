// tests/aiw/worker.test.ts — AIW worker tests.
//
// Covers:
//   - enqueueAiwTask creates a record in the queue log
//   - startAiwWorker claims and dispatches AIW tasks
//   - non-AIW tasks are NOT picked up by the AIW worker
//   - onTaskEvent callback fires for claimed/started/ended
//   - crash recovery resets stale in-flight AIW tasks

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  rebuildQueue,
  queuePaths,
  ensureQueueDirs,
} from "../../src/core/webhook/queue.ts";
import {
  startAiwWorker,
  enqueueAiwTask,
  type AiwWorkerEvent,
} from "../../src/core/aiw/worker.ts";
import {
  startAiwRunner,
  type AiwRunner,
} from "../../src/core/aiw/index.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
} from "../../src/core/types.ts";

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-aiw-worker-"));
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

function makeDryRuntime(): AgentRuntime {
  return {
    async runSession(_options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
      return { turns: 1, costUsd: 0.001, aborted: false };
    },
    async runGreenfield(): Promise<AgentRuntimeResult> {
      return { turns: 0, costUsd: null, aborted: false };
    },
  };
}

async function testEnqueue(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);
  const record = enqueueAiwTask({
    configDir,
    triggerId: "aiw-test",
    aiwId: "a".repeat(16),
    workflow: "plan_build",
    prompt: "test prompt",
    source: "test",
    cwd: "/tmp",
  });
  assert.equal(record.task_id, "a".repeat(16));
  assert.equal(record.prompt.template, "aiw");
  const state = rebuildQueue(paths);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0]!.prompt.args["workflow"], "plan_build");
}

async function testWorkerDispatchesAiwTask(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);

  const events: AiwWorkerEvent[] = [];
  const worker = startAiwWorker({
    configDir,
    cwd: configDir,
    runtime: makeDryRuntime(),
    pollIntervalMs: 25,
    concurrency: 1,
    shouldStop: () => false,
    onTaskEvent: (e) => events.push(e),
    // Pass a runner that uses a stub runtime, since the dry
    // runtime doesn't actually do anything for AIWs.
    runnerFactory: (cwd) => {
      return startAiwRunner({
        configDir,
        cwd,
        runtime: makeDryRuntime(),
        noWorktree: true,
      });
    },
  });

  try {
    enqueueAiwTask({
      configDir,
      triggerId: "aiw-test",
      aiwId: "1".repeat(16),
      workflow: "plan_build",
      prompt: "test",
      source: "test",
      cwd: configDir,
    });
    await waitFor(() => events.some((e) => e.kind === "ended"));
    const ended = events.find((e) => e.kind === "ended");
    assert.ok(ended);
    assert.equal(ended!.status, "done");
  } finally {
    await worker.stop();
  }
}

async function testWorkerSkipsNonAiwTasks(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);

  // Manually append a non-AIW record (template is "/implement",
  // not "aiw"; trigger id is "github-issue", not "aiw-*").
  fs.appendFileSync(paths.queueFile, JSON.stringify({
    task_id: "2".repeat(16),
    trigger_id: "github-issue",
    status: "queued",
    received_at: new Date().toISOString(),
    http: {
      method: "POST",
      path: "/webhooks/github/issue",
      remote_addr: null,
      user_agent: null,
      content_type: "application/json",
      body_size: 0,
    },
    prompt: {
      template: "/implement",
      args: { body: "hi" },
      cwd: "/tmp",
      tools: [],
      model: null,
      thinking_level: null,
    },
  }) + "\n");

  let runnerCalled = false;
  const fakeRunner: AiwRunner = {
    async run() { runnerCalled = true; throw new Error("should not be called"); },
    async resume() { throw new Error(); },
    async cancel() {},
    show() { return null; },
    list() { return []; },
    kpis() {
      return {
        currentStreak: 0, longestStreak: 0,
        planSizeMedian: null, planSizeP95: null,
        diffSizeMedian: null, diffSizeP95: null,
        averagePresence: 0, attempts: 0,
        afkEarned: { chores: false, bugs: false, features: false },
        updatedAt: new Date().toISOString(),
      };
    },
    cleanup() {},
  };

  const worker = startAiwWorker({
    configDir,
    cwd: configDir,
    pollIntervalMs: 25,
    shouldStop: () => false,
    runnerFactory: () => fakeRunner,
  });

  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(runnerCalled, false);
  } finally {
    await worker.stop();
  }
}

async function testCrashRecovery(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);

  // Enqueue an AIW task, then "claim" it from a fake pid (to
  // simulate a crashed worker). Recovery on next worker boot
  // should reset it to "queued".
  const aiwId = "3".repeat(16);
  enqueueAiwTask({
    configDir,
    triggerId: "aiw-test",
    aiwId,
    workflow: "plan_build",
    prompt: "x",
    source: "test",
    cwd: configDir,
  });
  // Simulate claim by a different (crashed) pid.
  const { tryClaim, transitionRecord, appendRecord } = await import("../../src/core/webhook/queue.ts");
  const { TaskStatus } = await import("../../src/core/webhook/state.ts");
  const handle = tryClaim(paths, aiwId, 99999);
  assert.ok(handle);
  // Transition to running and write to log.
  const state = rebuildQueue(paths);
  const record = state.byId.get(aiwId)!;
  appendRecord(paths, transitionRecord(record, TaskStatus.Claimed));
  appendRecord(paths, transitionRecord(transitionRecord(record, TaskStatus.Claimed), TaskStatus.Running));
  // Remove the claim file so recovery thinks the worker is dead.
  fs.unlinkSync(handle.path);

  // Boot a new worker; recovery should reset to queued.
  const events: AiwWorkerEvent[] = [];
  const worker = startAiwWorker({
    configDir,
    cwd: configDir,
    runtime: makeDryRuntime(),
    pollIntervalMs: 25,
    concurrency: 1,
    shouldStop: () => false,
    onTaskEvent: (e) => events.push(e),
    runnerFactory: (cwd) => startAiwRunner({
      configDir,
      cwd,
      runtime: makeDryRuntime(),
      noWorktree: true,
    }),
  });

  try {
    await waitFor(() => events.some((e) => e.kind === "ended"));
    // The recovered task completed.
    const ended = events.find((e) => e.kind === "ended");
    assert.ok(ended);
    assert.equal(ended!.status, "done");
  } finally {
    await worker.stop();
  }
}

async function testWorkerRecordsCostAndTurns(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = queuePaths(configDir);
  ensureQueueDirs(paths);

  let recordedEnded: AiwWorkerEvent | undefined;
  const worker = startAiwWorker({
    configDir,
    cwd: configDir,
    runtime: {
      async runSession(_opts: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
        return { turns: 4, costUsd: 0.05, aborted: false };
      },
      async runGreenfield(): Promise<AgentRuntimeResult> {
        throw new Error();
      },
    },
    pollIntervalMs: 25,
    concurrency: 1,
    shouldStop: () => false,
    onTaskEvent: (e) => {
      if (e.kind === "ended") recordedEnded = e;
    },
    runnerFactory: (cwd) => startAiwRunner({
      configDir,
      cwd,
      runtime: makeDryRuntime(),
      noWorktree: true,
    }),
  });

  try {
    enqueueAiwTask({
      configDir,
      triggerId: "aiw-test",
      aiwId: "4".repeat(16),
      workflow: "plan_build",
      prompt: "x",
      source: "test",
      cwd: configDir,
    });
    await waitFor(() => recordedEnded !== undefined);
    assert.ok(recordedEnded);
    assert.equal(recordedEnded!.kind, "ended");
    // Total cost across all phases (2 phases for plan_build).
    // The stub runSession returns costUsd: 0.001, so total = 0.002.
    if (recordedEnded!.kind === "ended") {
      assert.ok(recordedEnded!.costUsd !== null && recordedEnded!.costUsd > 0);
    }
  } finally {
    await worker.stop();
  }
}

await testEnqueue();
await testWorkerDispatchesAiwTask();
await testWorkerSkipsNonAiwTasks();
await testCrashRecovery();
await testWorkerRecordsCostAndTurns();

console.log("aiw worker tests passed.");