// ship.ts — the ship phase: push the worktree branch, open a PR,
// merge it via `gh pr merge --squash`.
//
// The ship phase is the terminal phase of the
// `plan_build_review_ship` workflow. It is the only phase that
// can affect state outside the worktree: it pushes the branch to
// origin, opens or finds a PR, and (if AFK is earned) merges the
// PR. The merge is the "ship to main" moment.
//
// Security model:
//   - The phase runs through the same `runtime.runSession()` as
//     every other phase, with the same defense hook. `git push --force`,
//     `gh pr merge --force`, and other dangerous patterns are
//     blocked by the blacklist (see src/core/audit/defense/blacklist.ts).
//   - The ship phase needs `bash` (for git + gh). It does NOT
//     need `write` or `edit` — shipping is push + PR, not code
//     change.
//   - The branch is named `aiw/<aiw_id>` and is unique per AIW.
//     Force-push is rejected by the defense hook.
//
// The function `runShipPhase()` is called by the workflow runner
// when the ship phase starts. It is a pure function of the
// runtime + state + changeType + force flag; it returns a
// `ShipPhaseResult` the runner records in the state.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AiwLogger } from "./logging.ts";
import { logPhaseStart, logPhaseEnd } from "./logging.ts";
import { skipPhase, failPhase, type AiwState, type ChangeType } from "./state.ts";
import { writeAiwState, type AiwPaths } from "./paths.ts";
import { checkAfkGate, readGate, type GateResult } from "./afk-gate.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShipPhaseArgs {
  paths: AiwPaths;
  state: AiwState;
  /** The worktree path (the cwd for `git push`). */
  cwd: string;
  /** The project root (used to call `gh` from the right dir). */
  workingDir: string;
  /** ChangeType for the AFK gate check. */
  changeType: ChangeType;
  /** The git remote to push to. Default: "origin". */
  remote?: string;
  /** The base branch to open the PR against. Default: "main". */
  baseBranch?: string;
  signal?: AbortSignal;
  logger: AiwLogger;
  /** Skip the gate check (admin override). */
  force?: boolean;
  /** Override the exec layer (for tests). */
  exec?: ExecLayer;
}

export interface ShipPhaseResult {
  status: "shipped" | "skipped" | "gate_denied" | "error";
  prUrl?: string;
  errorMessage?: string;
  gateResult: GateResult;
}

/**
 * Abstraction over `execFile` for testability. The default
 * implementation runs real subprocesses; tests inject a stub.
 */
export interface ExecLayer {
  execFile(
    file: string,
    args: string[],
    options: { cwd: string },
  ): Promise<{ stdout: string; stderr: string }>;
  which(binary: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Default exec layer
// ---------------------------------------------------------------------------

const realExecLayer: ExecLayer = {
  async execFile(file, args, options) {
    return execFileAsync(file, args, { ...options, encoding: "utf-8" }) as Promise<{
      stdout: string;
      stderr: string;
    }>;
  },
  async which(binary) {
    try {
      await execFileAsync("which", [binary], { encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// runShipPhase
// ---------------------------------------------------------------------------

export async function runShipPhase(args: ShipPhaseArgs): Promise<ShipPhaseResult> {
  const {
    paths,
    state,
    cwd,
    workingDir,
    changeType,
    remote = "origin",
    baseBranch = "main",
    logger,
    force,
    exec = realExecLayer,
  } = args;

  // 1. Gate check.
  const configDir = paths.aiwRoot.replace(/\/aiw(\/[^/]+)?$/, "");
  const gate = readGate(configDir, changeType);
  if (!gate.allowed && !force) {
    logger.warn(`ship blocked by AFK gate`, { aiw_id: state.aiw_id, gate });
    const skipped = skipPhase(state, "ship");
    // Annotate the skip with the gate reason.
    const phases = skipped.phases.map((p) =>
      p.phase === "ship"
        ? { ...p, error_message: `AFK gate: ${gate.reason}` }
        : p,
    );
    const annotated: AiwState = { ...skipped, phases, gate_passed: false };
    writeAiwState(paths, annotated);
    logPhaseStart(paths, annotated, "ship");
    logPhaseEnd(paths, annotated, "ship", {
      status: "skipped",
      costUsd: null,
      turns: 0,
      errorMessage: gate.reason,
    });
    return { status: "skipped", gateResult: gate };
  }

  // 2. Tooling check.
  if (!(await exec.which("git"))) {
    return await failShip(paths, state, logger, "git not found on PATH");
  }
  if (!(await exec.which("gh"))) {
    return await failShip(paths, state, logger, "gh not found on PATH; ship phase requires GitHub CLI");
  }

  // 3. Push the branch.
  const branch = state.branch_name;
  logPhaseStart(paths, state, "ship");
  try {
    await exec.execFile("git", ["push", "-u", remote, branch], { cwd });
    logger.info(`pushed branch ${branch} to ${remote}`, { aiw_id: state.aiw_id });
  } catch (err) {
    const message = (err as Error).message;
    // If push fails because the branch is already up-to-date,
    // proceed. Otherwise fail.
    if (!/up-to-date|everything up-to-date/i.test(message)) {
      return await failShip(paths, state, logger, `git push failed: ${message}`);
    }
  }

  // 4. Open or find a PR.
  let prUrl: string | undefined;
  try {
    prUrl = await findOrCreatePr({
      exec,
      cwd: workingDir,
      branch,
      baseBranch,
      title: prTitle(state),
      body: prBody(state),
    });
  } catch (err) {
    return await failShip(paths, state, logger, `gh pr create failed: ${(err as Error).message}`);
  }

  // 5. Merge (only if the gate was earned; force override also merges).
  if (gate.allowed || force) {
    try {
      await exec.execFile("gh", ["pr", "merge", prUrl, "--squash", "--delete-branch"], {
        cwd: workingDir,
      });
      logger.info(`merged PR ${prUrl}`, { aiw_id: state.aiw_id, force: !!force });
    } catch (err) {
      // The PR exists but `gh pr merge` failed (e.g., branch
      // protection, missing reviews). Record the error but
      // don't fail the workflow — the PR is open and the user
      // can merge manually.
      const message = (err as Error).message;
      logger.error(`gh pr merge failed`, { aiw_id: state.aiw_id, prUrl, error: message });
      const merged: AiwState = {
        ...state,
        phases: state.phases.map((p) =>
          p.phase === "ship"
            ? {
                ...p,
                status: "error" as const,
                ended_at: new Date().toISOString(),
                error_message: `gh pr merge failed: ${message} (PR is open at ${prUrl})`,
              }
            : p,
        ),
        current_step: null,
      };
      writeAiwState(paths, merged);
      return {
        status: "error",
        prUrl,
        errorMessage: `gh pr merge failed: ${message}`,
        gateResult: gate,
      };
    }
  }

  // 6. Mark the phase done.
  const shipped: AiwState = {
    ...state,
    phases: state.phases.map((p) =>
      p.phase === "ship"
        ? { ...p, status: "done" as const, ended_at: new Date().toISOString() }
        : p,
    ),
    current_step: null,
  };
  writeAiwState(paths, shipped);
  logPhaseEnd(paths, shipped, "ship", { status: "done", costUsd: 0, turns: 0 });
  return { status: "shipped", prUrl, gateResult: gate };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function failShip(
  paths: AiwPaths,
  state: AiwState,
  logger: AiwLogger,
  message: string,
): Promise<ShipPhaseResult> {
  logger.error(`ship phase failed`, { aiw_id: state.aiw_id, message });
  const failed = failPhase(state, "ship", message);
  writeAiwState(paths, failed);
  logPhaseEnd(paths, failed, "ship", { status: "error", costUsd: null, turns: 0, errorMessage: message });
  return { status: "error", errorMessage: message, gateResult: { allowed: false, reason: message, currentStreak: 0, threshold: 0, changeType: "unknown", unlocked: false } };
}

async function findOrCreatePr(args: {
  exec: ExecLayer;
  cwd: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<string> {
  const { exec, cwd, branch, baseBranch, title, body } = args;
  // First, see if a PR already exists for this branch.
  try {
    const { stdout } = await exec.execFile(
      "gh",
      ["pr", "list", "--head", branch, "--base", baseBranch, "--json", "url", "--jq", ".[0].url"],
      { cwd },
    );
    const url = stdout.trim();
    if (url) return url;
  } catch {
    // No PR or `gh` errored; fall through to create.
  }
  // Create a new PR.
  const { stdout } = await exec.execFile(
    "gh",
    [
      "pr", "create",
      "--base", baseBranch,
      "--head", branch,
      "--title", title,
      "--body", body,
    ],
    { cwd },
  );
  const url = stdout.trim().split("\n").pop() ?? "";
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`gh pr create returned an unexpected URL: ${url}`);
  }
  return url;
}

function prTitle(state: AiwState): string {
  // First 60 chars of the prompt + the aiw_id for traceability.
  const firstLine = state.prompt.split("\n")[0]?.slice(0, 60).trim() ?? state.prompt.slice(0, 60).trim();
  return `aiw/${state.aiw_id}: ${firstLine}`.slice(0, 70);
}

function prBody(state: AiwState): string {
  return [
    `## AIW ${state.aiw_id}`,
    "",
    `Workflow: ${state.workflow}`,
    `Branch: \`${state.branch_name}\``,
    `Worktree: \`${state.worktree_path}\``,
    `Change type: ${state.changeType}`,
    "",
    "### Phases",
    ...state.phases.map((p) => `- [${p.status === "done" ? "x" : " "}] ${p.phase}`),
    "",
    "### Original request",
    "",
    state.prompt,
    "",
    "---",
    "",
    "This PR was opened by an AI Developer Workflow in away-from-keyboard mode.",
  ].join("\n");
}

// Re-export for the runtime module.
export { readGate, checkAfkGate };