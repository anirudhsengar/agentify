// tests/aiw/state.test.ts — AiwState schema + transition functions.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AiwStatus,
  PhaseName,
  PhaseStatus,
  PHASES_FOR,
  WorkflowName,
  abortAiw,
  completeAiw,
  durationMs,
  failAiw,
  failPhase,
  finishPhase,
  generateAiwId,
  getPhase,
  isTerminal,
  makeQueuedAiwState,
  skipPhase,
  startPhase,
  totals,
  updatePhase,
  validateAiwState,
} from "../../src/core/aiw/state.ts";
import {
  aiwStatePaths,
  readAiwState,
  writeAiwState,
} from "../../src/core/aiw/paths.ts";

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-aiw-state-"));
}

async function testGenerateId(): Promise<void> {
  const a = generateAiwId();
  const b = generateAiwId();
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.match(b, /^[0-9a-f]{16}$/);
  assert.notEqual(a, b);
}

async function testMakeQueued(): Promise<void> {
  const state = makeQueuedAiwState({
    aiwId: "a".repeat(16),
    workflow: WorkflowName.PlanBuildReview,
    prompt: "Add pagination",
    workingDir: "/tmp/repo",
    branchName: "aiw/aaaa",
    worktreePath: "/tmp/repo/trees/aaaa",
    backendPort: 9103,
    frontendPort: 9203,
    worktreeCreated: true,
    source: "cli:manual",
  });
  assert.equal(state.status, AiwStatus.Queued);
  assert.equal(state.workflow, "plan_build_review");
  assert.equal(state.phases.length, 3);
  assert.equal(state.phases[0]?.phase, PhaseName.Plan);
  assert.equal(state.phases[1]?.phase, PhaseName.Build);
  assert.equal(state.phases[2]?.phase, PhaseName.Review);
  for (const p of state.phases) {
    assert.equal(p.status, PhaseStatus.Pending);
    assert.equal(p.started_at, null);
    assert.equal(p.ended_at, null);
    assert.equal(p.turns, 0);
  }
  assert.equal(state.attempts, 0);
  assert.equal(state.error_message, null);
}

async function testPhaseTransitions(): Promise<void> {
  let state = makeQueuedAiwState({
    aiwId: "b".repeat(16),
    workflow: WorkflowName.PlanBuild,
    prompt: "fix bug",
    workingDir: "/tmp",
    branchName: "aiw/bbbb",
    worktreePath: "/tmp/trees/bbbb",
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });
  // Start plan
  state = startPhase(state, PhaseName.Plan);
  assert.equal(getPhase(state, PhaseName.Plan)?.status, PhaseStatus.Running);
  assert.ok(getPhase(state, PhaseName.Plan)?.started_at);
  // Finish plan
  state = finishPhase(state, PhaseName.Plan, { costUsd: 0.01, turns: 3, artifacts: { plan_path: "/tmp/specs/plan.md" } });
  assert.equal(getPhase(state, PhaseName.Plan)?.status, PhaseStatus.Done);
  assert.equal(getPhase(state, PhaseName.Plan)?.cost_usd, 0.01);
  assert.equal(getPhase(state, PhaseName.Plan)?.artifacts.plan_path, "/tmp/specs/plan.md");
  // Start build
  state = startPhase(state, PhaseName.Build);
  // Fail build
  state = failPhase(state, PhaseName.Build, "compile error");
  assert.equal(getPhase(state, PhaseName.Build)?.status, PhaseStatus.Error);
  assert.equal(getPhase(state, PhaseName.Build)?.error_message, "compile error");
}

async function testSkipPhase(): Promise<void> {
  let state = makeQueuedAiwState({
    aiwId: "c".repeat(16),
    workflow: WorkflowName.PlanBuildReviewFix,
    prompt: "test",
    workingDir: "/tmp",
    branchName: "aiw/ccc",
    worktreePath: "/tmp/trees/ccc",
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });
  state = skipPhase(state, PhaseName.Fix);
  assert.equal(getPhase(state, PhaseName.Fix)?.status, PhaseStatus.Skipped);
  assert.ok(getPhase(state, PhaseName.Fix)?.ended_at);
}

async function testAiwLifecycle(): Promise<void> {
  let state = makeQueuedAiwState({
    aiwId: "d".repeat(16),
    workflow: WorkflowName.PlanBuild,
    prompt: "x",
    workingDir: "/tmp",
    branchName: "aiw/dddd",
    worktreePath: "/tmp/trees/dddd",
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });
  assert.equal(isTerminal(state), false);

  state = { ...state, status: AiwStatus.Running };
  state = startPhase(state, PhaseName.Plan);
  state = finishPhase(state, PhaseName.Plan, { costUsd: 0.005, turns: 2 });
  state = startPhase(state, PhaseName.Build);
  state = finishPhase(state, PhaseName.Build, { costUsd: 0.02, turns: 5 });
  state = completeAiw(state);
  assert.equal(isTerminal(state), true);
  assert.equal(state.status, AiwStatus.Completed);
  assert.ok(state.ended_at);
  const t = totals(state);
  assert.equal(t.costUsd, 0.025);
  assert.equal(t.turns, 7);
  const ms = durationMs(state);
  assert.ok(ms !== null && ms >= 0);
}

async function testAiwFailure(): Promise<void> {
  let state = makeQueuedAiwState({
    aiwId: "e".repeat(16),
    workflow: WorkflowName.PlanBuild,
    prompt: "x",
    workingDir: "/tmp",
    branchName: "aiw/eeee",
    worktreePath: "/tmp/trees/eeee",
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });
  state = failPhase(state, PhaseName.Plan, "bad input");
  state = failAiw(state, PhaseName.Plan, "bad input");
  assert.equal(state.status, AiwStatus.Failed);
  assert.equal(state.error_step, PhaseName.Plan);
  assert.equal(state.error_message, "bad input");
  assert.equal(isTerminal(state), true);

  state = abortAiw(state);
  assert.equal(state.status, AiwStatus.Aborted);
}

async function testValidation(): Promise<void> {
  const valid = makeQueuedAiwState({
    aiwId: "f".repeat(16),
    workflow: WorkflowName.PlanBuild,
    prompt: "x",
    workingDir: "/tmp",
    branchName: "aiw/ffff",
    worktreePath: "/tmp/trees/ffff",
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });
  const result = validateAiwState(valid);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.value.aiw_id, "f".repeat(16));
  }
  // Invalid: missing required fields
  const invalid = { aiw_id: "abc" };
  const result2 = validateAiwState(invalid);
  assert.equal(result2.ok, false);
}

async function testRoundTrip(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "9".repeat(16);
  const paths = aiwStatePaths(configDir, aiwId);
  const state = makeQueuedAiwState({
    aiwId,
    workflow: WorkflowName.PlanBuildReview,
    prompt: "roundtrip",
    workingDir: "/tmp",
    branchName: `aiw/${aiwId}`,
    worktreePath: `/tmp/trees/${aiwId}`,
    backendPort: 9105,
    frontendPort: 9205,
    worktreeCreated: true,
    source: "test",
  });
  writeAiwState(paths, state);
  const read = readAiwState(paths);
  assert.ok(read);
  assert.equal(read?.aiw_id, aiwId);
  assert.equal(read?.workflow, "plan_build_review");
  assert.equal(read?.phases.length, 3);
  // File is 0600
  const stat = fs.statSync(paths.stateFile);
  assert.equal(stat.mode & 0o777, 0o600);
}

async function testUpdatePhase(): Promise<void> {
  const state = makeQueuedAiwState({
    aiwId: "1".repeat(16),
    workflow: WorkflowName.PlanBuild,
    prompt: "x",
    workingDir: "/tmp",
    branchName: "aiw/1111",
    worktreePath: "/tmp/trees/1111",
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });
  const updated = updatePhase(state, PhaseName.Plan, { turns: 42 });
  assert.equal(getPhase(updated, PhaseName.Plan)?.turns, 42);
  // Other phases untouched
  assert.equal(getPhase(updated, PhaseName.Build)?.turns, 0);
}

async function testPhasesFor(): Promise<void> {
  assert.deepEqual([...PHASES_FOR[WorkflowName.PlanBuild]], [PhaseName.Plan, PhaseName.Build]);
  assert.deepEqual([...PHASES_FOR[WorkflowName.PlanBuildReview]], [PhaseName.Plan, PhaseName.Build, PhaseName.Review]);
  assert.deepEqual([...PHASES_FOR[WorkflowName.PlanBuildReviewFix]], [PhaseName.Plan, PhaseName.Build, PhaseName.Review, PhaseName.Fix]);
}

await testGenerateId();
await testMakeQueued();
await testPhaseTransitions();
await testSkipPhase();
await testAiwLifecycle();
await testAiwFailure();
await testValidation();
await testRoundTrip();
await testUpdatePhase();
await testPhasesFor();

console.log("aiw state tests passed.");