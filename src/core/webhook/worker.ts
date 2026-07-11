// worker.ts — long-lived background worker that consumes the queue.
//
// The worker runs inside the same process as the HTTP server (one
// process = one webhook daemon). On each tick it:
//   1. rebuilds the queue state from disk (cheap; pure file read)
//   2. recovers any stale in-flight tasks (their claims have lapsed)
//   3. for each pending task, tries to claim it (write-fence)
//   4. for each claimed task, runs the prompt via PiSdkRuntime
//   5. applies the defense hook to the spawned session (defense-in-depth)
//   6. emits a terminal record (done | error | aborted) and releases
//      the claim.
//
// One task at a time per process is the v1 default. A `concurrency`
// option allows parallel dispatch without sharing context.

import * as fs from "node:fs";
import { makeDefenseHook } from "../audit/defense-hook.ts";
import { AgentifyLog } from "../audit/log.ts";
import { getThinkingLevel } from "../audit/state.ts";
import { PiSdkRuntime, packageRoot } from "../pi-sdk-runtime.ts";
import {
  appendRecord,
  ensureQueueDirs,
  queuePaths,
  rebuildQueue,
  recoverStaleClaims,
  releaseClaim,
  taskStateDir,
  transitionRecord,
  tryClaim,
  writeTaskState,
  type ClaimHandle,
  type QueuePaths,
} from "./queue.ts";
import {
  TaskStatus,
  type WebhookTaskRecord,
} from "./state.ts";
import { shippedSkillsDir } from "../pi-sdk-runtime.ts";
import type {
  AgentRuntime,
  AgentRuntimeSessionOptions,
  AgentifyConfig,
} from "../types.ts";
import {
  createReadOnlyExecutionPolicy,
  READ_ONLY_TOOLS,
} from "../security/execution-policy.ts";

export interface WorkerOptions {
  configDir: string;
  runtime?: AgentRuntime;
  pollIntervalMs?: number;
  /** Max concurrent in-flight tasks. Default 1. */
  concurrency?: number;
  /** Logger; defaults to stderr JSON lines. */
  logger?: WorkerLogger;
  /** Stop flag for tests. */
  shouldStop?: () => boolean;
  /** Called for each task lifecycle event; for tests. */
  onTaskEvent?: (event: WorkerTaskEvent) => void;
}

export interface WorkerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type WorkerTaskEvent =
  | { kind: "claimed"; taskId: string }
  | { kind: "started"; taskId: string; prompt: string }
  | { kind: "ended"; taskId: string; status: typeof TaskStatus[keyof typeof TaskStatus]; costUsd: number | null; turns: number; errorMessage?: string };

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_CONCURRENCY = 1;

export interface RunningWorker {
  stop(): Promise<void>;
  /** For tests: run one tick synchronously. */
  tickOnce(): Promise<void>;
}

export function startWorker(options: WorkerOptions): RunningWorker {
  const paths = queuePaths(options.configDir);
  ensureQueueDirs(paths);

  const log = options.logger ?? consoleWorkerLogger();
  const runtime = options.runtime ?? new PiSdkRuntime();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const shouldStop = options.shouldStop ?? (() => false);

  // Crash recovery on first tick.
  try {
    const initial = rebuildQueue(paths);
    const recovered = recoverStaleClaims(paths, initial, process.pid);
    if (recovered.length > 0) {
      log.warn("worker recovered stale claims", { count: recovered.length });
    }
  } catch (err) {
    log.error("worker recovery failed", { error: (err as Error).message });
  }

  let stopped = false;
  // Single persistent inflight counter shared across all ticks.
  // Mutated in-place by runTask's onDone so the next tick sees the
  // current value. The earlier design recreated this object every
  // tick which lost updates from concurrent runTask finishes.
  const inflightRef = { current: 0 };
  const stopPromises: Array<() => void> = [];

  const loop = async (): Promise<void> => {
    while (!stopped && !shouldStop()) {
      try {
        await tickOnceInternal({
          options,
          paths,
          log,
          runtime,
          concurrency,
          inflightRef,
          onTaskEvent: options.onTaskEvent,
          tickStartedAt: Date.now(),
        });
      } catch (err) {
        log.error("worker tick failed", { error: (err as Error).message });
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

  // Kick off the loop; do not await — startWorker is synchronous.
  void loop();

  return {
    async stop(): Promise<void> {
      stopped = true;
      // Wait for any in-flight task to drain (up to a generous cap).
      const deadline = Date.now() + 30_000;
      while (inflightRef.current > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // Resolve any pending sleep so the loop exits promptly.
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
        runtime,
        concurrency,
        inflightRef,
        onTaskEvent: options.onTaskEvent,
        tickStartedAt: Date.now(),
      });
    },
  };
}

interface TickContext {
  options: WorkerOptions;
  paths: QueuePaths;
  log: WorkerLogger;
  runtime: AgentRuntime;
  concurrency: number;
  inflightRef: { current: number };
  onTaskEvent?: (event: WorkerTaskEvent) => void;
  tickStartedAt: number;
}

async function tickOnceInternal(ctx: TickContext): Promise<void> {
  const { paths, log, runtime, concurrency, inflightRef, onTaskEvent } = ctx;

  const state = rebuildQueue(paths);
  recoverStaleClaims(paths, state, process.pid);

  // Refresh after recovery (some pending records may have been added).
  const fresh = rebuildQueue(paths);

  // Take a snapshot of pending (don't iterate live queue map).
  // The webhook worker only handles single-prompt tasks; AIW
  // tasks (`template: "aiw"` or `trigger_id` prefixed with `aiw-`)
  // are owned by the AIW worker (see `core/aiw/worker.ts`).
  const pending = fresh.pending.filter((r) => !isAiwOwned(r));
  if (pending.length === 0) return;
  if (inflightRef.current >= concurrency) return;

  // Dispatch up to (concurrency - inflight) tasks.
  const capacity = concurrency - inflightRef.current;
  const toDispatch = pending.slice(0, capacity);
  for (const record of toDispatch) {
    const handle = tryClaim(paths, record.task_id, process.pid);
    if (!handle) continue; // someone else got it; skip this tick

    const claimed = transitionRecord(record, TaskStatus.Claimed);
    appendRecord(paths, claimed);
    writeTaskState(paths, record.task_id, claimed);
    onTaskEvent?.({ kind: "claimed", taskId: record.task_id });
    log.info("worker claimed task", { task_id: record.task_id, trigger_id: record.trigger_id });

    // Fire-and-forget the actual agent run; concurrency is bounded by
    // the inflightRef counter, which is decremented in `finally`.
    inflightRef.current += 1;
    void runTask({
      record: claimed,
      handle,
      paths,
      log,
      runtime,
      configDir: ctx.options.configDir,
      onTaskEvent,
      onDone: () => {
        inflightRef.current -= 1;
      },
    });
  }
}

interface RunTaskArgs {
  record: WebhookTaskRecord;
  handle: ClaimHandle;
  paths: QueuePaths;
  log: WorkerLogger;
  runtime: AgentRuntime;
  configDir: string;
  onTaskEvent?: (event: WorkerTaskEvent) => void;
  onDone: () => void;
}

function isAiwOwned(record: { prompt: { template: string }; trigger_id: string }): boolean {
  return record.prompt.template === "aiw" || record.trigger_id.startsWith("aiw-");
}

async function runTask(args: RunTaskArgs): Promise<void> {
  const { record, handle, paths, log, runtime, configDir, onTaskEvent, onDone } = args;
  let endedStatus: typeof TaskStatus[keyof typeof TaskStatus] = TaskStatus.Error;
  let errorMessage: string | null = null;
  let costUsd: number | null = null;
  let turns = 0;

  try {
    // Transition to running.
    const running = transitionRecord(record, TaskStatus.Running);
    appendRecord(paths, running);
    writeTaskState(paths, record.task_id, running);
    onTaskEvent?.({
      kind: "started",
      taskId: record.task_id,
      prompt: running.prompt.template,
    });
    log.info("worker started task", {
      task_id: record.task_id,
      template: running.prompt.template,
    });

    const userPrompt = composeUserPrompt(running);
    const result = await runtime.runSession(buildSessionOptions(running, userPrompt, configDir));
    turns = result.turns;
    costUsd = result.costUsd;
    if (result.aborted) {
      endedStatus = TaskStatus.Aborted;
      errorMessage = "aborted";
    } else {
      endedStatus = TaskStatus.Done;
    }

    log.info("worker finished task", {
      task_id: record.task_id,
      status: endedStatus,
      turns,
      cost_usd: costUsd,
    });
  } catch (err) {
    endedStatus = TaskStatus.Error;
    errorMessage = err instanceof Error ? err.message : String(err);
    log.error("worker task failed", {
      task_id: record.task_id,
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
      status: endedStatus,
      costUsd,
      turns,
      errorMessage: errorMessage ?? undefined,
    });
    onDone();
  }
}

function buildSessionOptions(
  record: WebhookTaskRecord,
  userPrompt: string,
  configDir: string,
): AgentRuntimeSessionOptions {
  // Phase 3: model_role takes precedence over model. When
  // model_role is set, the runtime consumes the configured slot via
  // the resolver; when unset, fall back to the literal model id (or
  // primary if neither is set).
  const modelRole = normalizeModelRole(record.prompt.model_role);
  const config: AgentifyConfig = {
    model: record.prompt.model ?? undefined,
    thinkingLevel: normalizeThinkingLevel(record.prompt.thinking_level),
  };
  const tools = record.prompt.tools.length > 0
    ? [...record.prompt.tools]
    : [...READ_ONLY_TOOLS];
  const readOnlySet = new Set<string>(READ_ONLY_TOOLS);
  const unsafeTools = tools.filter((tool) => !readOnlySet.has(tool));
  if (unsafeTools.length > 0) {
    throw new Error(
      `webhook trigger requested unsafe tools: ${unsafeTools.join(", ")}; externally-triggered sessions are read-only`,
    );
  }
  return {
    cwd: record.prompt.cwd,
    configDir,
    config,
    ...(modelRole ? { modelRole } : {}),
    systemPrompt: composeSystemPrompt(record),
    userPrompt,
    tools,
    executionPolicy: createReadOnlyExecutionPolicy({
      cwd: record.prompt.cwd,
      mode: "review-readonly",
      tools,
    }),
    additionalSkillPaths: [shippedSkillsDir()],
  };
}

function normalizeModelRole(value: string | null): "primary" | "explorer" | "lite" | undefined {
  if (!value) return undefined;
  if (value === "primary" || value === "explorer" || value === "lite") {
    return value;
  }
  return undefined;
}

function composeUserPrompt(record: WebhookTaskRecord): string {
  const argLines = Object.entries(record.prompt.args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n");
  return [
    `[webhook task ${record.task_id}]`,
    `Trigger: ${record.trigger_id}`,
    `Template: ${record.prompt.template}`,
    "",
    "Arguments:",
    argLines || "(none)",
    "",
    "Execute the prompt above using these arguments. When done, follow your",
    "normal implement / review / fix workflow per the skill's contract.",
  ].join("\n");
}

function composeSystemPrompt(record: WebhookTaskRecord): string {
  return [
    "You are agentify running in webhook-dispatch mode.",
    `A webhook request just queued this task with trigger "${record.trigger_id}".`,
    `Execute the prompt template "${record.prompt.template}" against the project at ${record.prompt.cwd}.`,
    "The user prompt below contains the resolved arguments. Do not prompt for confirmation;",
    "webhook tasks are out-of-the-loop. Apply your normal validation surface and commit when",
    "the work is green; the dispatch surface returns immediately so there is no human in the loop.",
    "Write a structured summary at the end so the worker's `result.implement_result_path` can",
    "be discovered by future runs.",
  ].join("\n");
}

function normalizeThinkingLevel(
  value: string | null,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!value) return undefined;
  if (value === "off" || value === "minimal" || value === "low"
      || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return undefined;
}

function consoleWorkerLogger(): WorkerLogger {
  return {
    info(message, fields) {
      process.stderr.write(JSON.stringify({ level: "info", src: "worker", message, ...fields }) + "\n");
    },
    warn(message, fields) {
      process.stderr.write(JSON.stringify({ level: "warn", src: "worker", message, ...fields }) + "\n");
    },
    error(message, fields) {
      process.stderr.write(JSON.stringify({ level: "error", src: "worker", message, ...fields }) + "\n");
    },
  };
}

// Re-export commonly-needed symbols.
export { packageRoot };
export { getThinkingLevel };
export { makeDefenseHook };
export { AgentifyLog };
export { taskStateDir };
