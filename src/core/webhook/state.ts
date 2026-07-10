// state.ts — the canonical schemas for the webhook subsystem.
//
// Two TypeBox schemas are exported:
//   - TriggerSchema            the declarative trigger record loaded from
//                              webhooks.json (server-side config)
//   - WebhookTaskRecordSchema  the per-request task record appended to
//                              ~/.agentify/queue/tasks.jsonl and the
//                              state file at ~/.agentify/tasks/<id>/state.json
//
// The TypeBox schemas are the source of truth; the `Trigger` and
// `WebhookTaskRecord` TypeScript types are derived from them via `Static<>`.
//
// Status is a small state machine:
//   queued -> claimed -> running -> (done | error | aborted)
// The queue layer writes `queued`; the worker transitions through
// `claimed` and `running`; terminal statuses are written by the worker.
//
// The `prompt_args` field on the task record holds the JSON-serialized
// merged result of (trigger defaults, payload-derived args, URL-derived args).
// The order is documented in trigger-registry.ts.

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Trigger (server-side config; loaded from webhooks.json)
// ---------------------------------------------------------------------------

export const SignatureAlgorithmSchema = StringEnum(
  ["hmac-sha1", "hmac-sha256"] as const,
  { default: "hmac-sha256" },
);

export const HttpMethodSchema = StringEnum(
  ["GET", "POST", "PUT", "PATCH", "DELETE"] as const,
  { default: "POST" },
);

// One optional match clause; all top-level keys present must equal the
// payload value at the dotted path. Empty `match` matches everything
// (still subject to signature verification).
export const MatchClauseSchema = Type.Object(
  {
    // dotted paths into the JSON payload, e.g. "action", "issue.number".
    // The registry evaluates these against the parsed payload.
    equals: Type.Optional(Type.Record(Type.String(), Type.String())),
    // optional content-type hint (e.g. "application/json"). If set,
    // the request's Content-Type must match (exact, ignoring params).
    content_type: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// The prompt-template that the worker invokes. Mirrors the slash-command
// surface; the actual command is `prompt_template` (e.g. "/implement").
// `prompt_args_from_payload` maps dotted payload paths to argument names
// passed to the prompt; the value is interpolated as a string.
export const PromptInvocationSchema = Type.Object({
  template: Type.String({
    description: "Slash command or skill name, e.g. '/implement' or 'implement'.",
  }),
  args_from_payload: Type.Optional(Type.Record(Type.String(), Type.String())),
  args_from_query: Type.Optional(Type.Record(Type.String(), Type.String())),
  args_static: Type.Optional(Type.Record(Type.String(), Type.String())),
  cwd: Type.Optional(Type.String({
    description:
      "Project cwd override; default is the registry's project cwd.",
  })),
  tools: Type.Optional(Type.Array(Type.String(), {
    description:
      "Tool allowlist override. Default is read-only (no bash). Set " +
      "explicitly when the prompt needs write/edit or bash.",
  })),
  model: Type.Optional(Type.String({
    description: "Literal model id (e.g. 'anthropic/claude-opus-4-8'). If both `model` and `model_role` are set, `model` wins.",
  })),
  thinking_level: Type.Optional(Type.String()),
  /**
   * Named slot role hint (Phase 3). When set, the dispatched
   * session consumes the configured slot rather than a literal
   * model id. Falls back to "primary" when unset.
   */
  model_role: Type.Optional(Type.String({
    description: "Slot role: 'primary' | 'explorer' | 'lite'. Takes precedence over `model` when set.",
  })),
  // If set, the trigger fires a multi-phase AI Developer Workflow
  // instead of a single prompt. Mutually exclusive with `template`
  // for execution purposes — when `aiw_workflow` is set, the
  // template is informational only (used for logging).
  aiw_workflow: Type.Optional(StringEnum(
    ["plan_build", "plan_build_review", "plan_build_review_fix", "plan_build_review_ship"] as const,
  )),
  // Resolved at queue time by the registry; not user-set.
  // Listed here so the task record's `prompt.args` is always defined.
  args: Type.Optional(Type.Record(Type.String(), Type.String())),
}, { additionalProperties: false });

export const RateLimitSchema = Type.Object({
  // Simple in-memory token bucket. `requests` is the bucket size;
  // `window_seconds` is the refill window.
  requests: Type.Number({ minimum: 1 }),
  window_seconds: Type.Number({ minimum: 1 }),
}, { additionalProperties: false });

export const TriggerSchema = Type.Object({
  id: Type.String({
    description: "Unique trigger id within the registry (kebab-case).",
  }),
  path: Type.String({
    description:
      "URL path under the webhook server, e.g. '/webhooks/github/issue'. " +
      "Must start with '/'.",
  }),
  method: Type.Optional(HttpMethodSchema),
  signature_header: Type.String({
    description: "Request header carrying the signature, e.g. 'X-Hub-Signature-256'.",
  }),
  signature_algorithm: Type.Optional(SignatureAlgorithmSchema),
  // Secret comes from env var (NEVER committed to the JSON file).
  secret_env: Type.String({
    description: "Name of the env var holding the HMAC shared secret.",
  }),
  // Optional version prefix present in the signature header value.
  // Configurable per-trigger; the bare-hex default is used when this
  // field is omitted (and the engine also tolerates a leading
  // `sha256=` or `sha1=` for SHA-convention integrations).
  signature_prefix: Type.Optional(Type.String()),
  // The literal bytes prepended to the body before HMAC. The token
  // "{timestamp}" is substituted with the value of `timestamp_header`.
  // Default: raw body.
  signature_payload_prefix: Type.Optional(Type.String()),
  // Header carrying a Unix-seconds timestamp for replay protection.
  // When set, requests whose timestamp is older than
  // `timestamp_max_age_seconds` (default 300) are rejected.
  timestamp_header: Type.Optional(Type.String()),
  // Reject requests whose timestamp is older than this many seconds
  // (only enforced when timestamp_header is set). Default 300.
  timestamp_max_age_seconds: Type.Optional(Type.Number({ minimum: 1 })),
  match: Type.Optional(MatchClauseSchema),
  prompt: PromptInvocationSchema,
  // Per-trigger in-memory rate limit (token bucket).
  rate_limit: Type.Optional(RateLimitSchema),
  // Body size cap in bytes; default 1 MiB.
  max_body_bytes: Type.Optional(Type.Number({ minimum: 1 })),
  // Optional human description (used in /status output and logs).
  description: Type.Optional(Type.String()),
}, { additionalProperties: false });

export type Trigger = Static<typeof TriggerSchema>;

// ---------------------------------------------------------------------------
// Trigger file (webhooks.json)
// ---------------------------------------------------------------------------

export const WebhooksFileSchema = Type.Object({
  triggers: Type.Array(TriggerSchema),
}, { additionalProperties: false });

export type WebhooksFile = Static<typeof WebhooksFileSchema>;

// ---------------------------------------------------------------------------
// WebhookTaskRecord (per-request task)
// ---------------------------------------------------------------------------

export const TaskStatusSchema = StringEnum(
  [
    "queued",
    "claimed",
    "running",
    "done",
    "error",
    "aborted",
    "rejected",
  ] as const,
);

export const TaskStatus = {
  Queued: "queued",
  Claimed: "claimed",
  Running: "running",
  Done: "done",
  Error: "error",
  Aborted: "aborted",
  Rejected: "rejected",
} as const;

export const WebhookTaskRecordSchema = Type.Object({
  task_id: Type.String({ description: "16 hex chars; generated server-side." }),
  trigger_id: Type.String(),
  status: TaskStatusSchema,
  // ISO 8601 timestamps; one per status transition.
  received_at: Type.String(),
  claimed_at: Type.Optional(Type.String()),
  started_at: Type.Optional(Type.String()),
  ended_at: Type.Optional(Type.String()),
  // HTTP context (captured for debugging; not used by the worker).
  http: Type.Object({
    method: Type.String(),
    path: Type.String(),
    remote_addr: Type.Union([Type.String(), Type.Null()]),
    user_agent: Type.Union([Type.String(), Type.Null()]),
    content_type: Type.Union([Type.String(), Type.Null()]),
    body_size: Type.Number(),
  }),
  // The prompt invocation resolved at queue time (after env + payload merge).
  prompt: Type.Object({
    template: Type.String(),
    args: Type.Record(Type.String(), Type.String()),
    cwd: Type.String(),
    tools: Type.Array(Type.String()),
    model: Type.Union([Type.String(), Type.Null()]),
    thinking_level: Type.Union([Type.String(), Type.Null()]),
    /** Phase 3: slot role hint. */
    model_role: Type.Union([Type.String(), Type.Null()]),
  }),
  // Worker-side results (populated by the worker on completion).
  result: Type.Optional(Type.Object({
    turns: Type.Number(),
    cost_usd: Type.Union([Type.Number(), Type.Null()]),
    implement_result_path: Type.Union([Type.String(), Type.Null()]),
    error_message: Type.Union([Type.String(), Type.Null()]),
  })),
}, { additionalProperties: false });

export type WebhookTaskRecord = Static<typeof WebhookTaskRecordSchema>;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export function validateWebhooksFile(raw: unknown): ValidationResult<WebhooksFile> {
  if (!Value.Check(WebhooksFileSchema, raw)) {
    const errors = [...Value.Errors(WebhooksFileSchema, raw)].map(stringifyTypeboxError);
    return { ok: false, errors };
  }
  return { ok: true, value: raw as WebhooksFile };
}

export function validateTrigger(raw: unknown): ValidationResult<Trigger> {
  if (!Value.Check(TriggerSchema, raw)) {
    const errors = [...Value.Errors(TriggerSchema, raw)].map(stringifyTypeboxError);
    return { ok: false, errors };
  }
  return { ok: true, value: raw as Trigger };
}

function stringifyTypeboxError(e: unknown): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null) {
    const obj = e as Record<string, unknown>;
    const path = typeof obj.path === "string" ? `/${obj.path.replace(/^\//, "")}` : "";
    const message = (obj.message as string | undefined) ?? JSON.stringify(obj);
    return `${message}${path}`;
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// Default trigger factory — used by `webhooks.example.json` and tests.
// ---------------------------------------------------------------------------

export function defaultToolsForTrigger(trigger: Trigger): string[] {
  if (trigger.prompt.tools && trigger.prompt.tools.length > 0) {
    return trigger.prompt.tools;
  }
  // Safe default: read-only. The trigger's prompt template can opt in
  // to write/edit/bash by setting prompt.tools explicitly. This is the
  // "defense floor" for any externally-triggered agent.
  return ["read", "grep", "find", "ls"];
}

// ---------------------------------------------------------------------------
// generateTaskId — 16 hex chars; uses crypto.randomBytes.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";

export function generateTaskId(): string {
  return randomBytes(8).toString("hex");
}