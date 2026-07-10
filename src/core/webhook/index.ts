// index.ts — the webhook daemon: HTTP server + background worker.
//
// One process owns:
//   - the HTTP listener (server.ts)
//   - the persistent JSONL queue (queue.ts)
//   - the long-lived worker loop (worker.ts)
//
// This module is the composition root for `agentify webhook start`.
//
// The daemon writes its pid to a file so `agentify webhook stop` can
// signal it. SIGINT and SIGTERM both trigger graceful shutdown.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfigDir } from "../agentify-config.ts";
import { queuePaths } from "./queue.ts";
import { startServer } from "./server.ts";
import { startWorker, type WorkerLogger, type WorkerOptions } from "./worker.ts";
import {
  startAiwWorker,
  type AiwWorkerLogger,
} from "../aiw/worker.ts";
import type { AgentRuntime } from "../types.ts";

export interface DaemonOptions {
  cwd: string;
  host?: string;
  port?: number;
  concurrency?: number;
  pollIntervalMs?: number;
  /** Optional runtime override (used by tests to inject a fake). */
  runtime?: AgentRuntime;
  logger?: WorkerLogger;
}

export interface RunningDaemon {
  port: number;
  host: string;
  pid: number;
  pidFile: string;
  stop(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const configDir = defaultConfigDir();
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const pidFile = path.join(configDir, "webhook.pid");
  // Refuse to start if another daemon is already running.
  if (fs.existsSync(pidFile)) {
    const existing = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (Number.isFinite(existing) && isProcessAlive(existing) && existing !== process.pid) {
      throw new Error(`webhook daemon already running (pid ${existing}); remove ${pidFile} to override.`);
    }
    fs.unlinkSync(pidFile);
  }
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });

  const server = await startServer({
    configDir,
    cwd: options.cwd,
    host: options.host,
    port: options.port,
    logger: options.logger,
  });

  const paths = queuePaths(configDir);
  const worker = startWorker({
    configDir,
    concurrency: options.concurrency,
    pollIntervalMs: options.pollIntervalMs,
    runtime: options.runtime,
    logger: options.logger,
  });

  // the AIW runtime: the AIW worker shares the webhook queue. It
  // picks up tasks whose trigger id starts with `aiw-` (see
  // aiw/worker.ts `isAiwTask`). Same config dir, same queue, two
  // specialized consumers.
  const aiwWorkerLogger: AiwWorkerLogger | undefined = options.logger
    ? {
        info: (m, f) => options.logger!.info(`[aiw] ${m}`, f),
        warn: (m, f) => options.logger!.warn(`[aiw] ${m}`, f),
        error: (m, f) => options.logger!.error(`[aiw] ${m}`, f),
      }
    : undefined;
  const aiwWorker = startAiwWorker({
    configDir,
    cwd: options.cwd,
    concurrency: 1,
    pollIntervalMs: 500,
    runtime: options.runtime,
    logger: aiwWorkerLogger,
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await worker.stop();
    await aiwWorker.stop();
    await server.close();
    try {
      if (fs.existsSync(pidFile) &&
          parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10) === process.pid) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      // Best effort.
    }
  };

  // Graceful shutdown on signals.
  const onSignal = (sig: string): void => {
    options.logger?.info(`received ${sig}, shutting down`, {});
    void stop();
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  return {
    port: server.port,
    host: server.host,
    pid: process.pid,
    pidFile,
    stop,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Re-export public surface for the CLI module.
export { startServer } from "./server.ts";
export { startWorker, type WorkerOptions } from "./worker.ts";
export { loadRegistry, findTrigger } from "./trigger-registry.ts";
export { queuePaths, rebuildQueue } from "./queue.ts";
export type { Trigger, WebhookTaskRecord } from "./state.ts";
export { TaskStatus } from "./state.ts";
export { signBody, verifySignature, verifySignatureWithHeaders } from "./signature.ts";
export { defaultConfigDir };

// Expose os for the CLI module's defaults.
export { os };