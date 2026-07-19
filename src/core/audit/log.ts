// JSONL observability log writer.
//
// One file per `agentify` run, at
//   <configDir>/logs/agentify/<ISO-timestamp>-<6-char-sha256(cwd)>.jsonl
// The hash prefix prevents collisions when multiple projects are
// audited in the same minute. The log is user-global (not project-
// local) so it survives across projects and is never auto-committed.
//
// Lifecycle: open `fs.createWriteStream` on `run_start`; write one
// JSON line per event with serialize → redact → truncate; flush +
// close on `run_end` / `user_abort`. The stream is append-only and
// crash-safe (a crash mid-run preserves everything written so far).
//
// Event types (see AgentifyEventType below):
//   run_start, session_event, map_written, gap_detected,
//   gap_closed, subagent_spawned, user_abort, session_end, run_end.
// The boot snapshot on run_start records the system prompt's
// sha256 (not the prompt itself) plus the safe env key names.
// Coverage transitions (gap_detected / gap_closed) are derived by
// diffing consecutive map_written events in the audit session.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// Truncation limits applied before writing to the JSONL log.
// Truncation is always paired with a marker (e.g. "[TRUNCATED]") —
// we never silently drop bytes.
const MAX_TEXT_FIELD = 32_000;

// Redaction patterns. Best-effort, not a security boundary.
const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-ant-[A-Za-z0-9_-]+/g, replacement: "[REDACTED:api-key]" },
  { pattern: /sk-or-[A-Za-z0-9_-]+/g, replacement: "[REDACTED:api-key]" },
  { pattern: /sk_live_[A-Za-z0-9]+/g, replacement: "[REDACTED:stripe-live]" },
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED:api-key]" },
  { pattern: /ghp_[A-Za-z0-9]+/g, replacement: "[REDACTED:github-pat]" },
  { pattern: /github_pat_[A-Za-z0-9_]+/g, replacement: "[REDACTED:github-pat]" },
  // GitHub fine-grained PAT: github_pat_11<20 alnum>_<alnum>. The
  // legacy pattern above (github_pat_...) catches both, but the
  // fine-grained format benefits from a tighter regex to reduce
  // false positives.
  { pattern: /github_pat_11[A-Z0-9]{20,}_[A-Za-z0-9]+/g, replacement: "[REDACTED:github-fine-grained-pat]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED:aws-access-key]" },
  { pattern: /(?:aws[_\-.]?(?:secret)?[_\-.]?access[_\-.]?key)['"\s:=]+([A-Za-z0-9/+=]{40})\b/gi, replacement: "$1 => [REDACTED:aws-secret-key]" },
  { pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: "[REDACTED:jwt]" },
  {
    pattern: /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  { pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9_.-]+/g, replacement: "Authorization: Bearer [REDACTED]" },
  { pattern: /Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/g, replacement: "Authorization: Basic [REDACTED]" },
];

export type AgentifyEventType =
  | "agentify.run_start"
  | "agentify.session_event"
  | "agentify.file_written"
  | "agentify.map_written"
  | "agentify.gap_detected"
  | "agentify.gap_closed"
  | "agentify.subagent_spawned"
  | "agentify.session_end"
  | "agentify.user_abort"
  | "agentify.run_end"
  | "agentify.reserve_exhausted_for"
  | "agentify.target_path_external";

export type AgentifyEvent = {
  ts: string;
  run_id: string;
  event: AgentifyEventType;
  payload: unknown;
};

export type RunStartPayload = {
  cwd: string;
  args: string;
  model: string;
  thinking_level: string;
  agentify_version: string;
  sdk_version: string;
  system_prompt_sha256: string;
  system_prompt_path: string;
  tool_allowlist: string[];
  resume_from?: string;
  gap_dimensions?: string[];
};

export type SessionEventPayload = {
  pi_event_type: string;
  event: unknown;
};

export type FileWrittenPayload = {
  path: string;
  agent_name: string;
  size_bytes: number;
};

export type MapWrittenPayload = {
  path: string;
  size_bytes: number;
  coverage_summary: {
    covered: string[];
    gap: string[];
    total: number;
  };
  gap_warning: string[] | null;
};

export type SubagentSpawnedPayload = {
  tool_name: string;
  details: unknown;
  is_error: boolean;
};

export type SessionEndPayload = {
  duration_ms: number;
  was_aborted: boolean;
  status: "success" | "gap_unresolved" | "partial" | "aborted" | "error";
};

export type RunEndPayload = {
  duration_ms: number;
  exit_code: number;
  files_written: number;
  total_turns: number;
  status: "success" | "gap_unresolved" | "partial" | "aborted" | "error";
  error_message?: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_cost_usd: number;
  mean_turn_latency_ms: number | null;
  coverage?: {
    covered: number;
    gap: number;
    total: number;
  };
  agents_md_path?: string | null;
};

function hashCwd(cwd: string): string {
  return crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 6);
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeFilename(ts: string): string {
  return ts.replace(/[:.]/g, "-");
}

// Per-process counter so two runs in the same second (rare, but
// possible if a user starts two audits quickly) don't collide
// on the same log file. Hash of cwd is already in the name; this
// counter is a final tiebreaker.
let runCounter = 0;

function makeLogPath(cwd: string, configDir: string): string {
  const logDir = path.join(configDir, "logs", "agentify");
  fs.mkdirSync(logDir, { recursive: true });
  const counter = String(runCounter++).padStart(2, "0");
  return path.join(logDir, `${safeFilename(nowIso())}-${hashCwd(cwd)}-${counter}.jsonl`);
}

function redact(text: string): string {
  let out = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}[TRUNCATED: ${omitted} bytes omitted]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizeSessionEvent(event: unknown): unknown {
  if (!isRecord(event)) return event;
  const type = typeof event.type === "string" ? event.type : "unknown";
  if (type === "turn_end" || type === "agent_end") return { type };
  if (type === "tool_execution_start") {
    return { type, toolName: event.toolName ?? event.tool_name ?? "unknown", toolCallId: event.toolCallId ?? null };
  }
  if (type === "tool_execution_end") {
    const result = isRecord(event.result) ? event.result : {};
    const content = Array.isArray(result.content) ? result.content[0] : undefined;
    const text = isRecord(content) && typeof content.text === "string" ? truncate(content.text, 2_000) : null;
    return {
      type,
      toolName: event.toolName ?? event.tool_name ?? "unknown",
      toolCallId: event.toolCallId ?? null,
      isError: result.isError === true,
      resultText: text,
    };
  }
  if (type === "message_end") {
    const message = isRecord(event.message) ? event.message : {};
    return { type, role: message.role ?? null, stopReason: message.stopReason ?? null, usage: message.usage ?? null };
  }
  return { type };
}

function serializeEvent(event: AgentifyEvent): string {
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(event.payload) ?? '"[unserializable]"';
  } catch {
    payloadJson = '"[unserializable]"';
  }
  payloadJson = redact(payloadJson);
  payloadJson = truncate(payloadJson, MAX_TEXT_FIELD);
  return JSON.stringify({
    ts: event.ts,
    run_id: event.run_id,
    event: event.event,
    payload: payloadJson,
  });
}

export class AgentifyLog {
  private readonly stream: fs.WriteStream;
  private readonly runIdLocal: string;
  private filesWritten = 0;
  private turns = 0;
  // Track the last coverage summary so map_written events can
  // diff against it and emit gap_detected / gap_closed transitions
  // (fire on transitions, not on every read).
  private lastCoverageCovered: Set<string> | null = null;
  private readonly startTime: number;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheWriteTokens = 0;
  private totalCostUsd = 0;
  private currentTurnStart: number | null = null;
  private turnLatencies: number[] = [];

  constructor(opts: { cwd: string; configDir: string }) {
    this.runIdLocal = `agentify-${safeFilename(nowIso())}-${hashCwd(opts.cwd)}`;
    this.stream = fs.createWriteStream(makeLogPath(opts.cwd, opts.configDir), { flags: "a" });
    this.startTime = Date.now();
  }

  get runId(): string {
    return this.runIdLocal;
  }

  get logPath(): string {
    return this.stream.path.toString();
  }

  get costUsd(): number {
    return this.totalCostUsd;
  }

  get inputTokens(): number {
    return this.totalInputTokens;
  }

  get outputTokens(): number {
    return this.totalOutputTokens;
  }

  get cacheReadTokens(): number {
    return this.totalCacheReadTokens;
  }

  get cacheWriteTokens(): number {
    return this.totalCacheWriteTokens;
  }

  private write(event: AgentifyEventType, payload: unknown): void {
    const line = serializeEvent({
      ts: nowIso(),
      run_id: this.runIdLocal,
      event,
      payload,
    });
    this.stream.write(`${line}\n`);
  }

  runStart(payload: RunStartPayload): void {
    this.write("agentify.run_start", payload);
  }

  sessionEvent(payload: SessionEventPayload): void {
    // Streaming updates repeat the complete partial assistant message on every
    // token. Persisting them makes a single long tool call produce hundreds of
    // megabytes of cumulative duplicate content. Message boundaries and tool
    // execution events retain the durable audit trail without that growth.
    if (payload.pi_event_type === "message_update") return;
    this.write("agentify.session_event", { ...payload, event: summarizeSessionEvent(payload.event) });
  }

  fileWritten(payload: FileWrittenPayload): void {
    this.filesWritten += 1;
    this.write("agentify.file_written", payload);
  }

  mapWritten(payload: MapWrittenPayload): void {
    this.write("agentify.map_written", payload);
    // Compute coverage transitions against the previous map write.
    // A dimension "transitions" if it changes covered↔gap state.
    const nowCovered = new Set(payload.coverage_summary.covered);
    if (this.lastCoverageCovered !== null) {
      for (const dim of nowCovered) {
        if (!this.lastCoverageCovered.has(dim)) {
          this.write("agentify.gap_closed", { dimension: dim });
        }
      }
      for (const dim of this.lastCoverageCovered) {
        if (!nowCovered.has(dim)) {
          this.write("agentify.gap_detected", { dimension: dim });
        }
      }
    }
    this.lastCoverageCovered = nowCovered;
  }

  subagentSpawned(payload: SubagentSpawnedPayload): void {
    this.write("agentify.subagent_spawned", payload);
  }

  reserveExhausted(dimension: string, count: number, cap: number): void {
    this.write("agentify.reserve_exhausted_for", { dimension, count, cap });
  }

  targetPathExternal(targetPath: string): void {
    this.write("agentify.target_path_external", { target_path: targetPath });
  }

  incrementTurns(): void {
    this.turns += 1;
  }

  /**
   * Record a turn's start timestamp. Called on user message_start.
   * If a previous turn was open, its duration is finalized first.
   */
  recordTurnStart(): void {
    if (this.currentTurnStart !== null) {
      // Previous turn still open (no message_end received). Close it.
      const duration = Date.now() - this.currentTurnStart;
      this.turnLatencies.push(duration);
    }
    this.currentTurnStart = Date.now();
  }

  /**
   * Record a turn's end (assistant message_end). Finalizes the latency
   * for the current turn. Optionally accepts the message's usage to
   * accumulate token totals.
   */
  recordTurnEnd(usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  }): void {
    if (this.currentTurnStart !== null) {
      const duration = Date.now() - this.currentTurnStart;
      this.turnLatencies.push(duration);
      this.currentTurnStart = null;
    }
    if (usage) {
      this.totalInputTokens += usage.input ?? 0;
      this.totalOutputTokens += usage.output ?? 0;
      this.totalCacheReadTokens += usage.cacheRead ?? 0;
      this.totalCacheWriteTokens += usage.cacheWrite ?? 0;
      this.totalCostUsd += usage.cost?.total ?? 0;
    }
  }

  sessionEnd(payload: SessionEndPayload): void {
    this.write("agentify.session_end", payload);
  }

  userAbort(payload: { at_duration_ms: number; at_event_count: number }): void {
    this.write("agentify.user_abort", payload);
  }

  // Explicitly emit a gap transition event. Used when the main agent
  // dispatches a gap_filler sub-agent and wants to record the
  // attempt's outcome in the log.
  gapTransition(payload: { dimension: string; from: "covered" | "gap"; to: "covered" | "gap"; source: string }): void {
    const event: AgentifyEventType = payload.to === "covered" ? "agentify.gap_closed" : "agentify.gap_detected";
    this.write(event, payload);
  }

  runEnd(
    payload: Omit<
      RunEndPayload,
      | "duration_ms"
      | "files_written"
      | "total_turns"
      | "total_input_tokens"
      | "total_output_tokens"
      | "total_cache_read_tokens"
      | "total_cache_write_tokens"
      | "total_cost_usd"
      | "mean_turn_latency_ms"
    >,
  ): void {
    // Close any still-open turn so its latency counts.
    if (this.currentTurnStart !== null) {
      this.turnLatencies.push(Date.now() - this.currentTurnStart);
      this.currentTurnStart = null;
    }
    const meanLatency =
      this.turnLatencies.length > 0
        ? this.turnLatencies.reduce((a, b) => a + b, 0) / this.turnLatencies.length
        : null;
    this.write("agentify.run_end", {
      ...payload,
      duration_ms: Date.now() - this.startTime,
      files_written: this.filesWritten,
      total_turns: this.turns,
      total_input_tokens: this.totalInputTokens,
      total_output_tokens: this.totalOutputTokens,
      total_cache_read_tokens: this.totalCacheReadTokens,
      total_cache_write_tokens: this.totalCacheWriteTokens,
      total_cost_usd: this.totalCostUsd,
      mean_turn_latency_ms: meanLatency === null ? null : Math.round(meanLatency),
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}
