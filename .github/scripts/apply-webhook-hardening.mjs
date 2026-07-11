import * as fs from "node:fs";

function replaceOnce(file, label, before, after) {
  const source = fs.readFileSync(file, "utf-8");
  if (!source.includes(before)) throw new Error(`patch '${label}' did not match ${file}`);
  fs.writeFileSync(file, source.replace(before, after));
}

replaceOnce(
  "src/core/webhook/state.ts",
  "read-only trigger tools description",
  `      "Tool allowlist override. Default is read-only (no bash). Set " +
      "explicitly when the prompt needs write/edit or bash.",`,
  `      "Optional read-only tool subset. Webhook-dispatched sessions reject " +
      "shell and mutation tools before runtime dispatch.",`,
);

replaceOnce(
  "src/core/webhook/state.ts",
  "replay schema fields",
  `  timestamp_max_age_seconds: Type.Optional(Type.Number({ minimum: 1 })),
  match: Type.Optional(MatchClauseSchema),`,
  `  timestamp_max_age_seconds: Type.Optional(Type.Number({ minimum: 1 })),
  // Optional provider delivery ID header. When present, it is preferred over
  // the signature digest as the replay-cache identity.
  delivery_id_header: Type.Optional(Type.String()),
  // TTL for accepted delivery identities. Defaults to the timestamp max age,
  // then to 300 seconds.
  replay_window_seconds: Type.Optional(Type.Number({ minimum: 1 })),
  match: Type.Optional(MatchClauseSchema),`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "security imports",
  `import {
  dispatchAiwTask,
  triggerRoutesToAiw,
} from "./aiw-dispatch.ts";`,
  `import {
  dispatchAiwTask,
  triggerRoutesToAiw,
} from "./aiw-dispatch.ts";
import {
  allowFixedWindowRequest,
  bearerToken,
  constantTimeTokenEquals,
  createFixedWindowLimiter,
  createReplayCache,
  isLoopbackHost,
  isReplay,
  recordReplayKey,
  replayCacheKey,
  type FixedWindowLimiter,
  type FixedWindowRateLimit,
  type ReplayCache,
} from "./http-security.ts";`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "server options",
  `  /** Rate limiter instance. */
  rateLimiter?: { buckets: Map<string, { tokens: number; lastRefill: number }> };
  /** Logging hook. */
  logger?: ServerLogger;`,
  `  /** Authenticated per-trigger rate limiter instance. */
  rateLimiter?: { buckets: Map<string, { tokens: number; lastRefill: number }> };
  /** Coarse unauthenticated per-address limit. Set false to disable. */
  preAuthRateLimit?: FixedWindowRateLimit | false;
  preAuthLimiter?: FixedWindowLimiter;
  replayCache?: ReplayCache;
  /** Enable POST /__reload__. Requires loopback host and adminToken. */
  enableReloadEndpoint?: boolean;
  adminToken?: string;
  /** Logging hook. */
  logger?: ServerLogger;`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "defaults",
  `const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB`,
  `const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_PRE_AUTH_RATE_LIMIT: FixedWindowRateLimit = {
  requests: 120,
  windowSeconds: 60,
};`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "startup security configuration",
  `  const log = options.logger ?? consoleLogger();

  const paths = queuePaths(options.configDir);`,
  `  const log = options.logger ?? consoleLogger();
  const enableReloadEndpoint = options.enableReloadEndpoint ?? false;
  if (enableReloadEndpoint) {
    if (!isLoopbackHost(host)) {
      throw new Error("webhook reload endpoint can only be enabled on a loopback host");
    }
    if (!options.adminToken) {
      throw new Error("webhook reload endpoint requires adminToken");
    }
  }

  const paths = queuePaths(options.configDir);`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "security state",
  `  const rateLimiter = options.rateLimiter ?? { buckets: new Map() };

  const server = http.createServer((req, res) => {`,
  `  const rateLimiter = options.rateLimiter ?? { buckets: new Map() };
  const preAuthRateLimit = options.preAuthRateLimit === false
    ? null
    : options.preAuthRateLimit ?? DEFAULT_PRE_AUTH_RATE_LIMIT;
  const preAuthLimiter = options.preAuthLimiter ?? createFixedWindowLimiter();
  const replayCache = options.replayCache ?? createReplayCache();

  const server = http.createServer((req, res) => {`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "handler context construction",
  `      rateLimiter,
      log,
      reload: () => {`,
  `      rateLimiter,
      preAuthRateLimit,
      preAuthLimiter,
      replayCache,
      enableReloadEndpoint,
      adminToken: options.adminToken ?? null,
      log,
      reload: () => {`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "handler context type",
  `  rateLimiter: { buckets: Map<string, { tokens: number; lastRefill: number }> };
  log: ServerLogger;
  reload: () => void;`,
  `  rateLimiter: { buckets: Map<string, { tokens: number; lastRefill: number }> };
  preAuthRateLimit: FixedWindowRateLimit | null;
  preAuthLimiter: FixedWindowLimiter;
  replayCache: ReplayCache;
  enableReloadEndpoint: boolean;
  adminToken: string | null;
  log: ServerLogger;
  reload: () => void;`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "reload route",
  `  // Reload (only when explicitly enabled; documented as a developer aid)
  if (method === "POST" && pathOnly === "/__reload__") {
    ctx.reload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, triggers: ctx.registry.triggers.length }));
    return;
  }`,
  `  // Reload is unavailable unless explicitly enabled on loopback with an
  // administrator token. Disabled management routes are indistinguishable
  // from unknown routes.
  if (method === "POST" && pathOnly === "/__reload__") {
    if (!ctx.enableReloadEndpoint || ctx.adminToken === null) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (!constantTimeTokenEquals(bearerToken(req.headers), ctx.adminToken)) {
      ctx.log.warn("webhook reload authentication rejected", {
        remote_addr: req.socket.remoteAddress ?? null,
      });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    ctx.reload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, triggers: ctx.registry.triggers.length }));
    return;
  }`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "sanitized task status",
  `    const body = fs.readFileSync(stateFile, "utf-8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);`,
  `    try {
      const record = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as Partial<WebhookTaskRecord>;
      const publicStatus = {
        task_id: typeof record.task_id === "string" ? record.task_id : taskId,
        status: typeof record.status === "string" ? record.status : "unknown",
        received_at: record.received_at ?? null,
        claimed_at: record.claimed_at ?? null,
        started_at: record.started_at ?? null,
        ended_at: record.ended_at ?? null,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(publicStatus));
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_task_state", task_id: taskId }));
    }`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "replace pre-signature trigger limiter",
  `  // Rate limit (per trigger)
  if (!checkRateLimit(ctx.rateLimiter, trigger)) {
    ctx.log.warn("webhook rate limited", { trigger_id: trigger.id });
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return;
  }

  // Read body up to max_body_bytes`,
  `  // Coarse unauthenticated limiter. This bucket is keyed by remote address
  // and is separate from the authenticated per-trigger quota.
  if (ctx.preAuthRateLimit) {
    const remoteKey = req.socket.remoteAddress ?? "unknown";
    if (!allowFixedWindowRequest(ctx.preAuthLimiter, remoteKey, ctx.preAuthRateLimit)) {
      ctx.log.warn("webhook pre-auth rate limited", { remote_addr: remoteKey });
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "pre_auth_rate_limited" }));
      return;
    }
  }

  // Read body up to max_body_bytes`,
);

replaceOnce(
  "src/core/webhook/server.ts",
  "generic signature response and post-auth gates",
  `    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized", reason: sigResult.reason }));
    return;
  }

  // Parse payload (best effort)`,
  `    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const acceptedReplayKey = replayCacheKey(trigger, req.headers);
  if (isReplay(ctx.replayCache, acceptedReplayKey)) {
    ctx.log.warn("webhook replay rejected", { trigger_id: trigger.id });
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "replay_detected" }));
    return;
  }

  // Only authenticated, non-replayed requests consume the trigger bucket.
  if (!checkRateLimit(ctx.rateLimiter, trigger)) {
    ctx.log.warn("webhook rate limited", { trigger_id: trigger.id });
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return;
  }
  recordReplayKey(
    ctx.replayCache,
    acceptedReplayKey,
    trigger.replay_window_seconds ?? trigger.timestamp_max_age_seconds ?? 300,
  );

  // Parse payload (best effort)`,
);

console.log("webhook HTTP hardening integrated");
