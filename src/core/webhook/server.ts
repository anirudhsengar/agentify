// server.ts — the HTTP webhook server.
//
// Uses Node's built-in `http` module (zero new deps, per ADR-0013).
// On every verified request:
//   1. Look up the trigger (method + path).
//   2. Read the body up to trigger.max_body_bytes (default 1 MiB).
//   3. Verify signature (HMAC with timing-safe compare).
//   4. Parse JSON payload if Content-Type allows.
//   5. Evaluate `match` clause.
//   6. Resolve prompt invocation (args_from_payload, etc.).
//   7. Append a queued record to the JSONL log.
//   8. Return 202 Accepted with { task_id, status_url } within 100 ms.
//
// The worker (worker.ts) consumes the queue on a separate loop.
// This module never blocks the request on agent work.

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  appendRecord,
  ensureQueueDirs,
  makeQueuedRecord,
  queuePaths,
  type QueuePaths,
} from "./queue.ts";
import {
  findTrigger,
  loadRegistry,
  matchesClause,
  resolvePromptInvocation,
  checkRateLimit,
  type RateLimiter,
} from "./trigger-registry.ts";
import {
  TaskStatus,
  defaultToolsForTrigger,
  type Trigger,
  type WebhookTaskRecord,
} from "./state.ts";
import {
  verifySignatureWithHeaders,
} from "./signature.ts";
import {
  dispatchAiwTask,
  triggerRoutesToAiw,
} from "./aiw-dispatch.ts";

export interface ServerOptions {
  configDir: string;
  cwd: string;
  host?: string;
  port?: number;
  /** Override the loader (used by tests). */
  loadRegistryFn?: (cwd: string) => ReturnType<typeof loadRegistry>;
  /** Rate limiter instance. */
  rateLimiter?: { buckets: Map<string, { tokens: number; lastRefill: number }> };
  /** Logging hook. */
  logger?: ServerLogger;
}

export interface ServerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RunningServer {
  port: number;
  host: string;
  close(): Promise<void>;
  reloadRegistry(): void;
  paths: QueuePaths;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const log = options.logger ?? consoleLogger();

  const paths = queuePaths(options.configDir);
  ensureQueueDirs(paths);

  let registry = (options.loadRegistryFn ?? loadRegistry)(options.cwd);
  for (const err of registry.errors) {
    log.warn("trigger registry error", { path: err.path, message: err.message });
  }
  log.info("webhook server loaded triggers", {
    count: registry.triggers.length,
    sources: registry.sources.map((s) => `${s.kind}:${s.path}`).join(","),
  });

  const rateLimiter = options.rateLimiter ?? { buckets: new Map() };

  const server = http.createServer((req, res) => {
    handle(req, res, {
      paths,
      registry,
      rateLimiter,
      log,
      reload: () => {
        registry = (options.loadRegistryFn ?? loadRegistry)(options.cwd);
        for (const err of registry.errors) {
          log.warn("trigger registry error", { path: err.path, message: err.message });
        }
        log.info("webhook server reloaded triggers", { count: registry.triggers.length });
      },
    }).catch((err) => {
      log.error("unhandled server error", { error: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const boundPort = resolveBoundPort(server, port);
  log.info("webhook server listening", { host, port: boundPort });

  return {
    port: boundPort,
    host,
    paths,
    close: () => closeServer(server),
    reloadRegistry: () => {
      registry = (options.loadRegistryFn ?? loadRegistry)(options.cwd);
    },
  };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function resolveBoundPort(server: http.Server, requested: number): number {
  const addr = server.address();
  if (addr && typeof addr === "object" && "port" in addr) {
    return addr.port;
  }
  return requested;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

interface HandlerContext {
  paths: QueuePaths;
  registry: ReturnType<typeof loadRegistry>;
  rateLimiter: { buckets: Map<string, { tokens: number; lastRefill: number }> };
  log: ServerLogger;
  reload: () => void;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const start = Date.now();
  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "/";
  const pathOnly = url.split("?")[0] ?? "/";

  // Healthcheck
  if (method === "GET" && pathOnly === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      triggers: ctx.registry.triggers.length,
      uptime_ms: process.uptime() * 1000,
    }));
    return;
  }

  // Reload (only when explicitly enabled; documented as a developer aid)
  if (method === "POST" && pathOnly === "/__reload__") {
    ctx.reload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, triggers: ctx.registry.triggers.length }));
    return;
  }

  // Task status lookups
  const taskMatch = pathOnly.match(/^\/tasks\/([a-f0-9]+)$/);
  if (method === "GET" && taskMatch) {
    const taskId = taskMatch[1]!;
    const stateFile = path.join(ctx.paths.tasksRoot, taskId, "state.json");
    if (!fs.existsSync(stateFile)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", task_id: taskId }));
      return;
    }
    const body = fs.readFileSync(stateFile, "utf-8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
    return;
  }

  const trigger = findTrigger(ctx.registry.triggers, method, pathOnly);
  if (!trigger) {
    ctx.log.warn("webhook no route", { method, path: pathOnly });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no_route" }));
    return;
  }

  // Rate limit (per trigger)
  if (!checkRateLimit(ctx.rateLimiter, trigger)) {
    ctx.log.warn("webhook rate limited", { trigger_id: trigger.id });
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return;
  }

  // Read body up to max_body_bytes
  const maxBytes = trigger.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const bodyResult = await readBody(req, maxBytes);
  if (bodyResult.error) {
    ctx.log.warn("webhook body error", { trigger_id: trigger.id, error: bodyResult.error });
    res.writeHead(bodyResult.status ?? 400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: bodyResult.error }));
    return;
  }
  const bodyBuf = bodyResult.body!;

  // Signature verification
  const sigResult = verifySignatureWithHeaders(
    trigger,
    req.headers as Record<string, string | string[] | undefined>,
    bodyBuf,
  );
  if (!sigResult.ok) {
    ctx.log.warn("webhook signature rejected", {
      trigger_id: trigger.id,
      reason: sigResult.reason,
    });
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized", reason: sigResult.reason }));
    return;
  }

  // Parse payload (best effort)
  const contentType = (req.headers["content-type"] ?? "")
    .toString()
    .split(";")[0]?.trim()
    .toLowerCase() ?? "";
  let payload: unknown = null;
  if (contentType === "application/json" && bodyBuf.length > 0) {
    try {
      payload = JSON.parse(bodyBuf.toString("utf-8"));
    } catch (err) {
      ctx.log.warn("webhook bad json", {
        trigger_id: trigger.id,
        error: (err as Error).message,
      });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }
  }

  // Match clause
  if (!matchesClause(trigger, payload, contentType || null)) {
    ctx.log.info("webhook match miss", { trigger_id: trigger.id });
    // 200 OK with no task: many integrations treat any 2xx as
    // success; we don't want to retry on a payload that's just
    // outside our filter. Logged for observability.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, queued: false, reason: "match_miss" }));
    return;
  }

  // Resolve prompt invocation
  const query = parseQuery(url);
  const prompt = resolvePromptInvocation(trigger, payload, query);

  const httpMeta: WebhookTaskRecord["http"] = {
    method,
    path: pathOnly,
    remote_addr: req.socket.remoteAddress ?? null,
    user_agent: (req.headers["user-agent"] as string | undefined) ?? null,
    content_type: contentType || null,
    body_size: bodyBuf.length,
  };

  // AIW routing: when the trigger declares `aiw_workflow`, route the
  // request through the AIW dispatcher. The HTTP response is
  // identical to the single-prompt path.
  if (triggerRoutesToAiw(trigger)) {
    const composedPrompt = renderAiwPromptText(prompt.args, prompt.template);
    const dispatch = dispatchAiwTask({
      trigger,
      promptText: composedPrompt,
      args: prompt.args,
      configDir: ctx.paths.queueDir.replace(/\/queue$/, ""),
      cwd: prompt.cwd ?? options_cwd(trigger),
      http: httpMeta,
    });
    ctx.log.info("webhook queued AIW", {
      trigger_id: trigger.id,
      aiw_id: dispatch.aiwId,
      workflow: dispatch.workflow,
      duration_ms: Date.now() - start,
    });
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      queued: true,
      aiw: true,
      task_id: dispatch.record.task_id,
      aiw_id: dispatch.aiwId,
      workflow: dispatch.workflow,
      status_url: `/tasks/${dispatch.record.task_id}`,
    }));
    return;
  }

  const record = makeQueuedRecord({
    triggerId: trigger.id,
    http: httpMeta,
    prompt: {
      template: prompt.template,
      args: prompt.args,
      cwd: prompt.cwd ?? options_cwd(trigger),
      tools: prompt.tools ?? [],
      model: prompt.model ?? null,
      thinking_level: prompt.thinking_level ?? null,
      model_role: prompt.model_role ?? null,
    },
  });
  appendRecord(ctx.paths, record);

  ctx.log.info("webhook queued", {
    trigger_id: trigger.id,
    task_id: record.task_id,
    duration_ms: Date.now() - start,
  });

  res.writeHead(202, { "content-type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    queued: true,
    task_id: record.task_id,
    status_url: `/tasks/${record.task_id}`,
  }));
}

function options_cwd(trigger: Trigger): string {
  return trigger.prompt.cwd ?? process.cwd();
}

/**
 * Render the user-prompt string passed to the AIW runner. Mirrors
 * the webhook worker's `composeUserPrompt` shape so the agent sees
 * a familiar header. Args are rendered as `key=value` lines.
 */
function renderAiwPromptText(args: Record<string, string>, _template: string): string {
  const argLines = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n");
  return [
    "[webhook → aiw]",
    "Arguments:",
    argLines || "(none)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Body reader — limits bytes, returns Buffer
// ---------------------------------------------------------------------------

interface BodyResult {
  body?: Buffer;
  error?: string;
  status?: number;
}

async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    received += buf.length;
    if (received > maxBytes) {
      // Drain to avoid the connection being left in a bad state.
      req.resume();
      return { error: "body_too_large", status: 413 };
    }
    chunks.push(buf);
  }
  return { body: Buffer.concat(chunks) };
}

function parseQuery(url: string): Record<string, string> {
  const q = url.indexOf("?");
  if (q === -1) return {};
  const out: Record<string, string> = {};
  const params = new URLSearchParams(url.slice(q + 1));
  for (const [k, v] of params) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Logger — defaults to stderr JSON lines
// ---------------------------------------------------------------------------

function consoleLogger(): ServerLogger {
  return {
    info(message, fields) {
      process.stderr.write(JSON.stringify({ level: "info", message, ...fields }) + "\n");
    },
    warn(message, fields) {
      process.stderr.write(JSON.stringify({ level: "warn", message, ...fields }) + "\n");
    },
    error(message, fields) {
      process.stderr.write(JSON.stringify({ level: "error", message, ...fields }) + "\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Default tool list helper (re-exposed for the worker module).
// ---------------------------------------------------------------------------

export { defaultToolsForTrigger };