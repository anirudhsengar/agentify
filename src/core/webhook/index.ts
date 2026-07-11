/**
 * @experimental Internal webhook daemon composition root.
 *
 * This module is not a public CLI command or package export and carries no
 * semantic-version compatibility guarantee. Repository tests and internal code
 * may import it directly; package consumers must use the supported `agentify`
 * executable. See `docs/experimental-surfaces.md`.
 */

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
  /** Optional runtime override used by internal tests. */
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

  const worker = startWorker({
    configDir,
    concurrency: options.concurrency,
    pollIntervalMs: options.pollIntervalMs,
    runtime: options.runtime,
    logger: options.logger,
  });

  const aiwWorkerLogger: AiwWorkerLogger | undefined = options.logger
    ? {
        info: (message, fields) => options.logger!.info(`[aiw] ${message}`, fields),
        warn: (message, fields) => options.logger!.warn(`[aiw] ${message}`, fields),
        error: (message, fields) => options.logger!.error(`[aiw] ${message}`, fields),
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
      if (
        fs.existsSync(pidFile) &&
        parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10) === process.pid
      ) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      // Best-effort cleanup after all workers have stopped.
    }
  };

  const onSignal = (signal: string): void => {
    options.logger?.info(`received ${signal}, shutting down`, {});
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

// Internal experimental exports used by repository modules and tests only.
export { startServer } from "./server.ts";
export { startWorker, type WorkerOptions } from "./worker.ts";
export { loadRegistry, findTrigger } from "./trigger-registry.ts";
export { queuePaths, rebuildQueue } from "./queue.ts";
export type { Trigger, WebhookTaskRecord } from "./state.ts";
export { TaskStatus } from "./state.ts";
export { signBody, verifySignature, verifySignatureWithHeaders } from "./signature.ts";
export { defaultConfigDir };
export { os };
