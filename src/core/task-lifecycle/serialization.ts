import * as crypto from "node:crypto";
import {
  MAX_TASK_COMMENT_BYTES,
  TASK_STATE_COMMENT_MARKER,
  type DurableTaskState,
} from "./contracts.ts";
import { TaskLifecycleError } from "./state-machine.ts";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const SECRET_PATTERN = /(?:\bgh[opsu]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|authorization|credential|password|secret|token)\s*[:=]\s*[^\s,;]+)/gi;

function asJson(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TaskLifecycleError("invalid_input", "task JSON cannot contain a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(asJson);
  if (typeof value === "object") {
    const output: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = asJson(child);
    }
    return output;
  }
  throw new TaskLifecycleError("invalid_input", `task JSON contains unsupported ${typeof value}`);
}

export function canonicalTaskJson(value: unknown): string {
  return JSON.stringify(asJson(value));
}

export function sha256TaskHex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function digestTaskValue(value: unknown): string {
  return sha256TaskHex(canonicalTaskJson(value));
}

export function sortedTaskStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeTaskPath(value: string, label = "task path"): string {
  const portable = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    portable.length === 0
    || portable.length > 1_024
    || portable.startsWith("/")
    || /^[A-Za-z]:(?:\/|$)/u.test(portable)
    || portable.includes("\0")
    || /[\r\n]/.test(portable)
  ) {
    throw new TaskLifecycleError("invalid_input", `${label} must be one bounded repository-relative path`);
  }
  const segments = portable.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TaskLifecycleError("invalid_input", `${label} escapes or ambiguously addresses the repository`);
  }
  return segments.join("/");
}

export function normalizeTaskPaths(
  values: ReadonlyArray<string>,
  label = "task path",
): string[] {
  return sortedTaskStrings(values.map((value) => normalizeTaskPath(value, label)));
}

export function pathWithinTaskScope(candidate: string, scope: string): boolean {
  const file = normalizeTaskPath(candidate, "candidate path");
  const root = normalizeTaskPath(scope, "scope path");
  return file === root || file.startsWith(`${root}/`);
}

export function taskSlug(value: string, maximum = 48): string {
  const bounded = Math.max(1, Math.min(96, maximum));
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, bounded)
    .replace(/-+$/g, "");
  return normalized || "task";
}

export function redactTaskText(value: string, maximum = 4_000): string {
  const normalized = String(value)
    .replaceAll("\0", "")
    .replace(/\r\n?/g, "\n")
    .replace(SECRET_PATTERN, "[REDACTED]")
    .replace(/\n\s*at (?:async )?[^\n]+/g, "")
    .trim();
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length <= maximum) return normalized;
  return `${bytes.subarray(0, Math.max(0, maximum - 20)).toString("utf8")}…[truncated]`;
}

export function computeTaskStateDigest(state: DurableTaskState): string {
  const value = structuredClone(state) as DurableTaskState;
  value.current_digest = "";
  return digestTaskValue(value);
}

export function renderTaskStateComment(state: DurableTaskState): string {
  const payload = Buffer.from(canonicalTaskJson(state), "utf8").toString("base64url");
  const body = [
    `<!-- ${TASK_STATE_COMMENT_MARKER} task=${state.task_id} revision=${state.revision} digest=${state.current_digest} -->`,
    "Agentify machine-owned task state. Labels are projections only; do not edit this record manually.",
    "",
    "```agentify-task-state",
    payload,
    "```",
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_TASK_COMMENT_BYTES) {
    throw new TaskLifecycleError("invalid_input", "serialized task state exceeds the bounded GitHub comment size");
  }
  return body;
}

export function parseTaskStateComment(body: string): unknown {
  if (Buffer.byteLength(body, "utf8") > MAX_TASK_COMMENT_BYTES) {
    throw new TaskLifecycleError("corrupt_state", "task state comment exceeds the bounded size");
  }
  const marker = new RegExp(`<!-- ${TASK_STATE_COMMENT_MARKER.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")} task=([A-Za-z0-9._:-]+) revision=(\\d+) digest=([0-9a-f]{64}) -->`).exec(body);
  const payload = /```agentify-task-state\n([A-Za-z0-9_-]+)\n```/.exec(body);
  if (!marker || !payload) {
    throw new TaskLifecycleError("corrupt_state", "machine-owned task state marker or payload is missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload[1], "base64url").toString("utf8"));
  } catch {
    throw new TaskLifecycleError("corrupt_state", "machine-owned task state payload is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TaskLifecycleError("corrupt_state", "machine-owned task state payload is not an object");
  }
  const state = parsed as Record<string, unknown>;
  if (state.task_id !== marker[1] || state.revision !== Number(marker[2]) || state.current_digest !== marker[3]) {
    throw new TaskLifecycleError("corrupt_state", "task state marker does not match its typed payload");
  }
  return parsed;
}
