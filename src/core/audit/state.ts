// Module-level state shared by the standalone audit runner and its
// defense hook.
//
// Phase 2.4: per-session state isolation. The original
// `agentifySessionActive` was process-wide; two concurrent agentify
// runs would interfere with each other's defense hook.
// We now key state by session ID (or a per-process fallback key).
//
// One-shot use: the audit is intended to be run once per codebase.
// After `agentify` completes, the user has AGENTS.md in their
// codebase. No long-lived audit state needs to survive across runs.

// ThinkingLevel is the literal union of level strings that Pi
// supports. The original `ThinkingLevel` type is in
// `@earendil-works/pi-agent-core`, which is bundled inside
// pi-coding-agent and not re-exported. We re-declare the union
// here so the file is self-contained and the runtime is the
// single source of truth (the SDK accepts any string).
type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

// Session-scoped mirror of the parent's current thinking level.
// Captured at runner startup and updated when the CLI config changes.
let currentThinkingLevel: ThinkingLevel | "unknown" = "unknown";

export function setThinkingLevel(level: ThinkingLevel | "unknown"): void {
  currentThinkingLevel = level;
}

export function getThinkingLevel(): ThinkingLevel | "unknown" {
  return currentThinkingLevel;
}

// ============================================================================
// Per-session state (Phase 2.4)
// ============================================================================

export type SessionFlags = {
  active: boolean;
  thinkingLevel: ThinkingLevel | "unknown";
};

const sessionFlags: Map<string, SessionFlags> = new Map();

let processCounter = 0;

export function getOrCreateSessionId(): string {
  // The embedded SDK may not expose a session ID directly. Use a
  // process-local fallback; the defense hook handler can still supply a
  // concrete session ID when one is available.
  if (processCounter === 0) {
    processCounter = Math.floor(Math.random() * 1_000_000) + 1;
  }
  return `proc-${process.pid}-${processCounter}`;
}

function getOrInitFlags(sessionId: string): SessionFlags {
  let flags = sessionFlags.get(sessionId);
  if (!flags) {
    flags = {
      active: false,
      thinkingLevel: currentThinkingLevel,
    };
    sessionFlags.set(sessionId, flags);
  }
  return flags;
}

export function setAgentifySessionActive(
  sessionId: string | null,
  active: boolean,
): void {
  const id = sessionId ?? getOrCreateSessionId();
  const flags = getOrInitFlags(id);
  flags.active = active;
}

export function isAgentifySessionActive(sessionId?: string): boolean {
  const id = sessionId ?? getOrCreateSessionId();
  const flags = sessionFlags.get(id);
  return flags?.active ?? false;
}

export function clearSession(sessionId: string): void {
  sessionFlags.delete(sessionId);
}

export function getSessionFlags(sessionId: string): SessionFlags | undefined {
  return sessionFlags.get(sessionId);
}
