// worker.ts — long-lived worker that consumes AIW tasks from the
// shared JSONL queue.
//
// The worker reads task records from `~/.agentify/queue/tasks.jsonl`
// (the same queue the webhook writes to). When a record is an AIW
// task (carrying `aiw_id`, `workflow`, `prompt`), the worker calls
// `AiwRunner.run()` to execute the workflow. The worker is otherwise
// a thin consumer — it does not own the workflow logic; the runner
// does.
//
// Design notes:
//   - The worker reuses the webhook queue for trigger handoff, so
//     existing webhook triggers can fire AIWs by setting
//     `prompt.aiw_workflow` in their config (see
//     `webhook/aiw-dispatch.ts`).
//   - Concurrency is bounded by `concurrency` (default 1) — running
//     multiple full SDLC workflows in parallel is not the v1 default.
//   - On crash, the worker's claim-fence pattern (mirrored from
//     webhook/queue.ts) ensures the next worker can resume from the
//     last persisted state via `AiwRunner.resume()`.

import * as fs from "node:fs";
import { startAiwRunner, type AiwRunner } from "./index.ts";
import {
  appendRecord,
  ensureQueueDirs,
  makeQueuedRecord,
  queuePaths,
  rebuildQueue,
  recoverStaleClaims,
  releaseClaim,
  transitionRecord,
  tryClaim,
  writeTaskState,
  type ClaimHandle,
  type QueuePaths,
} from "../webhook/queue.ts";
import {
  TaskStatus,
  type WebhookTaskRecord,
} from "../webhook/state.ts";
import type { AgentRuntime } from "../types.ts";
import { defaultConfigDir } from "../agentify-config.ts";

export interface AiwWorkerOptions {
  configDir: string;
  cwd: string;
  runtime?: AgentRuntime;
  pollIntervalMs?: number;
  /** Max concurrent AIW tasks in flight. Default 1. */
  concurrency?: number;
  /** Logger; defaults to stderr JSON lines. */
  logger?: AiwWorkerLogger;
  /** Stop flag for tests. */
  shouldStop?: () => boolean;
  /** Override the runner factory (for tests). */
  runnerFactory?: (cwd: string) => AiwRunner;
  /** Called for each task lifecycle event; for tests. */
  onTaskEvent?: (event: AiwWorkerEvent) => void;
}

export interface AiwWorkerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type AiwWorkerEvent =
  | { kind: "claimed"; taskId: string; aiwId: string }
  | { kind: "started"; taskId: string; aiwId: string; workflow: string }
  | { kind: "ended"; taskId: string; aiwId: string; status: string; costUsd: number | null; turns: number; errorMessage?: string };

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_CONCURRENCY = 1;

export interface RunningAiwWorker {
  stop(): Promise<void>;
  tickOnce(): Promise<void>;
}

export function startAiwWorker(options: AiwWorkerOptions): RunningAiwWorker {
  const paths = queuePaths(options.configDir);
  ensureQueueDirs(paths);
  const log = options.logger ?? consoleAiwWorkerLogger();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const shouldStop = options.shouldStop ?? (() => false);

  const runner: AiwRunner = options.runnerFactory
    ? options.runnerFactory(options.cwd)
    : startAiwRunner({
        configDir: options.configDir,
        cwd: options.cwd,
        runtime: options.runtime,
      });

  // Crash recovery on first tick.
  try {
    const initial = rebuildQueue(paths);
    const recovered = recoverStaleClaims(paths, initial, process.pid);
    if (recovered.length > 0) {
      log.warn("aiw worker recovered stale claims", { count: recovered.length });
    }
  } catch (err) {
    log.error("aiw worker recovery failed", { error: (err as Error).message });
  }

  let stopped = false;
  const inflightRef = { current: 0 };
  const stopPromises: Array<() => void> = [];

  const loop = async (): Promise<void> => {
    while (!stopped && !shouldStop()) {
      try {
        await tickOnceInternal({
          options,
          paths,
          log,
          runner,
          concurrency,
          inflightRef,
          onTaskEvent: options.onTaskEvent,
        });
      } catch (err) {
        log.error("aiw worker tick failed", { error: (err as Error).message });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), pollIntervalMs);
        stopPromises.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  void loop();

  return {
    async stop(): Promise<void> {
      stopped = true;
      const deadline = Date.now() + 30_000;
      while (inflightRef.current > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      while (stopPromises.length > 0) {
        const r = stopPromises.shift();
        r?.();
      }
    },
    async tickOnce(): Promise<void> {
      await tickOnceInternal({
        options,
        paths,
        log,
        runner,
        concurrency,
        inflightRef,
        onTaskEvent: options.onTaskEvent,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

interface TickContext {
  options: AiwWorkerOptions;
  paths: QueuePaths;
  log: AiwWorkerLogger;
  runner: AiwRunner;
  concurrency: number;
  inflightRef: { current: number };
  onTaskEvent?: (event: AiwWorkerEvent) => void;
}

async function tickOnceInternal(ctx: TickContext): Promise<void> {
  const { paths, log, runner, concurrency, inflightRef, onTaskEvent } = ctx;

  const state = rebuildQueue(paths);
  recoverStaleClaims(paths, state, process.pid);
  const fresh = rebuildQueue(paths);

  const pending = fresh.pending.filter((r) => isAiwTask(r));
  if (pending.length === 0) return;
  if (inflightRef.current >= concurrency) return;

  const capacity = concurrency - inflightRef.current;
  const toDispatch = pending.slice(0, capacity);
  for (const record of toDispatch) {
    const handle = tryClaim(paths, record.task_id, process.pid);
    if (!handle) continue;

    const claimed = transitionRecord(record, TaskStatus.Claimed);
    appendRecord(paths, claimed);
    writeTaskState(paths, record.task_id, claimed);
    const aiwId = (record.prompt.args["aiw_id"] as string | undefined) ?? record.task_id;
    onTaskEvent?.({ kind: "claimed", taskId: record.task_id, aiwId });
    log.info("aiw worker claimed task", { task_id: record.task_id, aiw_id: aiwId });

    inflightRef.current += 1;
    void runAiwTask({
      record: claimed,
      handle,
      paths,
      log,
      runner,
      onTaskEvent,
      onDone: () => {
        inflightRef.current -= 1;
      },
    });
  }
}

interface RunAiwTaskArgs {
  record: WebhookTaskRecord;
  handle: ClaimHandle;
  paths: QueuePaths;
  log: AiwWorkerLogger;
  runner: AiwRunner;
  onTaskEvent?: (event: AiwWorkerEvent) => void;
  onDone: () => void;
}

async function runAiwTask(args: RunAiwTaskArgs): Promise<void> {
  const { record, handle, paths, log, runner, onTaskEvent, onDone } = args;
  const aiwId = (record.prompt.args["aiw_id"] as string | undefined) ?? record.task_id;
  const workflow = (record.prompt.args["workflow"] as string | undefined) ?? "plan_build";
  const prompt = (record.prompt.args["prompt"] as string | undefined) ?? "";
  const source = (record.prompt.args["source"] as string | undefined) ?? `webhook:${record.trigger_id}`;

  let endedStatus: typeof TaskStatus[keyof typeof TaskStatus] = TaskStatus.Error;
  let errorMessage: string | null = null;
  let costUsd: number | null = null;
  let turns = 0;

  try {
    const running = transitionRecord(record, TaskStatus.Running);
    appendRecord(paths, running);
    writeTaskState(paths, record.task_id, running);
    onTaskEvent?.({
      kind: "started",
      taskId: record.task_id,
      aiwId,
      workflow,
    });
    log.info("aiw worker started task", { task_id: record.task_id, aiw_id: aiwId, workflow });

    if (!isValidWorkflow(workflow)) {
      throw new Error(`unknown workflow "${workflow}"`);
    }

    const finalState = await runner.run({
      aiwId,
      workflow,
      prompt,
      source,
    });

    costUsd = sumCost(finalState);
    turns = sumTurns(finalState);
    if (finalState.status === "completed") {
      endedStatus = TaskStatus.Done;
    } else if (finalState.status === "aborted") {
      endedStatus = TaskStatus.Aborted;
      errorMessage = "aborted";
    } else {
      endedStatus = TaskStatus.Error;
      errorMessage = finalState.error_message ?? "unknown failure";
    }

    log.info("aiw worker finished task", {
      task_id: record.task_id,
      aiw_id: aiwId,
      status: endedStatus,
      cost_usd: costUsd,
      turns,
    });
  } catch (err) {
    endedStatus = TaskStatus.Error;
    errorMessage = err instanceof Error ? err.message : String(err);
    log.error("aiw worker task failed", {
      task_id: record.task_id,
      aiw_id: aiwId,
      error: errorMessage,
    });
  } finally {
    const terminal = transitionRecord(record, endedStatus, {
      turns,
      cost_usd: costUsd,
      implement_result_path: null,
      error_message: errorMessage,
    });
    appendRecord(paths, terminal);
    writeTaskState(paths, record.task_id, terminal);
    releaseClaim(paths, handle);
    onTaskEvent?.({
      kind: "ended",
      taskId: record.task_id,
      aiwId,
      status: endedStatus,
      costUsd,
      turns,
      errorMessage: errorMessage ?? undefined,
    });
    onDone();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAiwTask(record: WebhookTaskRecord): boolean {
  return record.prompt.template === "aiw" || record.trigger_id.startsWith("aiw-");
}

function isValidWorkflow(value: string): value is "plan_build" | "plan_build_review" | "plan_build_review_fix" | "plan_build_review_ship" {
  return value === "plan_build"
      || value === "plan_build_review"
      || value === "plan_build_review_fix"
      || value === "plan_build_review_ship";
}

function sumCost(state: { phases: Array<{ cost_usd: number | null }> }): number | null {
  let total = 0;
  let hasAny = false;
  for (const p of state.phases) {
    if (p.cost_usd !== null && Number.isFinite(p.cost_usd)) {
      total += p.cost_usd;
      hasAny = true;
    }
  }
  return hasAny ? total : null;
}

function sumTurns(state: { phases: Array<{ turns: number }> }): number {
  return state.phases.reduce((acc, p) => acc + p.turns, 0);
}

function consoleAiwWorkerLogger(): AiwWorkerLogger {
  return {
    info(message, fields) {
      process.stderr.write(JSON.stringify({ level: "info", src: "aiw-worker", message, ...(fields ?? {}) }) + "\n");
    },
    warn(message, fields) {
      process.stderr.write(JSON.stringify({ level: "warn", src: "aiw-worker", message, ...(fields ?? {}) }) + "\n");
    },
    error(message, fields) {
      process.stderr.write(JSON.stringify({ level: "error", src: "aiw-worker", message, ...(fields ?? {}) }) + "\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Enqueue helper (used by webhook integration + CLI manual trigger)
// ---------------------------------------------------------------------------

/**
 * Enqueue an AIW task to the shared webhook queue. The worker picks
 * it up. The queue's existing claim-fence + JSONL append log give
 * us durability for free.
 */
export function enqueueAiwTask(args: {
  configDir: string;
  triggerId: string;
  aiwId: string;
  workflow: string;
  prompt: string;
  source: string;
  http?: WebhookTaskRecord["http"];
  cwd: string;
  tools?: string[];
}): WebhookTaskRecord {
  const paths = queuePaths(args.configDir);
  ensureQueueDirs(paths);
  const record = makeQueuedRecord({
    triggerId: args.triggerId,
    http: args.http ?? {
      method: "POST",
      path: "/aiw",
      remote_addr: null,
      user_agent: null,
      content_type: "application/json",
      body_size: 0,
    },
    prompt: {
      template: "aiw",
      args: {
        aiw_id: args.aiwId,
        workflow: args.workflow,
        prompt: args.prompt,
        source: args.source,
      },
      cwd: args.cwd,
      tools: args.tools ?? [],
      model: null,
      thinking_level: null,
      model_role: null,
    },
    taskId: args.aiwId,
  });
  appendRecord(paths, record);
  writeTaskState(paths, record.task_id, record);
  return record;
}