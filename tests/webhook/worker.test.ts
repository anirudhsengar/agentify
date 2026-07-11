// tests/webhook/worker.test.ts — worker dispatch + execution-policy integration.
//
// Covers:
//   - tickOnce picks up pending tasks and dispatches them
//   - fake runtime receives the expected userPrompt + read-only tools
//   - unsafe externally-requested tools are rejected before runtime dispatch
//   - terminal record is written with success status
//   - failure path writes an error record
//   - abort path writes an aborted record
//   - concurrency=2 parallelizes tasks

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
    if (this.opts.holdMs) await new Promise((resolve) => setTimeout(resolve, this.opts.holdMs));
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

function tempPrompt(tools: string[] = ["read"]): WebhookTaskRecord["prompt"] {
  return {
    template: "/implement",
    args: { body: "hi" },
    cwd: "/tmp",
    tools,
    model: null,
    thinking_level: null,
    model_role: null,
  };
}

function makeRecord(taskId: string, tools?: string[]): WebhookTaskRecord {
  return makeQueuedRecord({
    triggerId: "t1",
    http: tempHttp(),
    prompt: tempPrompt(tools),
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
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
    const record = makeRecord("a".repeat(16));
    appendRecord(paths, record);

    await waitFor(() => rebuildQueue(paths).terminal.length === 1);
    const final = rebuildQueue(paths).byId.get(record.task_id);
    assert.equal(final?.status, TaskStatus.Done);
    assert.equal(final?.result?.turns, 1);
    assert.equal(runtime.calls.length, 1);
    assert.match(runtime.calls[0]!.systemPrompt, /webhook-dispatch mode/);
    assert.match(runtime.calls[0]!.userPrompt, /body="hi"/);
    assert.deepEqual(runtime.calls[0]!.tools, ["read"]);
    assert.equal(runtime.calls[0]!.executionPolicy.mode, "review-readonly");
    assert.deepEqual(runtime.calls[0]!.executionPolicy.writableRoots, []);
    assert.equal(runtime.calls[0]!.executionPolicy.commandPolicy, "deny");
  } finally {
    await worker.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testUnsafeToolsRejectedBeforeRuntime(): Promise<void> {
  const configDir = tempDir("worker-unsafe");
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
    const record = makeRecord("d".repeat(16), ["read", "write", "bash"]);
    appendRecord(paths, record);

    await waitFor(() => rebuildQueue(paths).terminal.length === 1);
    const final = rebuildQueue(paths).byId.get(record.task_id);
    assert.equal(final?.status, TaskStatus.Error);
    assert.match(final?.result?.error_message ?? "", /unsafe tools: write, bash/);
    assert.equal(runtime.calls.length, 0, "unsafe tools must be rejected before runtime dispatch");
  } finally {
    await worker.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
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
    const record = makeRecord("b".repeat(16));
    appendRecord(paths, record);

    await waitFor(() => rebuildQueue(paths).terminal.length === 1);
    const final = rebuildQueue(paths).byId.get(record.task_id);
    assert.equal(final?.status, TaskStatus.Error);
    assert.match(final?.result?.error_message ?? "", /boom/);
  } finally {
    await worker.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
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
    const record = makeRecord("c".repeat(16));
    appendRecord(paths, record);

    await waitFor(() => rebuildQueue(paths).terminal.length === 1);
    const final = rebuildQueue(paths).byId.get(record.task_id);
    assert.equal(final?.status, TaskStatus.Aborted);
    assert.equal(final?.result?.error_message, "aborted");
  } finally {
    await worker.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
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
      await new Promise((resolve) => setTimeout(resolve, 80));
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
    onTaskEvent: (event) => events.push(event),
  });
  try {
    const paths = queuePaths(configDir);
    ensureQueueDirs(paths);
    appendRecord(paths, makeRecord("1".repeat(16)));
    appendRecord(paths, makeRecord("2".repeat(16)));
    appendRecord(paths, makeRecord("3".repeat(16)));

    await waitFor(() => rebuildQueue(paths).terminal.length === 3, 8_000);
    assert.equal(maxConcurrent, 2);
    assert.equal(events.filter((event) => event.kind === "started").length, 3);
    assert.equal(events.filter((event) => event.kind === "ended").length, 3);
  } finally {
    await worker.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

function silentLogger() {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop };
}

await testSuccessfulRun();
await testUnsafeToolsRejectedBeforeRuntime();
await testFailureRun();
await testAbortRun();
await testConcurrency2();

console.log("webhook worker tests passed.");
