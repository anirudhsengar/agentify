// aiw-bridge.ts — the orchestrator's typed wrapper over AiwRunner.
//
// `start_aiw` and `check_aiw` (the two AIW-flavored management
// tools in the orchestrator's allowlist) both route here. The
// bridge:
//
//   1. Validates orchestrator-supplied args (workflow is one of the
//      4 valid WorkflowNames; prompt is non-empty; aiw_id is
//      unique among live AIWs).
//   2. Calls AiwRunner.run() / .show() / .list() and translates
//      the result into a payload the LLM can read.
//   3. Returns the payload to the orchestrator; the orchestrator
//      reports back to the user.
//
// Nothing about the AIW engine changes — this is composition, not
// invention. The webhook's `aiw_workflow` trigger and the CLI's
// `agentify aiw run` continue to call AiwRunner directly.

import {
  startAiwRunner,
  type AiwRunner,
} from "../aiw/index.ts";
import {
  AiwStatus,
  WorkflowName,
} from "../aiw/state.ts";
import {
  aiwStatePaths,
  readAiwEvents,
} from "../aiw/paths.ts";

export interface StartAiwArgs {
  name_of_aiw: string;
  workflow_type: string;
  prompt: string;
  description?: string;
  change_type?: string;
}

export interface StartAiwResult {
  aiw_id: string;
  name_of_aiw: string;
  workflow: string;
  status: string;
  started_at: string;
  source: string;
}

export interface CheckAiwArgs {
  tail_count?: number;
  event_type?: string;
  include_step_details?: boolean;
}

export interface CheckAiwResult {
  aiw_id: string;
  status: string;
  workflow: string;
  working_dir: string;
  branch_name: string;
  started_at: string;
  ended_at: string | null;
  attempts: number;
  current_step: string | null;
  phases: Array<{
    phase: string;
    status: string;
    started_at: string | null;
    ended_at: string | null;
    turns: number;
    cost_usd: number | null;
    error_message: string | null;
  }>;
  total_cost_usd: number;
  recent_events: Array<{ at: string; kind: string; phase?: string; fields?: Record<string, unknown> }>;
}

const VALID_WORKFLOWS: ReadonlyArray<string> = [
  WorkflowName.PlanBuild,
  WorkflowName.PlanBuildReview,
  WorkflowName.PlanBuildReviewFix,
  WorkflowName.PlanBuildReviewShip,
];

const VALID_CLASSIFICATIONS: ReadonlyArray<string> = [
  "chore", "bug", "feature", "unknown",
];

export interface AiwBridgeOptions {
  configDir: string;
  cwd: string;
  noWorktree?: boolean;
}

export class AiwBridge {
  private readonly runner: AiwRunner;
  private readonly configDir: string;

  constructor(opts: AiwBridgeOptions) {
    this.configDir = opts.configDir;
    this.runner = startAiwRunner({
      configDir: opts.configDir,
      cwd: opts.cwd,
      noWorktree: opts.noWorktree,
    });
  }

  /**
   * Validate args. Throws on any invalid input.
   */
  validateStartAiwArgs(args: StartAiwArgs): void {
    if (!args.name_of_aiw || typeof args.name_of_aiw !== "string") {
      throw new Error("start_aiw: name_of_aiw is required");
    }
    if (!args.workflow_type || !VALID_WORKFLOWS.includes(args.workflow_type)) {
      throw new Error(
        `start_aiw: workflow_type must be one of ${VALID_WORKFLOWS.join(", ")}`,
      );
    }
    if (!args.prompt || typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
      throw new Error("start_aiw: prompt is required");
    }
    if (args.change_type !== undefined && !VALID_CLASSIFICATIONS.includes(args.change_type)) {
      throw new Error(
        `start_aiw: change_type must be one of ${VALID_CLASSIFICATIONS.join(", ")}`,
      );
    }
  }

  /**
   * Start an AIW. Returns the new aiw_id immediately; the workflow
   * runs in the background.
   */
  async startAiw(args: StartAiwArgs, opts: { source?: string; signal?: AbortSignal } = {}): Promise<StartAiwResult> {
    this.validateStartAiwArgs(args);
    const source = opts.source ?? "orchestrator";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = await this.runner.run({
      workflow: args.workflow_type as any,
      prompt: args.prompt,
      changeType: (args.change_type ?? "unknown") as never,
      source,
      signal: opts.signal,
    });
    return {
      aiw_id: state.aiw_id,
      name_of_aiw: args.name_of_aiw,
      workflow: state.workflow,
      status: state.status,
      started_at: state.started_at,
      source,
    };
  }

  /**
   * Check the status of an AIW. Returns the full state + recent
   * events tail.
   */
  checkAiw(aiwId: string, opts: CheckAiwArgs = {}): CheckAiwResult {
    const state = this.runner.show(aiwId);
    if (!state) {
      throw new Error(`check_aiw: aiw_id "${aiwId}" not found`);
    }
    const paths = aiwStatePaths(this.configDir, aiwId);
    const events = readAiwEvents(paths);

    let filteredEvents = events;
    if (opts.event_type) {
      filteredEvents = filteredEvents.filter((e) => e.kind.includes(opts.event_type!));
    }
    if (opts.tail_count !== undefined && opts.tail_count > 0) {
      filteredEvents = filteredEvents.slice(-opts.tail_count);
    }

    return {
      aiw_id: state.aiw_id,
      status: state.status,
      workflow: state.workflow,
      working_dir: state.working_dir,
      branch_name: state.branch_name,
      started_at: state.started_at,
      ended_at: state.ended_at,
      attempts: state.attempts,
      current_step: state.current_step,
      phases: state.phases.map((p) => ({
        phase: p.phase,
        status: p.status,
        started_at: p.started_at,
        ended_at: p.ended_at,
        turns: p.turns,
        cost_usd: p.cost_usd,
        error_message: p.error_message,
      })),
      total_cost_usd: state.phases.reduce((acc, p) => acc + (p.cost_usd ?? 0), 0),
      recent_events: filteredEvents,
    };
  }

  /**
   * List all live (non-terminal) AIWs. For the orchestrator's
   * report_cost.
   */
  listLiveAiw(): Array<{ aiw_id: string; workflow: string; cost_usd: number | null; status: string }> {
    const all = this.runner.list();
    return all
      .filter((s) =>
        s.status !== AiwStatus.Completed &&
        s.status !== AiwStatus.Failed &&
        s.status !== AiwStatus.Aborted
      )
      .map((s) => ({
        aiw_id: s.aiw_id,
        workflow: s.workflow,
        cost_usd: s.phases.reduce((acc, p) => acc + (p.cost_usd ?? 0), 0),
        status: s.status,
      }));
  }

  /**
   * List ALL AIWs (live + terminal) for richer reports.
   */
  listAllAiw(): Array<{ aiw_id: string; workflow: string; cost_usd: number | null; status: string }> {
    return this.runner.list().map((s) => ({
      aiw_id: s.aiw_id,
      workflow: s.workflow,
      cost_usd: s.phases.reduce((acc, p) => acc + (p.cost_usd ?? 0), 0),
      status: s.status,
    }));
  }
}