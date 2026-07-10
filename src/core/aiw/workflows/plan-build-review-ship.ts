// workflows/plan-build-review-ship.ts — 5-phase orchestrator (Class 2 Grade 2 AFK).
//
// Phases: plan → build → review → fix (conditional) → ship (gate-conditional).
//
// The `ship` phase is the differentiator from G2:
//   - It is the terminal phase of the workflow
//   - It calls `runShipPhase()` directly, not `runPhase()` (no LLM)
//   - It is gate-checked against the live kpis.md snapshot
//   - A denied gate marks the phase as `skipped`; the workflow
//     still terminates as `completed` (the work was done)
//
// This is the canonical "plan, build, review, fix blockers, ship"
// chain — the local form of the same cycle the GitHub Actions CI
// implements in `scaffold/.github/workflows/`, but in-process and
// fully observable end-to-end, including the merge.

import { runWorkflow, type RunWorkflowArgs } from "../runtime.ts";

export interface RunPlanBuildReviewShipArgs extends Omit<RunWorkflowArgs, "state"> {
  state: RunWorkflowArgs["state"];
}

export async function runPlanBuildReviewShip(
  args: RunPlanBuildReviewShipArgs,
): ReturnType<typeof runWorkflow> {
  return runWorkflow({ ...args, state: { ...args.state, workflow: "plan_build_review_ship" } });
}