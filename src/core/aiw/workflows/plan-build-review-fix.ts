// workflows/plan-build-review-fix.ts — 4-phase orchestrator.
//
// Phases: plan → build → review → fix (conditional).
//
// The `fix` phase only runs when the preceding review verdict is
// `success: false` (i.e., at least one `blocker` issue). The
// workflow runner consults the review result JSON to decide.
//
// This is the canonical "Plan, build, review, fix blockers" chain —
// the local form of the same cycle the GitHub Actions CI implements
// (`scaffold/.github/workflows/agent-implement.yml` +
// `agent-review.yml`), but in-process and fully observable.

import { runWorkflow, type RunWorkflowArgs } from "../runtime.ts";

export interface RunPlanBuildReviewFixArgs extends Omit<RunWorkflowArgs, "state"> {
  state: RunWorkflowArgs["state"];
}

export async function runPlanBuildReviewFix(
  args: RunPlanBuildReviewFixArgs,
): ReturnType<typeof runWorkflow> {
  return runWorkflow({ ...args, state: { ...args.state, workflow: "plan_build_review_fix" } });
}