// workflow-afk.ts — auto-promotion of orchestrator workflows to AFK.
//
// The orchestrator's workflow runner (`src/core/orchestrator/workflow-runner.ts`)
// composes sub-agents and AIWs into DAGs. Some workflows end with an
// AIW step; when that AIW's review verdict is `success` and the
// kpis.md snapshot has AFK earned for the AIW's changeType,
// the orchestrator can auto-trigger the ship phase.
//
// This module exposes:
//
//   - `shouldAutoShip(aiwId, changeType, threshold)` — pure
//     function over the live kpis snapshot.
//   - `autoShipAiw(aiwId, cwd, options)` — convenience that calls
//     `runShipPhase` with the standard AFK gate check.
//
// The orchestrator's workflow runner hooks this in via the
// `workflow_completed` event: when a step's handler is `aiw` and
// the AIW's review verdict is success, run `shouldAutoShip`; if
// it returns true, call `autoShipAiw` to push + merge.

import { aiwStatePaths } from "./aiw/paths.ts";
import { readSnapshot, type KpisSnapshot } from "./aiw/kpis.ts";
import { checkAfkGate, DEFAULT_AFK_THRESHOLD, type GateResult } from "./aiw/afk-gate.ts";
import { runShipPhase, type ShipPhaseResult } from "./aiw/ship.ts";
import type { ChangeType } from "./aiw/state.ts";

// ---------------------------------------------------------------------------
// Pure decision function
// ---------------------------------------------------------------------------

export interface ShouldAutoShipResult {
  /** True iff the ship phase should auto-run. */
  shouldShip: boolean;
  /** The gate result (for logging). */
  gate: GateResult;
  /** The kpis snapshot that was evaluated. */
  snapshot: KpisSnapshot | null;
}

/**
 * Decide whether to auto-ship an AIW. Pure function over the live
 * kpis snapshot — the caller passes the aiw_id so we can locate
 * the kpis file via the standard AIW paths layout.
 *
 * Returns `shouldShip: false` if:
 *   - The kpis file is missing.
 *   - The snapshot's current streak is below the threshold.
 *   - The user has not earned AFK for this changeType.
 *
 * Always returns the full `GateResult` so callers can log the
 * reason for skipping.
 */
export function shouldAutoShip(
  aiwId: string,
  changeType: ChangeType,
  threshold: number = DEFAULT_AFK_THRESHOLD,
  configDir?: string,
): ShouldAutoShipResult {
  // If configDir is provided, use aiwStatePaths so we get the
  // per-aiw directory + the shared kpis.md. Otherwise, require configDir.
  if (!configDir) {
    return {
      shouldShip: false,
      gate: {
        allowed: false,
        reason: "configDir is required",
        currentStreak: 0,
        threshold,
        changeType,
        unlocked: false,
      },
      snapshot: {
        currentStreak: 0,
        longestStreak: 0,
        planSizeMedian: null,
        planSizeP95: null,
        diffSizeMedian: null,
        diffSizeP95: null,
        averagePresence: 0,
        attempts: 0,
        afkEarned: { chores: false, bugs: false, features: false },
        updatedAt: "",
      },
    };
  }
  const paths = aiwStatePaths(configDir, aiwId);
  const snapshot = readSnapshot(paths);
  // checkAfkGate handles the missing-file case internally.
  const gate = checkAfkGate(snapshot, changeType, threshold);
  return {
    shouldShip: gate.allowed,
    gate,
    snapshot,
  };
}

// ---------------------------------------------------------------------------
// Convenience: auto-ship
// ---------------------------------------------------------------------------

export interface AutoShipOptions {
  /** Override the threshold (defaults to DEFAULT_AFK_THRESHOLD). */
  threshold?: number;
  /** Override the AIW configDir (defaults to standard paths). */
  configDir?: string;
  /** Skip the gate check (admin override; bypasses AFK). */
  force?: boolean;
  /** Override the exec layer (for tests). */
  exec?: import("./aiw/ship.ts").ExecLayer;
  /** Logger callback. */
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface AutoShipResult {
  shouldShip: boolean;
  shipResult?: ShipPhaseResult;
  gate?: GateResult;
}

/**
 * Decide whether to auto-ship, then if so, run the ship phase.
 * Returns `{shouldShip: false}` if the gate denies (no side
 * effects). On success, returns `{shouldShip: true, shipResult}`.
 */
export async function autoShipAiw(
  aiwId: string,
  changeType: ChangeType,
  cwd: string,
  workingDir: string,
  options: AutoShipOptions = {},
): Promise<AutoShipResult> {
  const paths = options.configDir ? aiwStatePaths(options.configDir, aiwId) : aiwStatePaths("/tmp", aiwId);
  const decision = shouldAutoShip(aiwId, changeType, options.threshold, options.configDir);
  options.log?.(`autoShip decision`, {
    aiw_id: aiwId,
    changeType,
    shouldShip: decision.shouldShip,
    streak: decision.gate.currentStreak,
    threshold: decision.gate.threshold,
    reason: decision.gate.reason,
  });
  if (!decision.shouldShip && !options.force) {
    return { shouldShip: false, gate: decision.gate };
  }
  // Build a minimal AiwState for runShipPhase. The ship phase only
  // reads the worktree_path and working_dir; changeType is passed
  // explicitly.
  const state = {
    aiw_id: aiwId,
    workflow: "plan_build_review_ship",
    worktree_path: cwd,
    working_dir: workingDir,
    changeType,
  } as import("./aiw/state.ts").AiwState;
  const shipResult = await runShipPhase({
    paths,
    state,
    cwd,
    workingDir,
    changeType,
    logger: makeLoggerFromCallback(options.log),
    force: options.force === true,
    exec: options.exec,
  });
  return { shouldShip: true, shipResult, gate: decision.gate };
}

function makeLoggerFromCallback(log?: (msg: string, fields?: Record<string, unknown>) => void): import("./aiw/logging.ts").AiwLogger {
  return {
    info: (msg, fields) => log?.(`info: ${msg}`, fields),
    warn: (msg, fields) => log?.(`warn: ${msg}`, fields),
    error: (msg, fields) => log?.(`error: ${msg}`, fields),
  };
}

// Re-export types for tests.
export type { KpisSnapshot, GateResult, ShipPhaseResult, ChangeType };