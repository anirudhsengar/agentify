// state.ts — the canonical schema for AIW (AI Developer Workflow) state.
//
// An AIW is a multi-step orchestrated workflow. Each step (phase) is a
// fresh agent invocation; the workflow's `AiwState` is the connective
// tissue between phases. The state file lives at
//   ~/.agentify/aiw/<aiw_id>/state.json
// and is rewritten atomically on every transition. A separate
// append-only log at
//   ~/.agentify/aiw/<aiw_id>/events.jsonl
// captures the raw event stream (one line per transition + per agent
// event) for replay / debugging.
//
// Schema design mirrors `principles/06-aiws-and-afk.md` § "AIW State
// File" and the lessons' reference implementation. TypeBox is the
// single source of truth; the `AiwState` / `PhaseRecord` TypeScript
// types are derived via `Static<>`.
//
// Status is a small state machine:
//   queued -> running -> (completed | failed | aborted)
// Each phase has its own status:
//   pending -> running -> (done | error | skipped)

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const WorkflowNameSchema = StringEnum(
  ["plan_build", "plan_build_review", "plan_build_review_fix", "plan_build_review_ship"] as const,
);

export type WorkflowName = Static<typeof WorkflowNameSchema>;

export const WorkflowName = {
  PlanBuild: "plan_build",
  PlanBuildReview: "plan_build_review",
  PlanBuildReviewFix: "plan_build_review_fix",
  PlanBuildReviewShip: "plan_build_review_ship",
} as const;

// ChangeType — drives the AFK gate. Each AIW run is classified
// as chore, bug, feature, or unknown. The kpis.md file tracks the
// per-type streak; the ship phase checks the gate before merging.
export const ChangeTypeSchema = StringEnum(
  ["chore", "bug", "feature", "unknown"] as const,
);

export type ChangeType = Static<typeof ChangeTypeSchema>;

export const ChangeType = {
  Chore: "chore",
  Bug: "bug",
  Feature: "feature",
  Unknown: "unknown",
} as const;

// A workflow is a sequence of phases. `PHASES_FOR` is the canonical
// mapping used by the workflow runner to know what to invoke.
export const PHASES_FOR: Record<WorkflowName, ReadonlyArray<PhaseName>> = {
  plan_build: ["plan", "build"],
  plan_build_review: ["plan", "build", "review"],
  plan_build_review_fix: ["plan", "build", "review", "fix"],
  plan_build_review_ship: ["plan", "build", "review", "fix", "ship"],
};

// A workflow's `fix` phase is *conditional*: it only runs if the
// preceding review phase returned `success: false`. The workflow
// runner consults `PHASE_SKIPS` to know whether to skip a phase.
// The `ship` phase is *gate-conditional*: it runs only if the AFK
// gate is earned for the run's changeType; otherwise the runner
// marks it as skipped.
export const PHASE_SKIPS: Record<PhaseName, "review_verdict" | "always_run" | "gate" | "never"> = {
  plan: "always_run",
  build: "always_run",
  review: "always_run",
  fix: "review_verdict",
  ship: "gate",
};

export const AiwStatusSchema = StringEnum(
  ["queued", "running", "completed", "failed", "aborted"] as const,
);

export const AiwStatus = {
  Queued: "queued",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Aborted: "aborted",
} as const;

export const PhaseNameSchema = StringEnum(
  ["plan", "build", "review", "fix", "ship"] as const,
);

export type PhaseName = Static<typeof PhaseNameSchema>;

export const PhaseName = {
  Plan: "plan",
  Build: "build",
  Review: "review",
  Fix: "fix",
  Ship: "ship",
} as const;

export const PhaseStatusSchema = StringEnum(
  ["pending", "running", "done", "error", "skipped"] as const,
);

export const PhaseStatus = {
  Pending: "pending",
  Running: "running",
  Done: "done",
  Error: "error",
  Skipped: "skipped",
} as const;

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

export const PhaseArtifactsSchema = Type.Object({
  plan_path: Type.Union([Type.String(), Type.Null()]),
  review_path: Type.Union([Type.String(), Type.Null()]),
  fix_path: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

export const PhaseRecordSchema = Type.Object({
  phase: PhaseNameSchema,
  status: PhaseStatusSchema,
  started_at: Type.Union([Type.String(), Type.Null()]),
  ended_at: Type.Union([Type.String(), Type.Null()]),
  artifacts: PhaseArtifactsSchema,
  cost_usd: Type.Union([Type.Number(), Type.Null()]),
  turns: Type.Number(),
  error_message: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

export const AiwStateSchema = Type.Object({
  aiw_id: Type.String({ description: "16 hex chars; generated at trigger time." }),
  workflow: WorkflowNameSchema,
  // The user request that kicked off the workflow.
  prompt: Type.String(),
  // Absolute path to the project being worked on.
  working_dir: Type.String(),
  // Per-AIW isolation (set on creation, never changes).
  branch_name: Type.String(),
  worktree_path: Type.String(),
  backend_port: Type.Number(),
  frontend_port: Type.Number(),
  // Optional model overrides; runtime defaults apply if absent.
  model: Type.Union([Type.String(), Type.Null()]),
  thinking_level: Type.Union([Type.String(), Type.Null()]),
  // The ordered log of phase records. One entry per workflow phase.
  phases: Type.Array(PhaseRecordSchema),
  current_step: Type.Union([Type.String(), Type.Null()]),
  status: AiwStatusSchema,
  // Final outputs (paths populated by the corresponding phases).
  implement_result_path: Type.Union([Type.String(), Type.Null()]),
  review_result_path: Type.Union([Type.String(), Type.Null()]),
  // KPI tracker — the number of (plan, fix) attempts across the run.
  // Mirrors `all_aiws` in the lessons' state file.
  attempts: Type.Number(),
  started_at: Type.String(),
  ended_at: Type.Union([Type.String(), Type.Null()]),
  error_message: Type.Union([Type.String(), Type.Null()]),
  error_step: Type.Union([Type.String(), Type.Null()]),
  // Whether the worktree was created (false in --no-worktree mode or
  // non-git repos).
  worktree_created: Type.Boolean(),
  // Source trigger for auditability (e.g. "webhook:github-issue-implement"
  // or "cli:manual" or "cron:nightly").
  source: Type.String(),
  // Class of work for the AFK gate (away-from-keyboard). Drives which
  // kpis.md streak bucket the run's success/failure counts toward.
  // "unknown" means the caller didn't classify; this run will not
  // advance any streak.
  changeType: ChangeTypeSchema,
  // AFK-gate audit field. True if the ship phase's gate check passed
  // (or the run had no ship phase); false if --force was used to
  // bypass a denied gate. Persisted in the run record so force-ships
  // are auditable.
  gate_passed: Type.Boolean(),
}, { additionalProperties: false });

export type AiwState = Static<typeof AiwStateSchema>;
export type PhaseRecord = Static<typeof PhaseRecordSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export function validateAiwState(raw: unknown): ValidationResult<AiwState> {
  if (!Value.Check(AiwStateSchema, raw)) {
    const errors = [...Value.Errors(AiwStateSchema, raw)].map(stringifyTypeboxError);
    return { ok: false, errors };
  }
  return { ok: true, value: raw as AiwState };
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

export function generateAiwId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Create a fresh `AiwState` for a new workflow run. Caller must
 * supply the isolation params (from `isolation.ts`); the rest of the
 * state is initialized to a "queued with all phases pending" shape.
 */
export function makeQueuedAiwState(params: {
  aiwId: string;
  workflow: WorkflowName;
  prompt: string;
  workingDir: string;
  branchName: string;
  worktreePath: string;
  backendPort: number;
  frontendPort: number;
  model?: string | null;
  thinkingLevel?: string | null;
  worktreeCreated: boolean;
  source: string;
  changeType?: ChangeType;
  startedAt?: string;
}): AiwState {
  const phases = PHASES_FOR[params.workflow].map((phase) => ({
    phase,
    status: PhaseStatus.Pending,
    started_at: null,
    ended_at: null,
    artifacts: { plan_path: null, review_path: null, fix_path: null },
    cost_usd: null,
    turns: 0,
    error_message: null,
  }));
  return {
    aiw_id: params.aiwId,
    workflow: params.workflow,
    prompt: params.prompt,
    working_dir: params.workingDir,
    branch_name: params.branchName,
    worktree_path: params.worktreePath,
    backend_port: params.backendPort,
    frontend_port: params.frontendPort,
    model: params.model ?? null,
    thinking_level: params.thinkingLevel ?? null,
    phases,
    current_step: null,
    status: AiwStatus.Queued,
    implement_result_path: null,
    review_result_path: null,
    attempts: 0,
    started_at: params.startedAt ?? new Date().toISOString(),
    ended_at: null,
    error_message: null,
    error_step: null,
    worktree_created: params.worktreeCreated,
    source: params.source,
    changeType: params.changeType ?? "unknown",
    gate_passed: true, // No ship phase yet → trivially passes
  };
}

/**
 * Return a new AiwState with the phase replaced. Pure function —
 * callers should `writeAiwState` the result. If the phase is not
 * found, returns the state unchanged (caller's bug).
 */
export function updatePhase(
  state: AiwState,
  phase: PhaseName,
  update: Partial<PhaseRecord>,
): AiwState {
  const phases = state.phases.map((p) =>
    p.phase === phase ? { ...p, ...update } : p
  );
  return { ...state, phases };
}

/**
 * Mark a phase as started (status -> running, started_at set).
 */
export function startPhase(state: AiwState, phase: PhaseName): AiwState {
  return updatePhase(state, phase, {
    status: PhaseStatus.Running,
    started_at: new Date().toISOString(),
  });
}

/**
 * Mark a phase as done.
 */
export function finishPhase(
  state: AiwState,
  phase: PhaseName,
  result: { costUsd: number | null; turns: number; artifacts?: Partial<PhaseRecord["artifacts"]> },
): AiwState {
  return updatePhase(state, phase, {
    status: PhaseStatus.Done,
    ended_at: new Date().toISOString(),
    cost_usd: result.costUsd,
    turns: result.turns,
    artifacts: {
      plan_path: state.phases.find((p) => p.phase === phase)?.artifacts.plan_path ?? null,
      review_path: state.phases.find((p) => p.phase === phase)?.artifacts.review_path ?? null,
      fix_path: state.phases.find((p) => p.phase === phase)?.artifacts.fix_path ?? null,
      ...(result.artifacts ?? {}),
    },
  });
}

/**
 * Mark a phase as errored.
 */
export function failPhase(
  state: AiwState,
  phase: PhaseName,
  errorMessage: string,
): AiwState {
  return updatePhase(state, phase, {
    status: PhaseStatus.Error,
    ended_at: new Date().toISOString(),
    error_message: errorMessage,
  });
}

/**
 * Mark a phase as skipped (e.g., review passed → fix not needed).
 */
export function skipPhase(state: AiwState, phase: PhaseName): AiwState {
  return updatePhase(state, phase, {
    status: PhaseStatus.Skipped,
    ended_at: new Date().toISOString(),
  });
}

/**
 * Mark the workflow itself as completed.
 */
export function completeAiw(state: AiwState): AiwState {
  return {
    ...state,
    status: AiwStatus.Completed,
    ended_at: new Date().toISOString(),
    current_step: null,
  };
}

/**
 * Mark the workflow as failed.
 */
export function failAiw(
  state: AiwState,
  errorStep: PhaseName | string,
  errorMessage: string,
): AiwState {
  return {
    ...state,
    status: AiwStatus.Failed,
    ended_at: new Date().toISOString(),
    current_step: null,
    error_step: errorStep,
    error_message: errorMessage,
  };
}

/**
 * Mark the workflow as aborted.
 */
export function abortAiw(state: AiwState): AiwState {
  return {
    ...state,
    status: AiwStatus.Aborted,
    ended_at: new Date().toISOString(),
    current_step: null,
  };
}

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

/**
 * Get the current phase record by name. Returns null if the phase is
 * not in this workflow.
 */
export function getPhase(state: AiwState, phase: PhaseName): PhaseRecord | null {
  return state.phases.find((p) => p.phase === phase) ?? null;
}

/**
 * Determine whether the workflow is in a terminal state.
 */
export function isTerminal(state: AiwState): boolean {
  return state.status === AiwStatus.Completed
      || state.status === AiwStatus.Failed
      || state.status === AiwStatus.Aborted;
}

/**
 * Compute total cost + turns across all completed phases.
 */
export function totals(state: AiwState): { costUsd: number; turns: number } {
  let costUsd = 0;
  let turns = 0;
  for (const p of state.phases) {
    if (p.cost_usd !== null && Number.isFinite(p.cost_usd)) {
      costUsd += p.cost_usd;
    }
    turns += p.turns;
  }
  return { costUsd, turns };
}

/**
 * Duration in milliseconds (started_at -> ended_at), or null if the
 * workflow is still running.
 */
export function durationMs(state: AiwState): number | null {
  if (!state.ended_at) return null;
  const start = Date.parse(state.started_at);
  const end = Date.parse(state.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}