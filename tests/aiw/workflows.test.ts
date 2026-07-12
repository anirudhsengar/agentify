// tests/aiw/workflows.test.ts — workflow composition tests.
//
// These tests use a stub AgentRuntime so we can exercise the
// orchestration without an LLM. They verify:
//   - 2-phase plan_build runs both phases in order
//   - 3-phase plan_build_review runs all 3 phases
//   - 4-phase plan_build_review_fix SKIPS fix when review passes
//   - 4-phase plan_build_review_fix RUNS fix when review blocks
//   - 5-phase plan_build_review_ship runs ship when gate earned
//   - 5-phase plan_build_review_ship SKIPS ship when gate denies
//   - State file is updated at each transition
//   - Per-phase events land in events.jsonl

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  aiwStatePaths,
  readAiwEvents,
  readAiwState,
} from "../../src/core/aiw/paths.ts";
import { runPlanBuild } from "../../src/core/aiw/workflows/plan-build.ts";
import { runPlanBuildReview } from "../../src/core/aiw/workflows/plan-build-review.ts";
import { runPlanBuildReviewFix } from "../../src/core/aiw/workflows/plan-build-review-fix.ts";
import { runPlanBuildReviewShip } from "../../src/core/aiw/workflows/plan-build-review-ship.ts";
import {
  makeQueuedAiwState,
  WorkflowName,
} from "../../src/core/aiw/state.ts";
import { nullAiwLogger } from "../../src/core/aiw/logging.ts";
import { aiwPaths } from "../../src/core/aiw/paths.ts";
import { recordRun } from "../../src/core/aiw/kpis.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
} from "../../src/core/types.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ExecLayer } from "../../src/core/aiw/ship.ts";

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-aiw-workflows-"));
}

/**
 * A stub runtime whose behavior is driven by the `phaseAction`
 * function. The default action returns canned agent text and
 * records the call. Tests inspect `calls` to verify the order and
 * arguments.
 */
function makeStubRuntime(phaseAction: (phase: string, options: AgentRuntimeSessionOptions) => Promise<{ text: string; turns: number; cost: number }>): AgentRuntime & {
  calls: Array<{ phase: string; options: AgentRuntimeSessionOptions }>;
} {
  const calls: Array<{ phase: string; options: AgentRuntimeSessionOptions }> = [];
  return {
    calls,
    async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
      // Detect phase from system prompt (the runtime module embeds
      // "PLAN phase" / "BUILD phase" / "REVIEW phase" / "FIX phase").
      const sys = options.systemPrompt;
      let phase = "unknown";
      if (sys.includes("PLAN phase")) phase = "plan";
      else if (sys.includes("BUILD phase")) phase = "build";
      else if (sys.includes("REVIEW phase")) phase = "review";
      else if (sys.includes("FIX phase")) phase = "fix";
      calls.push({ phase, options });
      const result = await phaseAction(phase, options);
      // Forward events to the onEvent callback so logAiwEvent
      // (which uses session.subscribe-style callbacks) gets a
      // chance to write to events.jsonl.
      if (options.onEvent) {
        const event: AgentSessionEvent = {
          type: "message_end",
          message: {
            role: "assistant",
            usage: { cost: { total: result.cost } },
          },
        } as unknown as AgentSessionEvent;
        options.onEvent(event);
      }
      return { turns: result.turns, costUsd: result.cost, aborted: false };
    },
    async runGreenfield(): Promise<AgentRuntimeResult> {
      throw new Error("not used");
    },
  };
}

function makeAiwState(configDir: string, workflow: WorkflowName): { aiwId: string; state: ReturnType<typeof makeQueuedAiwState> } {
  // Use a per-call unique aiwId + worktree path so tests don't share state.
  const tag = (configDir.split("/").pop() ?? "x").padEnd(16, "0").slice(0, 16).replace(/[^a-f0-9]/g, "a");
  const aiwId = tag.slice(0, 16);
  const worktreePath = path.join(configDir, "trees", aiwId);
  const state = makeQueuedAiwState({
    aiwId,
    workflow,
    prompt: "test prompt",
    workingDir: "/tmp/nonexistent",
    branchName: `aiw/${aiwId}`,
    worktreePath,
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });
  return { aiwId, state };
}

async function testPlanBuild(): Promise<void> {
  const configDir = tempConfigDir();
  const { aiwId, state } = makeAiwState(configDir, WorkflowName.PlanBuild);
  const paths = aiwStatePaths(configDir, aiwId);
  const runtime = makeStubRuntime(async (phase) => ({
    text: `output for ${phase}`,
    turns: 2,
    cost: 0.01,
  }));
  const finalState = await runPlanBuild({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
  });
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.phases.length, 2);
  assert.equal(finalState.phases[0]!.phase, "plan");
  assert.equal(finalState.phases[0]!.status, "done");
  assert.equal(finalState.phases[1]!.phase, "build");
  assert.equal(finalState.phases[1]!.status, "done");
  assert.equal(runtime.calls.length, 2);
  assert.equal(runtime.calls[0]!.phase, "plan");
  assert.equal(runtime.calls[1]!.phase, "build");
}

async function testPlanBuildReviewPasses(): Promise<void> {
  const configDir = tempConfigDir();
  const { aiwId, state } = makeAiwState(configDir, WorkflowName.PlanBuildReview);
  const paths = aiwStatePaths(configDir, aiwId);
  const runtime = makeStubRuntime(async (phase) => ({
    text: phase === "review" ? JSON.stringify({ success: true, review_summary: "ok", review_issues: [], screenshots: [] }) : `output for ${phase}`,
    turns: 2,
    cost: 0.01,
  }));
  const finalState = await runPlanBuildReview({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
  });
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.phases.length, 3);
  assert.equal(finalState.phases[2]!.status, "done");
}

async function testPlanBuildReviewFixSkipsFixOnPass(): Promise<void> {
  const configDir = tempConfigDir();
  const { aiwId, state } = makeAiwState(configDir, WorkflowName.PlanBuildReviewFix);
  const paths = aiwStatePaths(configDir, aiwId);
  const runtime = makeStubRuntime(async (phase) => ({
    text: phase === "review" ? JSON.stringify({ success: true, review_summary: "ok", review_issues: [], screenshots: [] }) : `output for ${phase}`,
    turns: 2,
    cost: 0.01,
  }));
  const finalState = await runPlanBuildReviewFix({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
  });
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.phases.length, 4);
  // Fix was skipped (review passed)
  assert.equal(finalState.phases[3]!.status, "skipped");
  // Only 3 calls to runSession (plan, build, review)
  assert.equal(runtime.calls.length, 3);
}

async function testPlanBuildReviewFixRunsFixOnBlock(): Promise<void> {
  const configDir = tempConfigDir();
  const { aiwId, state } = makeAiwState(configDir, WorkflowName.PlanBuildReviewFix);
  const paths = aiwStatePaths(configDir, aiwId);
  // Stub: review returns blocker; we'll have the orchestrator look
  // for the review file and find the JSON. We seed a fake review
  // file at the path the orchestrator would look for.
  const runtime = makeStubRuntime(async (phase, options) => {
    if (phase === "review") {
      // Write a review file in the cwd so readReviewResult finds it.
      const dir = path.join(options.cwd, "app_review");
      fs.mkdirSync(dir, { recursive: true });
      const reviewPath = path.join(dir, "review_test.md");
      const reviewJson = {
        success: false,
        review_summary: "found a blocker",
        review_issues: [
          { review_issue_number: 1, issue_description: "broken", issue_resolution: "fix it", issue_severity: "blocker" },
        ],
        screenshots: [],
      };
      fs.writeFileSync(reviewPath, JSON.stringify(reviewJson));
      return { text: JSON.stringify(reviewJson), turns: 2, cost: 0.01 };
    }
    return { text: `output for ${phase}`, turns: 2, cost: 0.01 };
  });

  const finalState = await runPlanBuildReviewFix({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
  });
  assert.equal(finalState.status, "completed");
  // All 4 phases ran
  assert.equal(runtime.calls.length, 4);
  assert.equal(runtime.calls[3]!.phase, "fix");
  assert.equal(finalState.phases[3]!.status, "done");
}

async function testPhaseErrorFailsWorkflow(): Promise<void> {
  const configDir = tempConfigDir();
  const { aiwId, state } = makeAiwState(configDir, WorkflowName.PlanBuild);
  const paths = aiwStatePaths(configDir, aiwId);
  const runtime = makeStubRuntime(async (phase) => {
    if (phase === "build") {
      throw new Error("build crashed");
    }
    return { text: "ok", turns: 1, cost: 0.01 };
  });
  const finalState = await runPlanBuild({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
  });
  assert.equal(finalState.status, "failed");
  assert.equal(finalState.error_step, "build");
  assert.match(finalState.error_message ?? "", /build crashed/);
}

async function testStatePersistedAtEachStep(): Promise<void> {
  const configDir = tempConfigDir();
  const { aiwId, state } = makeAiwState(configDir, WorkflowName.PlanBuild);
  const paths = aiwStatePaths(configDir, aiwId);
  const runtime = makeStubRuntime(async (phase) => ({ text: phase, turns: 1, cost: 0.01 }));
  await runPlanBuild({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
  });
  // After completion, the state.json should reflect the final state.
  const final = readAiwState(paths);
  assert.ok(final);
  assert.equal(final!.status, "completed");
  assert.equal(final!.phases[0]!.status, "done");
  assert.equal(final!.phases[1]!.status, "done");
  // Events log has entries for both phases.
  const events = readAiwEvents(paths);
  // 2 phases × 2 events (start, end) = 4
  assert.ok(events.length >= 4);
}

async function testEachPhaseGetsFreshSession(): Promise<void> {
  const configDir = tempConfigDir();
  const { aiwId, state } = makeAiwState(configDir, WorkflowName.PlanBuild);
  const paths = aiwStatePaths(configDir, aiwId);
  const runtime = makeStubRuntime(async (phase) => ({ text: phase, turns: 1, cost: 0.01 }));
  await runPlanBuild({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
  });
  // Each call must have its own session (different cwd / prompt /
  // systemPrompt). Verify the system prompts are different.
  assert.equal(runtime.calls.length, 2);
  assert.notEqual(runtime.calls[0]!.options.systemPrompt, runtime.calls[1]!.options.systemPrompt);
  // Tools differ by phase: plan includes "write", build includes "edit".
  assert.ok(runtime.calls[0]!.options.tools.includes("write"));
  assert.ok(runtime.calls[1]!.options.tools.includes("edit"));
}

function makeShipExec(): ExecLayer & { calls: Array<{ file: string; args: string[]; cwd: string }> } {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  return {
    calls,
    async execFile(file, args, options) {
      calls.push({ file, args, cwd: options.cwd });
      if (file === "git" && args[0] === "push") return { stdout: "", stderr: "" };
      if (file === "gh" && args[0] === "pr" && args[1] === "list") return { stdout: "", stderr: "" };
      if (file === "gh" && args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://github.com/me/repo/pull/42\n", stderr: "" };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "merge") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    async which(binary) {
      return binary === "git" || binary === "gh";
    },
  };
}

function earnZte(configDir: string, changeType: "chore" | "bug" | "feature", count: number = 5): void {
  const paths = aiwPaths(configDir);
  for (let i = 0; i < count; i++) {
    recordRun(paths, {
      aiwId: `prereq-${changeType}-${i}`,
      changeType,
      at: new Date(Date.now() - (count - i) * 1000).toISOString(),
      attempts: 1,
      planLines: null,
      diffStat: null,
      oneAttempt: true,
    });
  }
}

async function testPlanBuildReviewShipSkipsWhenGateDenies(): Promise<void> {
  const configDir = tempConfigDir();
  const { aiwId, state } = makeAiwState(configDir, WorkflowName.PlanBuildReviewShip);
  // Override changeType to "feature" and DON'T pre-earn.
  state.changeType = "feature";
  const paths = aiwStatePaths(configDir, aiwId);
  const runtime = makeStubRuntime(async (phase) => ({ text: phase, turns: 1, cost: 0.01 }));
  const shipExec = makeShipExec();

  const finalState = await runPlanBuildReviewShip({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
    shipExec,
  });

  assert.equal(finalState.status, "completed");
  assert.equal(finalState.phases.length, 5);
  // The first 4 phases ran.
  assert.equal(finalState.phases[0]!.status, "done");
  assert.equal(finalState.phases[1]!.status, "done");
  assert.equal(finalState.phases[2]!.status, "done");
  // Fix was skipped because the stub review returned success:true.
  assert.equal(finalState.phases[3]!.status, "skipped");
  // Ship was skipped because the gate denied.
  assert.equal(finalState.phases[4]!.status, "skipped");
  assert.equal(finalState.phases[4]!.phase, "ship");
  assert.match(finalState.phases[4]!.error_message ?? "", /AFK/);
  assert.equal(finalState.gate_passed, false);
  // Ship exec was NOT called.
  const shipCalls = shipExec.calls.filter((c) => c.file === "git" || c.file === "gh");
  assert.equal(shipCalls.length, 0);
}

async function testPlanBuildReviewShipRunsShipWhenGateEarned(): Promise<void> {
  const configDir = tempConfigDir();
  earnZte(configDir, "chore", 5);
  const { aiwId, state } = makeAiwState(configDir, WorkflowName.PlanBuildReviewShip);
  state.changeType = "chore";
  const paths = aiwStatePaths(configDir, aiwId);
  const runtime = makeStubRuntime(async (phase) => ({ text: phase, turns: 1, cost: 0.01 }));
  const shipExec = makeShipExec();

  const finalState = await runPlanBuildReviewShip({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
    shipExec,
  });

  assert.equal(finalState.status, "completed");
  // All 5 phases ran (4 + ship done).
  assert.equal(finalState.phases[4]!.status, "done");
  assert.equal(finalState.gate_passed, true);
  // Ship was actually called.
  const shipCalls = shipExec.calls.filter((c) => c.file === "git" || c.file === "gh");
  assert.ok(shipCalls.length > 0);
  const pushCall = shipCalls.find((c) => c.file === "git" && c.args[0] === "push");
  const mergeCall = shipCalls.find((c) => c.file === "gh" && c.args[1] === "merge");
  assert.ok(pushCall);
  assert.ok(mergeCall);
}

async function testPlanBuildReviewShipForceOverride(): Promise<void> {
  const configDir = tempConfigDir();
  const { aiwId, state } = makeAiwState(configDir, WorkflowName.PlanBuildReviewShip);
  state.changeType = "feature";
  const paths = aiwStatePaths(configDir, aiwId);
  const runtime = makeStubRuntime(async (phase) => ({ text: phase, turns: 1, cost: 0.01 }));
  const shipExec = makeShipExec();

  // Without force: ship is skipped.
  const withoutForce = await runPlanBuildReviewShip({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
    shipExec: makeShipExec(),
  });
  assert.equal(withoutForce.phases[4]!.status, "skipped");

  // With force: ship runs even though the gate is denied. The
  // audit log shows gate_passed: false.
  const withForce = await runPlanBuildReviewShip({
    paths,
    state,
    runtime,
    logger: nullAiwLogger(),
    shipExec,
    forceShip: true,
  });
  assert.equal(withForce.phases[4]!.status, "done");
  assert.equal(withForce.gate_passed, false);
  // Ship was actually called.
  const pushCall = shipExec.calls.find((c) => c.file === "git" && c.args[0] === "push");
  assert.ok(pushCall);
}

await testPlanBuild();
await testPlanBuildReviewPasses();
await testPlanBuildReviewFixSkipsFixOnPass();
await testPlanBuildReviewFixRunsFixOnBlock();
await testPhaseErrorFailsWorkflow();
await testStatePersistedAtEachStep();
await testEachPhaseGetsFreshSession();
await testPlanBuildReviewShipSkipsWhenGateDenies();
await testPlanBuildReviewShipRunsShipWhenGateEarned();
await testPlanBuildReviewShipForceOverride();

console.log("aiw workflows tests passed.");