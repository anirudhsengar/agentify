// state.ts — the canonical schema for sub-agent (managed by the
// orchestrator) state.
//
// A sub-agent is **one Pi session** started by the orchestrator's
// `create_agent` or `command_agent` tool. The schema mirrors
// `AiwState` (src/core/aiw/state.ts) but smaller: there are no
// phases, no worktree, no ports. The shape is a strict subset.
//
// State lives at <configDir>/orchestrator/agents/<agent_id>/state.json
// and is rewritten atomically on every transition. A separate
// append-only log at events.jsonl captures the raw event stream
// for replay / debugging.
//
// Status is a small state machine:
//   queued -> running -> (completed | failed | aborted)
//                       -> interrupted (soft or hard)
//                       -> deleted   (post-cleanup)
//
// Schema design mirrors `principles/13-agentic-layer.md` Class 3
// Grade 1 and `LESSONS/LEARNINGS3.md` § 11.5 (the 10 management
// tools). TypeBox is the single source of truth.

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const AgentStatusSchema = StringEnum(
  [
    "queued",
    "running",
    "completed",
    "failed",
    "aborted",
    "interrupted",
    "deleted",
  ] as const,
);

export type AgentStatus = Static<typeof AgentStatusSchema>;

export const AgentStatus = {
  Queued: "queued",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Aborted: "aborted",
  Interrupted: "interrupted",
  Deleted: "deleted",
} as const;

/**
 * The model choices an orchestrator can pick from. Mirrors the
 * `principles/08-multi-agent.md` `modelAliases` table; expanded
 * with `inherit` (use the parent's choice) for orchestrator-
 * spawned agents.
 */
export const ModelChoiceSchema = StringEnum(
  ["inherit", "haiku", "sonnet", "opus"] as const,
);

export type ModelChoice = Static<typeof ModelChoiceSchema>;

export const ModelChoice = {
  Inherit: "inherit",
  Haiku: "haiku",
  Sonnet: "sonnet",
  Opus: "opus",
} as const;

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

export const AgentStateSchema = Type.Object({
  schema_version: StringEnum(["1"] as const),
  agent_id: Type.String({
    description:
      "Unique agent id: <name>-<3-char suffix>. Two creates of the same name coexist via the random suffix.",
  }),
  name: Type.String({
    description: "Orchestrator-supplied logical name. Not unique; for display.",
  }),
  status: AgentStatusSchema,
  parent_session_id: Type.String({
    description: "The orchestrator session id that owns this sub-agent.",
  }),
  system_prompt: Type.String({
    description: "The exact system prompt sent to the sub-agent at session start.",
  }),
  user_prompt: Type.String({
    description: "The first command_agent prompt (the bootstrap).",
  }),
  tools: Type.Array(Type.String(), {
    description: "Allowed tools (Pi built-ins only; sub-agents do not get create_agent).",
  }),
  model: Type.Union([Type.String(), Type.Null()], {
    description: "Model id (e.g. 'haiku', 'sonnet', 'opus') or null = inherit parent's model.",
  }),
  thinking_level: Type.Union([Type.String(), Type.Null()], {
    description: "Pi's thinking_level enum or null = inherit.",
  }),
  /**
   * Named slot role for this sub-agent session. Defaults to
   * "primary" when unset. See `ModelRole` and ADR 0017.
   */
  model_role: Type.Union([Type.String(), Type.Null()], {
    description: "Slot role: 'primary' | 'explorer' | 'lite'. Null = inherit parent's role.",
  }),
  started_at: Type.String({ description: "ISO 8601." }),
  ended_at: Type.Union([Type.String(), Type.Null()]),
  turns: Type.Number({ description: "Number of completed turns." }),
  cost_usd: Type.Union([Type.Number(), Type.Null()]),
  result_text: Type.Union([Type.String(), Type.Null()], {
    description: "Last assistant message text (the agent's reply).",
  }),
  error_message: Type.Union([Type.String(), Type.Null()]),
  subagent_template: Type.Union([Type.String(), Type.Null()], {
    description: "Registry key (e.g. 'scout-report-suggest') if used.",
  }),
  expertise_path: Type.Union([Type.String(), Type.Null()], {
    description: "Path to the expertise.md file (for ACT -> LEARN -> REUSE later).",
  }),
  domain: Type.Union([Type.Array(Type.String()), Type.Null()], {
    description:
      "Reserved for orchestrator workflows (domain locking). Path globs the sub-agent " +
      "may write to. null = no constraint enforced (default in the base runtime).",
  }),
  interrupt_kind: Type.Union([Type.String(), Type.Null()], {
    description: "soft | hard | null. Set when status = interrupted.",
  }),
}, { additionalProperties: false });

export type AgentState = Static<typeof AgentStateSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export function validateAgentState(raw: unknown): ValidationResult<AgentState> {
  if (!Value.Check(AgentStateSchema, raw)) {
    const errors = [...Value.Errors(AgentStateSchema, raw)].map(stringifyTypeboxError);
    return { ok: false, errors };
  }
  return { ok: true, value: raw as AgentState };
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
// ID + initial state factories
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";

/**
 * Generate a unique agent_id from a logical name. The format is
 * `<sanitized-name>-<3-char suffix>`. Collisions on the same name
 * are statistically impossible (62^3 = 238k).
 */
export function generateAgentId(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "agent";
  const suffix = randomBytes(2).toString("hex").slice(0, 3);
  return `${sanitized}-${suffix}`;
}

export interface MakeQueuedAgentParams {
  name: string;
  systemPrompt: string;
  userPrompt: string;
  tools: string[];
  model?: string | null;
  thinkingLevel?: string | null;
  modelRole?: "primary" | "explorer" | "lite" | null;
  parentSessionId: string;
  subagentTemplate?: string | null;
  expertisePath?: string | null;
  domain?: string[] | null;
  agentId?: string;
  startedAt?: string;
}

export function makeQueuedAgentState(params: MakeQueuedAgentParams): AgentState {
  return {
    schema_version: "1",
    agent_id: params.agentId ?? generateAgentId(params.name),
    name: params.name,
    status: AgentStatus.Queued,
    parent_session_id: params.parentSessionId,
    system_prompt: params.systemPrompt,
    user_prompt: params.userPrompt,
    tools: [...params.tools],
    model: params.model ?? null,
    thinking_level: params.thinkingLevel ?? null,
    model_role: params.modelRole ?? null,
    started_at: params.startedAt ?? new Date().toISOString(),
    ended_at: null,
    turns: 0,
    cost_usd: null,
    result_text: null,
    error_message: null,
    subagent_template: params.subagentTemplate ?? null,
    expertise_path: params.expertisePath ?? null,
    domain: params.domain ?? null,
    interrupt_kind: null,
  };
}

// ---------------------------------------------------------------------------
// Transitions (pure functions; immutable updates)
// ---------------------------------------------------------------------------

/**
 * Mark the agent as running. Sets `status` and clears any
 * previous error/interrupt fields.
 */
export function startAgent(state: AgentState): AgentState {
  return {
    ...state,
    status: AgentStatus.Running,
    error_message: null,
    interrupt_kind: null,
  };
}

/**
 * Mark the agent as completed. Captures the final result text,
 * turns, and cost.
 */
export function completeAgent(
  state: AgentState,
  result: { turns: number; costUsd: number | null; resultText: string | null },
): AgentState {
  return {
    ...state,
    status: AgentStatus.Completed,
    ended_at: new Date().toISOString(),
    turns: result.turns,
    cost_usd: result.costUsd,
    result_text: result.resultText,
  };
}

/**
 * Mark the agent as failed (error path; non-recoverable).
 */
export function failAgent(state: AgentState, errorMessage: string): AgentState {
  return {
    ...state,
    status: AgentStatus.Failed,
    ended_at: new Date().toISOString(),
    error_message: errorMessage,
  };
}

/**
 * Mark the agent as aborted (caller-aborted, distinct from failed).
 */
export function abortAgent(state: AgentState): AgentState {
  return {
    ...state,
    status: AgentStatus.Aborted,
    ended_at: new Date().toISOString(),
  };
}

/**
 * Mark the agent as interrupted. Two kinds:
 *   - soft: just signal the AbortController; let the agent finish
 *     its current turn naturally.
 *   - hard: call session.abort() immediately; capture partial.
 */
export function interruptAgent(state: AgentState, kind: "soft" | "hard"): AgentState {
  return {
    ...state,
    status: AgentStatus.Interrupted,
    ended_at: new Date().toISOString(),
    interrupt_kind: kind,
  };
}

/**
 * Mark the agent as deleted. Used by delete_agent to record the
 * final state before the directory is removed/archived.
 */
export function deleteAgent(state: AgentState): AgentState {
  return {
    ...state,
    status: AgentStatus.Deleted,
    ended_at: state.ended_at ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Live-state helpers
// ---------------------------------------------------------------------------

/**
 * Update a partial field set. Used by the per-event log handler to
 * accumulate cost/turns as events stream in.
 */
export function updateAgent(
  state: AgentState,
  patch: Partial<Pick<AgentState, "turns" | "cost_usd" | "result_text">>,
): AgentState {
  return { ...state, ...patch };
}

/**
 * Determine whether the agent is in a terminal state.
 */
export function isTerminal(state: AgentState): boolean {
  return (
    state.status === AgentStatus.Completed ||
    state.status === AgentStatus.Failed ||
    state.status === AgentStatus.Aborted ||
    state.status === AgentStatus.Interrupted ||
    state.status === AgentStatus.Deleted
  );
}

/**
 * Duration in milliseconds (started_at -> ended_at), or null if
 * still running.
 */
export function durationMs(state: AgentState): number | null {
  if (!state.ended_at) return null;
  const start = Date.parse(state.started_at);
  const end = Date.parse(state.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}