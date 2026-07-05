// workflows/plan-build-review.ts — 3-phase orchestrator.
//
// Phases: plan → build → review (always).
//
// The review phase runs unconditionally. The verdict (`success:
// bool`) is recorded in `state.phases[review]` and is consulted by
// the *fix* phase in the 4-phase workflow. Here, the verdict is
// pure metadata — the workflow ends after review regardless.

import { runWorkflow, type RunWorkflowArgs } from "../runtime.ts";

export interface RunPlanBuildReviewArgs extends Omit<RunWorkflowArgs, "state"> {
  state: RunWorkflowArgs["state"];
}

export async function runPlanBuildReview(args: RunPlanBuildReviewArgs): ReturnType<typeof runWorkflow> {
  return runWorkflow({ ...args, state: { ...args.state, workflow: "plan_build_review" } });
}