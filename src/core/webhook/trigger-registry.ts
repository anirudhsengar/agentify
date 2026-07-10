// trigger-registry.ts — load and resolve webhook triggers.
//
// Loading precedence (project-level overrides user-level, mirroring
// `principles/13-agentic-layer.md` § "Pi Loading Precedence"):
//   1. <cwd>/.agentify/webhooks.json   (project)
//   2. ~/.agentify/webhooks.json       (user)
//
// The two files are merged with project triggers winning on id.
// Within a single file, path+method collisions are rejected at load.
//
// All triggers are validated against TriggerSchema at load time.
// Validation failures are reported in the registry's `errors` array
// so the server can log them but still serve the well-formed ones.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultToolsForTrigger,
  validateTrigger,
  validateWebhooksFile,
  type Trigger,
} from "./state.ts";

export interface RegistryLoadResult {
  triggers: Trigger[];
  errors: RegistryError[];
  sources: { path: string; kind: "project" | "user" | "missing" }[];
}

export interface RegistryError {
  path: string;
  message: string;
}

function userConfigDir(): string {
  return path.join(os.homedir(), ".agentify");
}

function projectConfigDir(cwd: string): string {
  return path.join(cwd, ".agentify");
}

function loadFromFile(
  filePath: string,
): { triggers: Trigger[]; errors: RegistryError[] } {
  if (!fs.existsSync(filePath)) {
    return { triggers: [], errors: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    return {
      triggers: [],
      errors: [{
        path: filePath,
        message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
  const result = validateWebhooksFile(raw);
  if (!result.ok) {
    return {
      triggers: [],
      errors: result.errors.map((m) => ({ path: filePath, message: m })),
    };
  }
  return { triggers: result.value.triggers, errors: [] };
}

export function loadRegistry(cwd: string): RegistryLoadResult {
  const projectPath = path.join(projectConfigDir(cwd), "webhooks.json");
  const userPath = path.join(userConfigDir(), "webhooks.json");

  const project = loadFromFile(projectPath);
  const user = loadFromFile(userPath);

  // Merge with project winning on id.
  const merged = new Map<string, Trigger>();
  for (const t of user.triggers) merged.set(t.id, t);
  for (const t of project.triggers) merged.set(t.id, t);

  // Path+method collisions (post-merge) are errors.
  const errors: RegistryError[] = [...user.errors, ...project.errors];
  const pathIndex = new Map<string, string>();
  for (const trigger of merged.values()) {
    const key = `${(trigger.method ?? "POST").toUpperCase()} ${trigger.path}`;
    const existing = pathIndex.get(key);
    if (existing) {
      errors.push({
        path: merged.get(trigger.id) === trigger ? projectPath : userPath,
        message:
          `path collision: ${key} is registered by both ` +
          `"${existing}" and "${trigger.id}"`,
      });
      // Remove the duplicate (project wins by being later in iteration,
      // so we drop the user one we already added).
      merged.delete(existing);
    }
    pathIndex.set(key, trigger.id);
  }

  const sources = [
    {
      path: projectPath,
      kind: (fs.existsSync(projectPath) ? "project" : "missing") as
        | "project" | "missing",
    },
    {
      path: userPath,
      kind: (fs.existsSync(userPath) ? "user" : "missing") as
        | "user" | "missing",
    },
  ];

  return { triggers: Array.from(merged.values()), errors, sources };
}

/**
 * Find a trigger that matches the given HTTP method + path.
 * Returns the trigger or null.
 */
export function findTrigger(
  registry: Trigger[],
  method: string,
  requestPath: string,
): Trigger | null {
  for (const trigger of registry) {
    const m = (trigger.method ?? "POST").toUpperCase();
    if (m !== method.toUpperCase()) continue;
    if (trigger.path !== requestPath) continue;
    return trigger;
  }
  return null;
}

/**
 * Evaluate a `match` clause against the parsed payload.
 * Returns true iff every key in `equals` is present in the payload
 * (dotted-path lookup) and matches the configured value exactly.
 */
export function matchesClause(
  trigger: Trigger,
  payload: unknown,
  contentType: string | null,
): boolean {
  const match = trigger.match;
  if (!match) return true;
  if (match.content_type) {
    const expected = match.content_type.toLowerCase();
    const actual = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (expected !== actual) return false;
  }
  if (match.equals) {
    if (payload === null || typeof payload !== "object") return false;
    for (const [key, expected] of Object.entries(match.equals)) {
      const actual = readDotted(payload as Record<string, unknown>, key);
      if (actual === undefined || String(actual) !== expected) return false;
    }
  }
  return true;
}

/**
 * Resolve the prompt invocation for a triggered request.
 * Args precedence (lowest -> highest):
 *   args_static -> args_from_query -> args_from_payload
 */
export interface ResolvedPromptInvocation {
  template: string;
  args: Record<string, string>;
  cwd?: string;
  tools: string[];
  model?: string;
  thinking_level?: string;
  /**
   * Slot role hint (Phase 3). When set, the dispatched session
   * consumes the configured slot. Takes precedence over
   * `model` when both are set.
   */
  model_role?: "primary" | "explorer" | "lite";
}

export function resolvePromptInvocation(
  trigger: Trigger,
  payload: unknown,
  query: Record<string, string>,
): ResolvedPromptInvocation {
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(trigger.prompt.args_static ?? {})) {
    args[k] = v;
  }
  for (const [k, path] of Object.entries(trigger.prompt.args_from_query ?? {})) {
    const value = query[path];
    if (value !== undefined) args[k] = value;
  }
  if (payload !== null && typeof payload === "object") {
    for (const [k, path] of Object.entries(trigger.prompt.args_from_payload ?? {})) {
      const value = stringifyPath(payload as Record<string, unknown>, path);
      if (value !== undefined) args[k] = value;
    }
  }
  return {
    template: trigger.prompt.template,
    args,
    cwd: trigger.prompt.cwd,
    tools: trigger.prompt.tools ?? defaultToolsForTrigger(trigger),
    model: trigger.prompt.model,
    thinking_level: trigger.prompt.thinking_level,
    model_role: normalizeModelRole(trigger.prompt.model_role),
  };
}

function normalizeModelRole(
  value: string | undefined,
): "primary" | "explorer" | "lite" | undefined {
  if (value === "primary" || value === "explorer" || value === "lite") return value;
  return undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function readDotted(obj: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function stringifyPath(obj: Record<string, unknown>, dotted: string): string | undefined {
  const v = readDotted(obj, dotted);
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // For objects/arrays, JSON-stringify so the prompt can embed the shape.
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Token-bucket rate limiter (in-memory, per trigger)
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** Returns true if the request is allowed. */
  allow(triggerId: string): boolean;
  /** For tests; reset all buckets. */
  reset(): void;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export function createRateLimiter(): RateLimiter {
  const buckets = new Map<string, Bucket>();
  return {
    allow(triggerId) {
      // Without a configured rate limit, always allow. The actual
      // limit check happens inside the per-trigger check below.
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
}

/**
 * Check the rate limit for a specific trigger. Returns true if the
 * request is allowed. Implemented as a token bucket that refills
 * linearly over the window.
 */
export function checkRateLimit(
  limiter: { buckets: Map<string, Bucket> },
  trigger: Trigger,
  now: number = Date.now(),
): boolean {
  if (!trigger.rate_limit) return true;
  const cfg = trigger.rate_limit;
  let bucket = limiter.buckets.get(trigger.id);
  if (!bucket) {
    bucket = { tokens: cfg.requests, lastRefill: now };
    limiter.buckets.set(trigger.id, bucket);
  }
  const elapsed = (now - bucket.lastRefill) / 1000;
  const refill = (cfg.requests / cfg.window_seconds) * elapsed;
  bucket.tokens = Math.min(cfg.requests, bucket.tokens + refill);
  bucket.lastRefill = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Re-export validateTrigger for use by the server.
// ---------------------------------------------------------------------------

export { validateTrigger };