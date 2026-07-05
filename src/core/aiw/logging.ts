// logging.ts — the AIW logging facade.
//
// Two outputs per event:
//   1. `events.jsonl` (append-only, machine-readable) — for replay
//      and downstream tooling.
//   2. `execution.log` (human-readable) — for `tail -f` and the CLI's
//      `agentify aiw logs` subcommand.
//
// The facade is the single place AIW phase code calls; the rest of
// the file system layout is hidden behind `paths.ts`.

import * as fs from "node:fs";
import {
  appendAiwEvent,
  appendExecutionLog,
  phaseAgentDir,
  writePhasePrompt,
  type AiwPaths,
} from "./paths.ts";
import type { AiwState, PhaseName } from "./state.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type AiwLogLevel = "info" | "warn" | "error" | "debug";

export interface AiwLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Logger that writes to both events.jsonl and execution.log.
 */
export function makeAiwLogger(paths: AiwPaths, source?: string): AiwLogger {
  const tag = source ? `[${source}]` : "";
  return {
    info(message, fields) {
      appendAiwEvent(paths, { kind: "system_log", fields: { level: "info", message, ...(fields ?? {}) } });
      appendExecutionLog(paths, `${tag} ${message}${fields ? " " + JSON.stringify(fields) : ""}`);
    },
    warn(message, fields) {
      appendAiwEvent(paths, { kind: "system_log", fields: { level: "warn", message, ...(fields ?? {}) } });
      appendExecutionLog(paths, `${tag} WARN: ${message}${fields ? " " + JSON.stringify(fields) : ""}`);
    },
    error(message, fields) {
      appendAiwEvent(paths, { kind: "system_log", fields: { level: "error", message, ...(fields ?? {}) } });
      appendExecutionLog(paths, `${tag} ERROR: ${message}${fields ? " " + JSON.stringify(fields) : ""}`);
    },
  };
}

/**
 * A no-op logger for tests that don't care about output.
 */
export function nullAiwLogger(): AiwLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// ---------------------------------------------------------------------------
// Phase lifecycle events
// ---------------------------------------------------------------------------

export function logPhaseStart(
  paths: AiwPaths,
  state: AiwState,
  phase: PhaseName,
): void {
  appendAiwEvent(paths, {
    kind: "phase_started",
    phase,
    fields: {
      aiw_id: state.aiw_id,
      workflow: state.workflow,
      branch: state.branch_name,
      worktree: state.worktree_path,
    },
  });
  appendExecutionLog(paths, `phase ${phase} started`);
}

export function logPhaseEnd(
  paths: AiwPaths,
  state: AiwState,
  phase: PhaseName,
  result: {
    status: "done" | "error" | "skipped";
    costUsd: number | null;
    turns: number;
    errorMessage?: string;
  },
): void {
  appendAiwEvent(paths, {
    kind: "phase_ended",
    phase,
    fields: {
      aiw_id: state.aiw_id,
      status: result.status,
      cost_usd: result.costUsd,
      turns: result.turns,
      error_message: result.errorMessage ?? null,
    },
  });
  const costStr = result.costUsd !== null ? `$${result.costUsd.toFixed(4)}` : "$-.--";
  appendExecutionLog(
    paths,
    `phase ${phase} ${result.status} (${costStr}, ${result.turns} turns)` +
      (result.errorMessage ? ` — ${result.errorMessage}` : ""),
  );
}

export function logAiwEvent(
  paths: AiwPaths,
  state: AiwState,
  phase: PhaseName,
  event: AgentSessionEvent,
): void {
  // Write a one-line summary to events.jsonl. We avoid
  // JSON.stringify-ing the whole event (some are large) by extracting
  // a compact summary.
  const summary = summarizeAgentEvent(event);
  if (!summary) return;
  appendAiwEvent(paths, {
    kind: "agent_event",
    phase,
    fields: {
      aiw_id: state.aiw_id,
      ...summary,
    },
  });

  // For tool calls, also append to execution.log so a human tailing
  // the log sees what's happening.
  if (summary.event_kind === "tool_execution_start") {
    appendExecutionLog(paths, `  ${phase}: ${summary.tool_name} ${truncate(String(summary.tool_input ?? ""), 120)}`);
  } else if (summary.event_kind === "agent_end") {
    appendExecutionLog(
      paths,
      `  ${phase}: agent_end cost=${summary.cost_total ?? "?"} turns=${summary.turns ?? "?"}`,
    );
  }
}

function summarizeAgentEvent(event: AgentSessionEvent): Record<string, unknown> | null {
  const e = event as unknown as Record<string, unknown>;
  const type = typeof e["type"] === "string" ? (e["type"] as string) : null;
  if (!type) return null;
  switch (type) {
    case "tool_execution_start": {
      const toolName = (e["toolName"] as string | undefined) ?? (e["tool_name"] as string | undefined) ?? "unknown";
      const input = e["input"] ?? e["args"] ?? null;
      return {
        event_kind: type,
        tool_name: toolName,
        tool_input: input ? safeStringify(input, 1024) : null,
      };
    }
    case "tool_execution_end": {
      const toolName = (e["toolName"] as string | undefined) ?? "unknown";
      const isError = Boolean(e["isError"]);
      const result = e["result"];
      return {
        event_kind: type,
        tool_name: toolName,
        is_error: isError,
        result_preview: result ? safeStringify(result, 256) : null,
      };
    }
    case "message_end": {
      const message = (e["message"] as Record<string, unknown> | undefined) ?? null;
      const usage = (message?.["usage"] as Record<string, unknown> | undefined) ?? null;
      const cost = (usage?.["cost"] as Record<string, unknown> | undefined) ?? null;
      return {
        event_kind: type,
        role: message?.["role"] ?? "unknown",
        cost_total: typeof cost?.["total"] === "number" ? cost["total"] : null,
        tokens_input: usage?.["input"] ?? null,
        tokens_output: usage?.["output"] ?? null,
      };
    }
    case "agent_end": {
      const usage = (e["usage"] as Record<string, unknown> | undefined) ?? null;
      const cost = (usage?.["cost"] as Record<string, unknown> | undefined) ?? null;
      return {
        event_kind: type,
        cost_total: typeof cost?.["total"] === "number" ? cost["total"] : null,
        turns: typeof e["turns"] === "number" ? e["turns"] : null,
        will_retry: Boolean(e["willRetry"]),
      };
    }
    case "turn_start":
    case "turn_end":
      return { event_kind: type };
    default:
      // Suppress noisy stream-of-consciousness events; only log the
      // ones that materially advance the audit trail.
      return null;
  }
}

function safeStringify(value: unknown, maxBytes: number): string {
  try {
    const s = JSON.stringify(value);
    if (s.length <= maxBytes) return s;
    return s.slice(0, maxBytes) + "…[truncated]";
  } catch {
    return "[unserializable]";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// ---------------------------------------------------------------------------
// Prompt audit receipt
// ---------------------------------------------------------------------------

/**
 * Save the exact prompt sent to a phase. Persists to
 * `<aiw>/prompts/<phase>-<ts>.txt` so the audit trail includes what
 * the agent actually saw.
 */
export function recordPhasePrompt(
  paths: AiwPaths,
  phase: PhaseName,
  prompt: string,
): void {
  writePhasePrompt(paths, phase, prompt);
}

// ---------------------------------------------------------------------------
// Per-phase runtime directory
// ---------------------------------------------------------------------------

export function ensurePhaseAgentDir(paths: AiwPaths, phase: PhaseName): string {
  return phaseAgentDir(paths, phase);
}

// ---------------------------------------------------------------------------
// Apply log file existence check (used by tests)
// ---------------------------------------------------------------------------

export function eventsFileExists(paths: AiwPaths): boolean {
  return fs.existsSync(paths.eventsFile);
}