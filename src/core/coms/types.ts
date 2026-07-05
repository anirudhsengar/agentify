// coms/types.ts — canonical types for the Pi-to-Pi peer mesh.
//
// Source of truth:
//   - docs/PLAN-class4.md § Class 4 G2 (Local peer mesh)
//   - principles/08-multi-agent.md § "Pattern 3 — Pi-to-Pi Peer Mesh"
//   - LESSONS/PI_MASTERY.md § 11 (the canonical 1598-line `coms.ts`)
//   - principles/15-anti-patterns.md § "Multi-Agent Anti-Patterns"
//     (the cardinal reply-by-assistant-message rule)
//
// Design notes:
//   - The 4-tool surface (list / send / get / await) is identical
//     to the canonical Pi-to-Pi design (LEARNINGS3.md § 11.4).
//   - MAX_HOPS = 5 is the default (PI_MASTERY.md § 11.8 "Hop limit").
//   - The `hops` field auto-increments each forward. Receivers
//     reject prompts with hops >= MAX_HOPS (PI_MASTERY.md § 11.10).
//   - The "reply trap" (callers replying via send instead of
//     letting agent_end auto-capture) is the cardinal anti-pattern
//     in `principles/15-anti-patterns.md` — enforced by the defense hook
//     when this extension is loaded alongside `defense-hook.ts`.

// ---------------------------------------------------------------------------
// Peer registry
// ---------------------------------------------------------------------------

export interface PeerEntry {
  /** Logical name (set by --cname or frontmatter). */
  name: string;
  /** Process id; used for liveness. */
  pid: number;
  /** Absolute path to the Unix socket the peer listens on. */
  socketPath: string;
  /** Project hash (the cwd hashed to 16 hex chars). */
  project: string;
  /** Cwd of the peer. */
  cwd: string;
  /** Purpose / description (one line). */
  purpose: string;
  /** Color for the pool widget (hex). */
  color: string;
  /** ISO timestamp of the last heartbeat. */
  lastHeartbeat: string;
  /** 0-100; context window utilization. */
  contextUsedPct: number;
}

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

/**
 * A prompt envelope: sent by `coms_send`, received by the target's
 * ComsServer. The receiver's `agent_end` packages the assistant's
 * final message as a ResponseEnvelope with the same `msg_id`.
 */
export interface PromptEnvelope {
  type: "prompt";
  /** Server-generated ULID; unique per send. */
  msg_id: string;
  /** Sender name (registry key). */
  sender: string;
  /** Target name (registry key). */
  target: string;
  /** The actual prompt body. */
  body: string;
  /** Optional thread key for multi-turn conversations. */
  conversation_id?: string;
  /** Number of hops this envelope has traversed (sender starts at 0). */
  hops: number;
  /** ISO timestamp. */
  ts: string;
}

/**
 * A response envelope: sent automatically when the receiver's
 * `agent_end` fires. The sender's `coms_await` resolves with this
 * payload.
 */
export interface ResponseEnvelope {
  type: "response";
  msg_id: string;
  sender: string;
  target: string;
  body: string;
  conversation_id?: string;
  hops: number;
  ts: string;
  /** Was the agent aborted? */
  aborted?: boolean;
  /** Did the agent error out? */
  error?: string;
}

/**
 * An error envelope: sent when a peer rejects a prompt (hop limit,
 * unknown sender, etc.) or fails to deliver.
 */
export interface ErrorEnvelope {
  type: "error";
  msg_id: string;
  sender: string;
  target: string;
  hops: number;
  ts: string;
  error: string;
  code: ErrorCode;
}

export type ComsEnvelope = PromptEnvelope | ResponseEnvelope | ErrorEnvelope;

export type ErrorCode =
  | "hop_limit_exceeded"
  | "unknown_sender"
  | "unknown_target"
  | "self_send"
  | "delivery_failed"
  | "timeout"
  | "invalid_envelope";

// ---------------------------------------------------------------------------
// Hop limit
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_HOPS = 5;

/**
 * Throws if `hops` would exceed MAX_HOPS on the receiving side. The
 * Pi_Master code (LEARNINGS3.md § 11.10) keeps a single counter
 * per-envelope; we mirror it here.
 */
export class HopLimitExceededError extends Error {
  readonly code: ErrorCode = "hop_limit_exceeded";
  constructor(readonly hops: number, readonly maxHops: number) {
    super(`hop limit exceeded: hops=${hops}, max=${maxHops}`);
  }
}

// ---------------------------------------------------------------------------
// Pending message tracking (sender side)
// ---------------------------------------------------------------------------

export type MessageStatus = "pending" | "delivered" | "complete" | "error" | "timeout";

export interface PendingMessage {
  msg_id: string;
  sender: string;
  target: string;
  body: string;
  conversation_id?: string;
  hops: number;
  status: MessageStatus;
  /** Set when status = complete. */
  response?: ResponseEnvelope;
  /** Set when status = error. */
  error?: string;
  /** Set when status = error / timeout. */
  errorCode?: ErrorCode;
  /** ISO timestamps for each transition. */
  queued_at: string;
  delivered_at?: string;
  completed_at?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_COMS_ROOT = "~/.pi/coms";

/** Default socket path template. <session_id> is replaced. */
export const SOCKET_PATH_TEMPLATE = "<root>/sockets/<session_id>.sock";

/** Default project registry path. <project_hash> is replaced. */
export const PROJECT_REGISTRY_TEMPLATE = "<root>/projects/<project>/agents";

/** Default socket timeout (ms) for connect + send. */
export const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;

/** Default poll interval for `coms_get`. */
export const DEFAULT_POLL_INTERVAL_MS = 200;

/** Default `coms_await` timeout (30 min, per LEARNINGS3.md § 11.4). */
export const DEFAULT_AWAIT_TIMEOUT_MS = 30 * 60_000;

/** Heartbeat interval (LEARNINGS3.md § 11.7 "keepalive every 30s"). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Stale-after threshold for `coms_list` (LEARNINGS3.md § 11.7). */
export const STALE_AFTER_MS = 60_000;