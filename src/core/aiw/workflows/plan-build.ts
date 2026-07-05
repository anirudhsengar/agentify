// workflows/plan-build.ts — 2-phase orchestrator.
//
// Phases: plan → build
//
// `runPlanBuild` is a thin wrapper around `runWorkflow`; its only job
// is to (a) compute the right `state.workflow` if it isn't set, and
// (b) hand off to `runWorkflow` with the configured runtime + logger.
//
// Each workflow script is ~30 lines. New workflows (e.g.
// `plan-build-test`, `plan-build-review-document`) are 30-line
// additions — the *pattern* is the product.

import { runWorkflow, type RunWorkflowArgs } from "../runtime.ts";

export interface RunPlanBuildArgs extends Omit<RunWorkflowArgs, "state"> {
  state: RunWorkflowArgs["state"];
}

export async function runPlanBuild(args: RunPlanBuildArgs): ReturnType<typeof runWorkflow> {
  return runWorkflow({ ...args, state: { ...args.state, workflow: "plan_build" } });
}