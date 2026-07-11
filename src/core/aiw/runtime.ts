// runtime.ts — the AIW phase runner.
//
// A `phase` is one slice of a workflow (e.g. "plan", "build", "review",
// "fix"). `runPhase()` is the unit of orchestration:
//
//   1. Build a fresh `AgentRuntimeSessionOptions` for the phase
//      (different prompt, different tools, different cwd = the worktree).
//   2. Call `runtime.runSession()` — a fresh agent session every time.
//      This is the "One Agent, One Prompt, One Purpose" rule from
//      `principles/13-agentic-layer.md`.
//   3. Forward every `AgentSessionEvent` to `logAiwEvent()` for the
//      per-phase audit trail.
//   4. Capture turns, cost, and the agent's text output.
//   5. If the phase has a JSON contract (review → ReviewResult,
//      build → ImplementResult), parse it from the agent's last
//      message and write it to disk so subsequent phases can read it.
//
// `runPhase()` is a pure function of the runtime + state + phase +
// prompt. It's called by `index.ts` (the workflow runner) and reused
// by every workflow.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PiSdkRuntime, shippedSkillsDir } from "../pi-sdk-runtime.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
} from "../types.ts";
import {
  logAiwEvent,
  recordPhasePrompt,
  ensurePhaseAgentDir,
  logPhaseEnd,
  logPhaseStart,
  type AiwLogger,
} from "./logging.ts";
import { runShipPhase } from "./ship.ts";
import type { AiwPaths } from "./paths.ts";
import {
  AiwStatus,
  PhaseName,
  PhaseStatus,
  PHASES_FOR,
  abortAiw,
  completeAiw,
  failAiw,
  failPhase,
  finishPhase,
  getPhase,
  isTerminal,
  skipPhase,
  startPhase,
  updatePhase,
  type AiwState,
  type PhaseName as PhaseNameT,
  type WorkflowName,
} from "./state.ts";
import { readAiwState, writeAiwState } from "./paths.ts";
import {
  createReadOnlyExecutionPolicy,
  createRepositoryWriteExecutionPolicy,
} from "../security/execution-policy.ts";

// ---------------------------------------------------------------------------
// Phase skill + tools map
// ---------------------------------------------------------------------------

/**
 * The skill that backs each phase. The agent for the phase runs the
 * corresponding prompt template (the SKILL.md under
 * `.agents/skills/<skill>/SKILL.md`).
 */
export const PHASE_SKILL: Record<PhaseNameT, string> = {
  plan: "spec",
  build: "implement",
  review: "review",
  fix: "fix",
  ship: "ship",
};

/**
 * The default tool allowlist per phase. Matches the patterns in
 * `.agents/skills/<skill>/SKILL.md` — review is read-only by design.
 */
export const PHASE_TOOLS: Record<PhaseNameT, ReadonlyArray<string>> = {
  plan: ["read", "grep", "find", "ls", "bash", "write"],
  build: ["read", "grep", "find", "ls", "bash", "write", "edit"],
  review: ["read", "grep", "find", "ls"],
  fix: ["read", "grep", "find", "ls", "bash", "write", "edit"],
  // Ship needs bash for `git push` and `gh pr create/merge`. The
  // defense hook (BLACKLIST in src/core/audit/defense/blacklist.ts) blocks
  // `git push --force`, `gh pr merge --force`, and other dangerous
  // patterns. No write/edit — shipping is push + PR, not code change.
  ship: ["read", "grep", "find", "ls", "bash"],
};

/**
 * Per-phase system prompt additions. These are appended to the
 * default system prompt so the agent knows what phase it's running.
 */
export const PHASE_SYSTEM_PROMPT: Record<PhaseNameT, string> = {
  plan: [
    "You are running the PLAN phase of an AI Developer Workflow (AIW).",
    "Read the user prompt below; produce a structured plan at `specs/<slug>.md`.",
    "The plan must end with a `## Validation Commands` section.",
    "Do not implement. Do not commit. Do not push.",
  ].join("\n"),
  build: [
    "You are running the BUILD phase of an AIW.",
    "Read the plan file in your working directory (look for the most recent `specs/*.md`).",
    "Implement what the plan describes. Run the plan's `## Validation Commands` before declaring done.",
    "Write a `ImplementResult` JSON summary at the end so the workflow can read it.",
    "Do not push. Do not open a PR.",
  ].join("\n"),
  review: [
    "You are running the REVIEW phase of an AIW.",
    "Review the implementation against the plan. Output a `ReviewResult` JSON object with",
    "  { success: boolean, review_summary, review_issues[], screenshots[] }.",
    "severity is one of: skippable | tech_debt | blocker. success is true iff there are zero blockers.",
    "Read-only: you may not edit code. You may run `bash` to inspect.",
  ].join("\n"),
  fix: [
    "You are running the FIX phase of an AIW.",
    "Read the `ReviewResult` and the plan. Resolve every `blocker` issue with a minimal patch.",
    "Re-run the plan's `## Validation Commands` after each patch.",
    "Do not widen scope. Do not push. Do not open a PR.",
  ].join("\n"),
  ship: [
    "You are running the SHIP phase of an AI Developer Workflow (AIW).",
    "Push the current branch to origin. Open a PR. Merge if AFK is earned.",
    "Use `git push -u origin <branch>`, then `gh pr create`, then `gh pr merge --squash`.",
    "If a PR already exists, capture its URL via `gh pr list --head <branch>` and merge it.",
    "Do not edit code. Do not run tests. The previous phases already validated.",
    "Do NOT use `git push --force`, `gh pr merge --force`, or any destructive flag.",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// runPhase — the unit of orchestration
// ---------------------------------------------------------------------------

export interface RunPhaseArgs {
  paths: AiwPaths;
  state: AiwState;
  phase: PhaseNameT;
  /** Optional prompt override. If omitted, the phase skill's default
   *  prompt template is used. */
  userPrompt?: string;
  /** Per-phase cwd override. Defaults to `state.worktree_path`. */
  cwd?: string;
  /** Per-phase tools override. Defaults to `PHASE_TOOLS[phase]`. */
  tools?: ReadonlyArray<string>;
  runtime?: AgentRuntime;
  signal?: AbortSignal;
  logger: AiwLogger;
}

export interface RunPhaseResult {
  status: "done" | "error" | "skipped";
  costUsd: number | null;
  turns: number;
  aborted: boolean;
  errorMessage?: string;
  artifacts: {
    planPath: string | null;
    reviewPath: string | null;
    fixPath: string | null;
    implementResultPath: string | null;
  };
}

/**
 * Run a single AIW phase. The phase's agent runs in `cwd` (the
 * worktree) with the phase's tools and skill. Returns a result
 * suitable for `finishPhase()` / `failPhase()`.
 *
 * The state is updated and persisted to disk at each transition so a
 * crash mid-phase leaves a recoverable record.
 */
export async function runPhase(args: RunPhaseArgs): Promise<RunPhaseResult> {
  const {
    paths,
    state,
    phase,
    cwd,
    tools,
    runtime,
    signal,
    logger,
  } = args;
  const configDir = paths.aiwRoot.replace(/\/aiw(\/[^/]+)?$/, "");

  const phaseRecord = getPhase(state, phase);
  if (!phaseRecord) {
    const errorMessage = `phase "${phase}" is not part of workflow "${state.workflow}"`;
    logger.error(`phase lookup failed`, { aiw_id: state.aiw_id, phase, errorMessage });
    return {
      status: "error",
      costUsd: null,
      turns: 0,
      aborted: false,
      errorMessage,
      artifacts: { planPath: null, reviewPath: null, fixPath: null, implementResultPath: null },
    };
  }

  // Phase is already done / skipped — no-op.
  if (phaseRecord.status === PhaseStatus.Done || phaseRecord.status === PhaseStatus.Skipped) {
    logger.info(`phase already ${phaseRecord.status}, skipping`, { aiw_id: state.aiw_id, phase });
    return {
      status: "skipped",
      costUsd: phaseRecord.cost_usd,
      turns: phaseRecord.turns,
      aborted: false,
      artifacts: artifactsFromPhase(phaseRecord),
    };
  }

  // Start phase.
  const startedState = startPhase(state, phase);
  writeAiwState(paths, startedState);
  logPhaseStartHook(paths, startedState, phase);

  const phaseTools = tools ?? PHASE_TOOLS[phase];
  const phaseCwd = cwd ?? state.worktree_path;
  const skill = PHASE_SKILL[phase];

  // Build the user prompt — combine the phase skill, the AIW's
  // original prompt, and any artifacts from prior phases.
  const userPrompt = args.userPrompt ?? composeUserPrompt(state, phase, skill);
  recordPhasePrompt(paths, phase, userPrompt);

  // Ensure per-phase agent dir exists.
  const agentDir = ensurePhaseAgentDir(paths, phase);

  // Build session options. AIW phases consume the configured slot —
  // defaults to "lite" (Phase 3) so the brownfield/
  // greenfield builder (which uses primary) stays on the strongest
  // model the user has configured, while AIW runs on a cheaper model.
  const runtimeInstance = runtime ?? new PiSdkRuntime();
  const sessionOptions: AgentRuntimeSessionOptions = {
    cwd: phaseCwd,
    configDir,
    config: {
      model: state.model ?? undefined,
      thinkingLevel: normalizeThinkingLevel(state.thinking_level),
    },
    modelRole: normalizeModelRole(state.model_role) ?? "lite",
    systemPrompt: PHASE_SYSTEM_PROMPT[phase],
    userPrompt,
    tools: [...phaseTools],
    executionPolicy: phase === "review"
      ? createReadOnlyExecutionPolicy({
          cwd: phaseCwd,
          mode: "review-readonly",
          tools: phaseTools,
        })
      : createRepositoryWriteExecutionPolicy({
          cwd: phaseCwd,
          tools: phaseTools,
          allowDevelopmentCommands: phaseTools.includes("bash"),
        }),
    additionalSkillPaths: [shippedSkillsDir()],
    signal,
    onEvent: (event: AgentSessionEvent) => {
      logAiwEvent(paths, startedState, phase, event);
    },
  };

  // Run the agent.
  let result: AgentRuntimeResult;
  try {
    result = await runtimeInstance.runSession(sessionOptions);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`phase ${phase} failed`, { aiw_id: state.aiw_id, errorMessage });
    const failedState = failPhase(startedState, phase, errorMessage);
    writeAiwState(paths, failedState);
    logPhaseEndHook(paths, failedState, phase, { status: "error", costUsd: null, turns: 0, errorMessage });
    return {
      status: "error",
      costUsd: null,
      turns: 0,
      aborted: false,
      errorMessage,
      artifacts: { planPath: null, reviewPath: null, fixPath: null, implementResultPath: null },
    };
  }

  if (result.aborted) {
    const abortedState = failPhase(startedState, phase, "aborted");
    writeAiwState(paths, abortedState);
    logPhaseEndHook(paths, abortedState, phase, { status: "error", costUsd: null, turns: 0, errorMessage: "aborted" });
    return {
      status: "error",
      costUsd: null,
      turns: result.turns,
      aborted: true,
      errorMessage: "aborted",
      artifacts: { planPath: null, reviewPath: null, fixPath: null, implementResultPath: null },
    };
  }

  // Phase succeeded — extract any artifacts the skill produces.
  const artifacts = await extractPhaseArtifacts({
    paths,
    state: startedState,
    phase,
    agentDir,
    cwd: phaseCwd,
    costUsd: result.costUsd,
    turns: result.turns,
  });

  const finishedState = finishPhase(startedState, phase, {
    costUsd: result.costUsd,
    turns: result.turns,
    artifacts: {
      plan_path: artifacts.planPath,
      review_path: artifacts.reviewPath,
      fix_path: artifacts.fixPath,
    },
  });
  writeAiwState(paths, finishedState);
  logPhaseEndHook(paths, finishedState, phase, {
    status: "done",
    costUsd: result.costUsd,
    turns: result.turns,
  });

  return {
    status: "done",
    costUsd: result.costUsd,
    turns: result.turns,
    aborted: false,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

function composeUserPrompt(state: AiwState, phase: PhaseNameT, skill: string): string {
  const lines: string[] = [];
  lines.push(`[aiw ${state.aiw_id} — phase ${phase}]`);
  lines.push(`Workflow: ${state.workflow}`);
  lines.push(`Branch: ${state.branch_name}`);
  lines.push(`Working directory: ${state.worktree_path}`);
  lines.push("");
  lines.push(`Original request:`);
  lines.push(state.prompt);
  lines.push("");
  lines.push(`Skill to run: ${skill}`);
  // Phase-specific context from prior phases.
  if (phase === PhaseName.Build || phase === PhaseName.Review || phase === PhaseName.Fix) {
    const planPhase = state.phases.find((p) => p.phase === PhaseName.Plan);
    if (planPhase?.artifacts.plan_path) {
      lines.push(`Plan file: ${planPhase.artifacts.plan_path}`);
    }
  }
  if (phase === PhaseName.Fix) {
    const reviewPhase = state.phases.find((p) => p.phase === PhaseName.Review);
    if (reviewPhase?.artifacts.review_path) {
      lines.push(`Review file: ${reviewPhase.artifacts.review_path}`);
    }
  }
  lines.push("");
  lines.push("Execute the skill against the working directory. Follow the skill's contract exactly.");
  lines.push("Write any required JSON output to disk before finishing. Do not push or open a PR.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase artifact extraction
// ---------------------------------------------------------------------------

interface ExtractArgs {
  paths: AiwPaths;
  state: AiwState;
  phase: PhaseNameT;
  agentDir: string;
  cwd: string;
  costUsd: number | null;
  turns: number;
}

async function extractPhaseArtifacts(args: ExtractArgs): Promise<RunPhaseResult["artifacts"]> {
  const { phase, cwd } = args;
  // Default artifacts (most phases don't write a known artifact).
  const out: RunPhaseResult["artifacts"] = {
    planPath: null,
    reviewPath: null,
    fixPath: null,
    implementResultPath: null,
  };
  switch (phase) {
    case PhaseName.Plan: {
      // Find the most recently created specs/*.md in the worktree.
      out.planPath = findLatestPlanFile(cwd);
      break;
    }
    case PhaseName.Build: {
      // Look for the most recent ImplementResult JSON.
      out.implementResultPath = findLatestImplementResult(cwd);
      break;
    }
    case PhaseName.Review: {
      out.reviewPath = findLatestReviewResult(cwd);
      break;
    }
    case PhaseName.Fix: {
      out.fixPath = findLatestFixReport(cwd);
      break;
    }
  }
  return out;
}

function findLatestPlanFile(cwd: string): string | null {
  return findMostRecentFile(cwd, ["specs"], /\.md$/, 5);
}

function findLatestReviewResult(cwd: string): string | null {
  // /review writes to app_review/review_*.md (it embeds JSON in the
  // report; we record the path so /fix can read it).
  return findMostRecentFile(cwd, ["app_review"], /\.md$/, 5);
}

function findLatestFixReport(cwd: string): string | null {
  return findMostRecentFile(cwd, ["app_fix_reports"], /\.md$/, 5);
}

function findLatestImplementResult(cwd: string): string | null {
  return findMostRecentFile(cwd, ["app_docs", "."], /\.json$/, 5, "implement_result");
}

function findMostRecentFile(
  cwd: string,
  searchDirs: string[],
  pattern: RegExp,
  depth: number,
  filenameHint?: string,
): string | null {
  // Walk the searchDirs, find files matching `pattern`, return the
  // most recently modified. Cap at `depth` to keep this fast on
  // large repos.
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of searchDirs) {
    const root = path.join(cwd, dir);
    if (!existsSync(root)) continue;
    walk(root, depth, pattern, candidates, filenameHint);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]!.path;
}

function walk(
  dir: string,
  depth: number,
  pattern: RegExp,
  out: Array<{ path: string; mtimeMs: number }>,
  filenameHint?: string,
): void {
  if (depth < 0) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (pattern.test(entry.name)) {
        if (filenameHint && !entry.name.toLowerCase().includes(filenameHint.toLowerCase())) continue;
        try {
          const stat = statSync(full);
          out.push({ path: full, mtimeMs: stat.mtimeMs });
        } catch {
          // skip
        }
      }
    } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
      walk(full, depth - 1, pattern, out, filenameHint);
    }
  }
}

function artifactsFromPhase(phaseRecord: { artifacts: { plan_path: string | null; review_path: string | null; fix_path: string | null } }): RunPhaseResult["artifacts"] {
  return {
    planPath: phaseRecord.artifacts.plan_path,
    reviewPath: phaseRecord.artifacts.review_path,
    fixPath: phaseRecord.artifacts.fix_path,
    implementResultPath: null,
  };
}

function normalizeThinkingLevel(value: string | null): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!value) return undefined;
  if (value === "off" || value === "minimal" || value === "low"
      || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return undefined;
}

function normalizeModelRole(value: string | null): "primary" | "explorer" | "lite" | undefined {
  if (!value) return undefined;
  if (value === "primary" || value === "explorer" || value === "lite") {
    return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hook wrappers (centralized here so the worker can also call them)
// ---------------------------------------------------------------------------

function logPhaseStartHook(paths: AiwPaths, state: AiwState, phase: PhaseNameT): void {
  logPhaseStart(paths, state, phase);
}

function logPhaseEndHook(
  paths: AiwPaths,
  state: AiwState,
  phase: PhaseNameT,
  result: { status: "done" | "error" | "skipped"; costUsd: number | null; turns: number; errorMessage?: string },
): void {
  logPhaseEnd(paths, state, phase, result);
}

// ---------------------------------------------------------------------------
// runWorkflow — the orchestrator. Reusable by all 3 workflows.
// ---------------------------------------------------------------------------

export interface RunWorkflowArgs {
  paths: AiwPaths;
  state: AiwState;
  runtime?: AgentRuntime;
  signal?: AbortSignal;
  logger: import("./logging.ts").AiwLogger;
  /** For testing: skip the fix phase even if review says blocker. */
  forceNoFix?: boolean;
  /** For testing: ship even if the AFK gate denies. */
  forceShip?: boolean;
  /** Override the exec layer for the ship phase (tests). */
  shipExec?: import("./ship.ts").ExecLayer;
}

/**
 * Run a workflow end-to-end. The `state.workflow` field determines
 * which phases run. Returns the (possibly updated) `AiwState`.
 */
export async function runWorkflow(args: RunWorkflowArgs): Promise<AiwState> {
  let { paths, state, runtime, signal, logger } = args;
  const configDir = paths.aiwRoot.replace(/\/aiw(\/[^/]+)?$/, "");

  // Mark workflow as running.
  state = { ...state, status: AiwStatus.Running };
  writeAiwState(paths, state);

  const phases = PHASES_FOR[state.workflow];

  for (const phase of phases) {
    if (signal?.aborted) {
      logger.warn(`workflow aborted before phase ${phase}`, { aiw_id: state.aiw_id });
      const aborted = abortAiw(state);
      writeAiwState(paths, aborted);
      return aborted;
    }

    // Update current_step.
    state = { ...state, current_step: phase };
    writeAiwState(paths, state);

    // Conditional skip: fix only runs on review blocker. We read the
    // *live* state to find the review phase's artifact path because
    // it was only populated when the review phase finished.
    if (phase === PhaseName.Fix) {
      const liveReview = state.phases.find((p) => p.phase === PhaseName.Review);
      const reviewPath = liveReview?.artifacts.review_path ?? null;
      const review = readReviewResult(state, reviewPath);
      const reviewBlocked = review !== null && review.success === false;
      if (!reviewBlocked && !args.forceNoFix) {
        logger.info(`phase fix skipped (review passed)`, { aiw_id: state.aiw_id });
        state = skipPhase(state, phase);
        writeAiwState(paths, state);
        continue;
      }
      if (args.forceNoFix) {
        logger.info(`phase fix skipped (forceNoFix)`, { aiw_id: state.aiw_id });
        state = skipPhase(state, phase);
        writeAiwState(paths, state);
        continue;
      }
    }

    // Ship phase (away-from-keyboard): special branch that
    // doesn't go through runPhase(). It calls runShipPhase()
    // which is gate-checked and uses `git push` + `gh pr` instead
    // of an LLM invocation. The gate is checked here in the
    // runner (before any side effects); a denied gate marks the
    // phase as `skipped` and the workflow's terminal status is
    // `completed` (the work was done; delivery is deferred).
    if (phase === PhaseName.Ship) {
      logger.info(`phase ship starting`, { aiw_id: state.aiw_id, changeType: state.changeType });
      const shipResult = await runShipPhase({
        paths,
        state,
        cwd: state.worktree_path,
        workingDir: state.working_dir,
        changeType: state.changeType,
        logger,
        force: args.forceShip === true,
        exec: args.shipExec,
      });
      // The ship phase writes its own state. Read it back so the
      // runner's terminal status reflects the ship outcome.
      state = readAiwState(paths) ?? state;
      if (shipResult.status === "error") {
        // The PR is open but `gh pr merge` failed. The workflow
        // is still successful (the work was done) but the ship
        // step had an error. We mark the workflow as completed
        // so the kpis update; the error is in the phase record
        // for the user to see.
        logger.warn(`ship phase errored; PR is open`, {
          aiw_id: state.aiw_id,
          prUrl: shipResult.prUrl,
          error: shipResult.errorMessage,
        });
        state = { ...state, gate_passed: false };
        writeAiwState(paths, state);
      } else if (shipResult.status === "skipped") {
        logger.info(`ship phase skipped (gate denied)`, { aiw_id: state.aiw_id });
        state = { ...state, gate_passed: false };
        writeAiwState(paths, state);
      } else if (args.forceShip) {
        // Force-override: the gate was denied but we proceeded.
        // The audit log shows gate_passed: false so the force is
        // visible in the kpis.
        state = { ...state, gate_passed: false };
        writeAiwState(paths, state);
      } else {
        state = { ...state, gate_passed: true };
        writeAiwState(paths, state);
      }
      // Continue to the next phase (none, in a 5-phase workflow)
      // or end the loop. The `continue` falls through to the
      // attempts counter, which we DON'T increment for ship.
      continue;
    }

    logger.info(`phase ${phase} starting`, { aiw_id: state.aiw_id });
    const result = await runPhase({
      paths,
      state,
      phase,
      runtime,
      signal,
      logger,
    });

    if (result.status === "error") {
      logger.error(`workflow failed at phase ${phase}`, {
        aiw_id: state.aiw_id,
        errorMessage: result.errorMessage,
      });
      // Read back the latest state for the failed phase.
      state = readAiwState(paths) ?? state;
      const failed = failAiw(state, phase, result.errorMessage ?? "unknown");
      writeAiwState(paths, failed);
      return failed;
    }

    // Read back the latest state to capture any artifacts written by
    // the phase runner.
    state = readAiwState(paths) ?? state;

    // Increment attempts (plan + fix count).
    if (phase === PhaseName.Plan || phase === PhaseName.Fix) {
      state = { ...state, attempts: state.attempts + 1 };
      writeAiwState(paths, state);
    }
  }

  // Done.
  const completed = completeAiw(state);
  writeAiwState(paths, completed);
  logger.info(`workflow completed`, {
    aiw_id: state.aiw_id,
    workflow: state.workflow,
    attempts: state.attempts,
  });

  // Class 3 G3 v1.1: auto-trigger agent experts whose primary_paths
  // overlap the AIW's working dir. Per `principles/09-agent-experts.md`,
  // the LEARN phase is most valuable when it runs immediately after
  // ACT. We fire-and-forget the LEARN calls; failures are logged
  // but do not affect the AIW's terminal status.
  void scheduleExpertSelfImprove(args.state.working_dir, logger);

  return completed;
}

/**
 * Look up experts whose `primary_paths` overlap `workingDir` and
 * fire a LEARN run for each. Best-effort; failures are logged but
 * never thrown. This is the auto-trigger that closes the
 * ACT → LEARN → REUSE loop on every AIW completion.
 */
function scheduleExpertSelfImprove(workingDir: string, logger: AiwLogger): void {
  try {
    // Dynamic import to avoid a hard dep cycle with the agent-expert
    // module. The import is cached after first call.
    void import("../agent-expert.ts").then(async (mod) => {
      try {
        const registry = mod.ExpertRegistry.fromCwd(workingDir);
        if (registry.list().length === 0) return;
        // The AIW doesn't track touched paths in detail; use the
        // working dir as the single path. Future enhancements could
        // pass the git diff to scope the LEARN run.
        const matched = mod.expertsTouchedBy(registry, [workingDir]);
        if (matched.length === 0) return;
        const todayIso = new Date().toISOString();
        // Phase 3: resolve the lite slot for the LEARN run.
        // Best-effort — falls back to the syncer's default if
        // the slot can't be resolved (no auth, empty registry).
        let modelSlot: { provider: string; model: string } | undefined;
        let cfgDir = "";
        try {
          const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
          const { authPath, loadAgentifyConfig, defaultConfigDir } = await import("../agentify-config.ts");
          const { selectModelForRole } = await import("../models/resolver.ts");
          cfgDir = defaultConfigDir();
          const authStorage = AuthStorage.create(authPath(cfgDir));
          const registry2 = ModelRegistry.create(authStorage);
          const config = loadAgentifyConfig(cfgDir);
          const resolved = selectModelForRole(registry2, config, "lite");
          if (resolved) {
            modelSlot = { provider: resolved.model.provider, model: resolved.model.id };
          }
        } catch {
          // Best effort — leave modelSlot undefined.
        }
        for (const expert of matched) {
          try {
            const r = await mod.runSelfImprove(expert, workingDir, {
              todayIso,
              configDir: cfgDir,
              modelSlot,
            });
            logger.info(`expert self-improve scheduled`, {
              expert: r.expert,
              changed: r.changed,
              summary: r.summary,
            });
          } catch (err) {
            logger.warn(`expert self-improve failed`, {
              expert: expert.domain,
              err: (err as Error).message,
            });
          }
        }
      } catch (err) {
        logger.warn(`expert auto-trigger failed`, { err: (err as Error).message });
      }
    });
  } catch {
    // never let auto-trigger failure affect the AIW
  }
}

interface ReviewResultLite {
  success: boolean;
  review_issues: Array<{ issue_severity: string }>;
}

/**
 * Read a ReviewResult JSON if it can be located. Returns null on
 * any failure (missing file, malformed JSON, etc.). This is best-
 * effort: the workflow falls back to "no review" if it can't parse.
 *
 * Strategy: try to parse the entire file as JSON. If that fails,
 * look for a JSON object via balanced-brace matching (the review
 * skill may write Markdown with an embedded JSON block).
 */
function readReviewResult(state: AiwState, reviewPath: string | null): ReviewResultLite | null {
  if (!reviewPath) return null;
  try {
    if (!existsSync(reviewPath)) return null;
    const raw = readFileSync(reviewPath, "utf-8");
    // First try: the file is pure JSON.
    try {
      const parsed = JSON.parse(raw) as ReviewResultLite;
      return normalizeReview(parsed);
    } catch {
      // Fall through to embedded-JSON search.
    }
    // Second try: balanced-brace match for an embedded JSON object
    // whose contents include `"success"`.
    const obj = extractEmbeddedJsonObject(raw);
    if (!obj) return null;
    const parsed = JSON.parse(obj) as ReviewResultLite;
    return normalizeReview(parsed);
  } catch {
    return null;
  }
}

function normalizeReview(parsed: ReviewResultLite): ReviewResultLite | null {
  if (typeof parsed.success !== "boolean") return null;
  if (!Array.isArray(parsed.review_issues)) parsed.review_issues = [];
  return parsed;
}

/**
 * Find the first balanced JSON object in `raw` that contains the
 * substring `"success"`. Returns the matched substring or null.
 */
function extractEmbeddedJsonObject(raw: string): string | null {
  // Find every '{' that has a '"success"' somewhere after it (in the
  // same top-level object), then test balance.
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    if (raw.indexOf('"success"', i) === -1) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < raw.length; j++) {
      const c = raw[j]!;
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          return raw.slice(i, j + 1);
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { isTerminal } from "./state.ts";
export { completeAiw, failAiw, failPhase, finishPhase, getPhase, skipPhase, startPhase, updatePhase } from "./state.ts";