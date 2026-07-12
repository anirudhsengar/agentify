/**
 * @experimental Internal AIW composition root.
 *
 * This module is not a public CLI command or package export and carries no
 * semantic-version compatibility guarantee. Repository tests and internal code
 * may import it directly; package consumers must use the supported `agentify`
 * executable. See `docs/experimental-surfaces.md`.
 */
//
// One entry point: `startAiwRunner(options)`. Returns an `AiwRunner`
// that exposes the four operations a caller needs:
//
//   - run(...)    — start a new AIW
//   - resume(...) — resume a paused / crashed AIW from its state file
//   - cancel(...) — graceful abort via AbortSignal
//   - show(...)   — read the current state (or null if not found)
//
// The module is composition-rooted: it owns the runtime + logger +
// state IO. Workflows are an implementation detail; callers see only
// the runner.

import * as fs from "node:fs";
import {
  aiwStatePaths,
  aiwPaths,
  type AiwPaths,
} from "./paths.ts";
import {
  writeAiwState,
  readAiwState,
  appendExecutionLog,
} from "./paths.ts";
import {
  generateAiwId,
  isTerminal,
  makeQueuedAiwState,
  type AiwState,
  type WorkflowName,
} from "./state.ts";
import {
  resolveIsolation,
  removeWorktree,
  type IsolationResult,
} from "./isolation.ts";
import {
  makeAiwLogger,
  type AiwLogger,
} from "./logging.ts";
import { recordRun, readSnapshot, type KpisSnapshot } from "./kpis.ts";
import { runWorkflow } from "./runtime.ts";
import type { AgentRuntime } from "../types.ts";
import type { ChangeType } from "./state.ts";

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

export interface AiwRunnerOptions {
  configDir: string;
  /** Working directory (project root). */
  cwd: string;
  runtime?: AgentRuntime;
  /** Skip worktree creation even on a git repo. */
  noWorktree?: boolean;
  /** Logger; defaults to stderr JSON lines + per-AIW log file. */
  logger?: (paths: AiwPaths) => AiwLogger;
  /** For tests; default false. */
  updateKpis?: boolean;
}

// ---------------------------------------------------------------------------
// Runner handle
// ---------------------------------------------------------------------------

export interface AiwRunner {
  run(args: {
    workflow: WorkflowName;
    prompt: string;
    workingDir?: string;
    model?: string | null;
    thinkingLevel?: string | null;
    modelRole?: "primary" | "explorer" | "lite" | null;
    source?: string;
    signal?: AbortSignal;
    aiwId?: string;
    changeType?: ChangeType;
    force?: boolean;
  }): Promise<AiwState>;
  resume(aiwId: string, opts?: { force?: boolean }): Promise<AiwState>;
  cancel(aiwId: string): Promise<void>;
  show(aiwId: string): AiwState | null;
  list(): AiwState[];
  kpis(): KpisSnapshot;
  cleanup(aiwId: string, opts?: { deleteBranch?: boolean }): void;
}

export function startAiwRunner(options: AiwRunnerOptions): AiwRunner {
  const cwd = options.cwd;
  const abortControllers = new Map<string, AbortController>();
  const defaultLogger = (paths: AiwPaths) => makeAiwLogger(paths, "aiw");

  return {
    async run(args) {
      const aiwId = args.aiwId ?? generateAiwId();
      const workingDir = args.workingDir ?? cwd;
      const isolation = resolveIsolation(workingDir, aiwId, { noWorktree: options.noWorktree });
      const state = makeQueuedAiwState({
        aiwId,
        workflow: args.workflow,
        prompt: args.prompt,
        workingDir,
        branchName: isolation.branchName,
        worktreePath: isolation.worktreePath,
        backendPort: isolation.backendPort,
        frontendPort: isolation.frontendPort,
        model: args.model ?? null,
        thinkingLevel: args.thinkingLevel ?? null,
        modelRole: args.modelRole ?? null,
        worktreeCreated: isolation.created,
        source: args.source ?? "cli:manual",
        changeType: args.changeType ?? "unknown",
      });
      const paths = aiwStatePaths(options.configDir, aiwId);
      writeAiwState(paths, state);
      appendExecutionLog(paths, `AIW ${aiwId} created (workflow=${args.workflow}, source=${state.source}, changeType=${state.changeType})`);

      const ac = new AbortController();
      abortControllers.set(aiwId, ac);
      const signal = args.signal
        ? mergeSignals([args.signal, ac.signal])
        : ac.signal;

      const logger = (options.logger ?? defaultLogger)(paths);
      try {
        const finalState = await runWorkflow({
          paths,
          state,
          runtime: options.runtime,
          signal,
          logger,
          forceShip: args.force === true,
        });
        if (options.updateKpis !== false) {
          recordRun(paths, {
            aiwId: state.aiw_id,
            changeType: finalState.changeType,
            at: finalState.ended_at ?? finalState.started_at,
            attempts: finalState.attempts,
            planLines: null,
            diffStat: null,
            oneAttempt: finalState.attempts <= 1 && finalState.status === "completed",
          });
        }
        return finalState;
      } finally {
        abortControllers.delete(aiwId);
      }
    },

    async resume(aiwId, opts) {
      const paths = aiwStatePaths(options.configDir, aiwId);
      const existing = readAiwState(paths);
      if (!existing) {
        throw new Error(`AIW ${aiwId} not found (no state file)`);
      }
      if (isTerminal(existing)) {
        return existing;
      }
      const ac = new AbortController();
      abortControllers.set(aiwId, ac);
      const logger = (options.logger ?? defaultLogger)(paths);
      try {
        return await runWorkflow({
          paths,
          state: existing,
          runtime: options.runtime,
          signal: ac.signal,
          logger,
          forceShip: opts?.force === true,
        });
      } finally {
        abortControllers.delete(aiwId);
      }
    },

    async cancel(aiwId) {
      const ac = abortControllers.get(aiwId);
      if (ac) {
        ac.abort();
        return;
      }
      // No live run — mark the state as aborted on disk so the
      // worker's next tick doesn't re-dispatch it.
      const paths = aiwStatePaths(options.configDir, aiwId);
      const state = readAiwState(paths);
      if (state && !isTerminal(state)) {
        const aborted = { ...state, status: "aborted" as const, ended_at: new Date().toISOString() };
        writeAiwState(paths, aborted);
        appendExecutionLog(paths, `AIW ${aiwId} cancelled (no live run)`);
      }
    },

    show(aiwId) {
      const paths = aiwStatePaths(options.configDir, aiwId);
      return readAiwState(paths);
    },

    list() {
      const root = aiwPaths(options.configDir).aiwRoot;
      if (!fs.existsSync(root)) return [];
      const states: AiwState[] = [];
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sp = aiwStatePaths(options.configDir, entry.name);
        const s = readAiwState(sp);
        if (s) states.push(s);
      }
      states.sort((a, b) => a.started_at.localeCompare(b.started_at));
      return states;
    },

    kpis() {
      return readSnapshot(aiwPaths(options.configDir));
    },

    cleanup(aiwId, opts) {
      const state = this.show(aiwId);
      if (!state) return;
      try {
        if (state.worktree_created) {
          removeWorktree(state.working_dir, aiwId, opts);
        }
      } catch {
        // Best effort.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ac.abort();
      break;
    }
    s.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac.signal;
}

// ---------------------------------------------------------------------------
// Internal experimental exports
// ---------------------------------------------------------------------------

export {
  generateAiwId,
  makeQueuedAiwState,
  abortAiw,
  completeAiw,
  failAiw,
  failPhase,
  finishPhase,
  isTerminal,
  skipPhase,
  startPhase,
  updatePhase,
  totals,
  durationMs,
  getPhase,
  AiwStatus,
  PhaseStatus,
  PhaseName,
  WorkflowName,
  ChangeType,
  PHASES_FOR,
  PHASE_SKIPS,
  type AiwState,
  type PhaseRecord,
  type PhaseName as PhaseNameT,
} from "./state.ts";

export {
  aiwPaths,
  aiwStatePaths,
  writeAiwState,
  readAiwState,
  appendAiwEvent,
  readAiwEvents,
  appendExecutionLog,
  writePhasePrompt,
  phaseAgentDir,
  type AiwPaths,
} from "./paths.ts";

export {
  getPortsForAiw,
  getBranchNameForAiw,
  getWorktreePathForAiw,
  createWorktree,
  removeWorktree,
  isGitRepo,
  resolveIsolation,
  type IsolationParams,
  type IsolationResult,
} from "./isolation.ts";

export {
  makeAiwLogger,
  nullAiwLogger,
  logPhaseStart,
  logPhaseEnd,
  logAiwEvent,
  recordPhasePrompt,
  type AiwLogger,
} from "./logging.ts";

export { recordRun, readSnapshot, recordFromAiw, type KpisSnapshot, type RunRecord } from "./kpis.ts";

export { checkAfkGate, readGate, unlockZte, readOverrides, DEFAULT_AFK_THRESHOLD, type GateResult, type AfkOverride } from "./afk-gate.ts";
export { runShipPhase, type ShipPhaseArgs, type ShipPhaseResult, type ExecLayer } from "./ship.ts";

export { runPhase, runWorkflow } from "./runtime.ts";
export { PHASE_SKILL, PHASE_TOOLS, PHASE_SYSTEM_PROMPT } from "./runtime.ts";

export { runPlanBuild } from "./workflows/plan-build.ts";
export { runPlanBuildReview } from "./workflows/plan-build-review.ts";
export { runPlanBuildReviewFix } from "./workflows/plan-build-review-fix.ts";
export { runPlanBuildReviewShip } from "./workflows/plan-build-review-ship.ts";

