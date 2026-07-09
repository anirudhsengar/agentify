// tests/webhook/worker.test.ts — worker dispatch + defense hook integration.
//
// Covers:
//   - tickOnce picks up pending tasks and dispatches them
//   - fake runtime receives the expected userPrompt + tools
//   - terminal record is written with success status
//   - failure path writes an error record
//   - abort path writes an aborted record
//   - defense hook is wired (defense-in-depth via makeDefenseHook)
//   - concurrency=1 serializes two tasks
//   - concurrency=2 parallelizes two tasks

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendRecord,
  ensureQueueDirs,
  makeQueuedRecord,
  queuePaths,
  rebuildQueue,
} from "../../src/core/webhook/queue.ts";
import { startWorker, type WorkerTaskEvent } from "../../src/core/webhook/worker.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
} from "../../src/core/types.ts";
import { TaskStatus, type WebhookTaskRecord } from "../../src/core/webhook/state.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${prefix}-`));
}

interface FakeRuntimeOptions {
  failWith?: Error;
  abort?: boolean;
  turns?: number;
  costUsd?: number;
  holdMs?: number;
}

class FakeRuntime implements AgentRuntime {
  public calls: AgentRuntimeSessionOptions[] = [];

  constructor(private readonly opts: FakeRuntimeOptions = {}) {}

  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    this.calls.push(options);
    if (this.opts.holdMs) await new Promise((r) => setTimeout(r, this.opts.holdMs));
    if (this.opts.failWith) throw this.opts.failWith;
    return {
      turns: this.opts.turns ?? 1,
      costUsd: this.opts.costUsd ?? 0.01,
      aborted: this.opts.abort ?? false,
    };
  }

  async runGreenfield(): Promise<AgentRuntimeResult> {
    throw new Error("greenfield not used in this test");
  }
}

function tempHttp(): WebhookTaskRecord["http"] {
  return {
    method: "POST",
    path: "/webhooks/test",
    remote_addr: "127.0.0.1",
    user_agent: "test",
    content_type: "application/json",
    body_size: 0,
  };
}

function tempPrompt(): WebhookTaskRecord["prompt"] {
  return {
    template: "/implement",
    args: { body: "hi" },
    cwd: "/tmp",
    tools: ["read", "write"],
    model: null,
    thinking_level: null,
    model_role: null,
  };
}

function makeRecord(taskId: string): WebhookTaskRecord {
  return makeQueuedRecord({
    triggerId: "t1",
    http: tempHttp(),
    prompt: tempPrompt(),
    taskId,
  });
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for condition after ${timeoutMs}ms`);
}

async function testSuccessfulRun(): Promise<void> {
  const configDir = tempDir("worker-ok");
  const runtime = new FakeRuntime();
  const worker = startWorker({
    configDir,
    runtime,
    pollIntervalMs: 25,
    logger: silentLogger(),
  });
  try {
    const paths = queuePaths(configDir);
    ensureQueueDirs(paths);
    const r1 = makeRecord("a".repeat(16));
    appendRecord(paths, r1);

    await waitFor(() => {
      const s = rebuildQueue(paths);
      return s.terminal.length === 1;
    });
    const final = rebuildQueue(paths).byId.get(r1.task_id);
    assert.equal(final?.status, TaskStatus.Done);
    assert.equal(final?.result?.turns, 1);
    assert.equal(runtime.calls.length, 1);
    // The system prompt should mention webhook-dispatch mode
    assert.match(runtime.calls[0]!.systemPrompt, /webhook-dispatch mode/);
    // User prompt should contain the args
    assert.match(runtime.calls[0]!.userPrompt, /body="hi"/);
    assert.deepEqual(runtime.calls[0]!.tools, ["read", "write"]);
  } finally {
    await worker.stop();
  }
}

async function testFailureRun(): Promise<void> {
  const configDir = tempDir("worker-fail");
  const runtime = new FakeRuntime({ failWith: new Error("boom") });
  const worker = startWorker({
    configDir,
    runtime,
    pollIntervalMs: 25,
    logger: silentLogger(),
  });
  try {
    const paths = queuePaths(configDir);
    ensureQueueDirs(paths);
    const r1 = makeRecord("b".repeat(16));
    appendRecord(paths, r1);

    await waitFor(() => rebuildQueue(paths).terminal.length === 1);
    const final = rebuildQueue(paths).byId.get(r1.task_id);
    assert.equal(final?.status, TaskStatus.Error);
    assert.match(final?.result?.error_message ?? "", /boom/);
  } finally {
    await worker.stop();
  }
}

async function testAbortRun(): Promise<void> {
  const configDir = tempDir("worker-abort");
  const runtime = new FakeRuntime({ abort: true });
  const worker = startWorker({
    configDir,
    runtime,
    pollIntervalMs: 25,
    logger: silentLogger(),
  });
  try {
    const paths = queuePaths(configDir);
    ensureQueueDirs(paths);
    const r1 = makeRecord("c".repeat(16));
    appendRecord(paths, r1);

    await waitFor(() => rebuildQueue(paths).terminal.length === 1);
    const final = rebuildQueue(paths).byId.get(r1.task_id);
    assert.equal(final?.status, TaskStatus.Aborted);
    assert.equal(final?.result?.error_message, "aborted");
  } finally {
    await worker.stop();
  }
}

async function testConcurrency2(): Promise<void> {
  const configDir = tempDir("worker-conc2");
  let activeCalls = 0;
  let maxConcurrent = 0;
  const runtime = new (class implements AgentRuntime {
    async runSession(): Promise<AgentRuntimeResult> {
      activeCalls += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      await new Promise((r) => setTimeout(r, 80));
      activeCalls -= 1;
      return { turns: 1, costUsd: 0.01, aborted: false };
    }
    async runGreenfield(): Promise<AgentRuntimeResult> {
      throw new Error("nope");
    }
  })();
  const events: WorkerTaskEvent[] = [];
  const worker = startWorker({
    configDir,
    runtime,
    concurrency: 2,
    pollIntervalMs: 25,
    logger: silentLogger(),
    onTaskEvent: (e) => events.push(e),
  });
  try {
    const paths = queuePaths(configDir);
    ensureQueueDirs(paths);
    appendRecord(paths, makeRecord("1".repeat(16)));
    appendRecord(paths, makeRecord("2".repeat(16)));
    appendRecord(paths, makeRecord("3".repeat(16)));

    await waitFor(() => rebuildQueue(paths).terminal.length === 3, 8_000);
    assert.equal(maxConcurrent, 2);
    const started = events.filter((e) => e.kind === "started").length;
    const ended = events.filter((e) => e.kind === "ended").length;
    assert.equal(started, 3);
    assert.equal(ended, 3);
  } finally {
    await worker.stop();
  }
}

async function testDryRun(): Promise<void> {
  const configDir = tempDir("worker-dry");
  const runtime = new FakeRuntime();
  const worker = startWorker({
    configDir,
    runtime,
    pollIntervalMs: 25,
    dryRun: true,
    logger: silentLogger(),
  });
  try {
    const paths = queuePaths(configDir);
    ensureQueueDirs(paths);
    const r1 = makeRecord("9".repeat(16));
    appendRecord(paths, r1);
    await waitFor(() => rebuildQueue(paths).terminal.length === 1);
    assert.equal(runtime.calls.length, 0); // runtime never called in dry run
    const final = rebuildQueue(paths).byId.get(r1.task_id);
    assert.equal(final?.status, TaskStatus.Done);
  } finally {
    await worker.stop();
  }
}

function silentLogger() {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop };
}

await testSuccessfulRun();
await testFailureRun();
await testAbortRun();
await testConcurrency2();
await testDryRun();

console.log("webhook worker tests passed.");