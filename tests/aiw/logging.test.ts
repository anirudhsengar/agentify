// tests/aiw/logging.test.ts — phase event logging tests.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  aiwStatePaths,
  ensureAiwStateDirs,
  readAiwEvents,
} from "../../src/core/aiw/paths.ts";
import {
  logPhaseEnd,
  logPhaseStart,
  makeAiwLogger,
  nullAiwLogger,
  recordPhasePrompt,
} from "../../src/core/aiw/logging.ts";
import {
  AiwStatus,
  PhaseName,
  makeQueuedAiwState,
  WorkflowName,
} from "../../src/core/aiw/state.ts";

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-aiw-logging-"));
}

async function testPhaseLifecycle(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "1".repeat(16);
  const paths = aiwStatePaths(configDir, aiwId);
  ensureAiwStateDirs(paths);
  const state = makeQueuedAiwState({
    aiwId,
    workflow: WorkflowName.PlanBuild,
    prompt: "x",
    workingDir: "/tmp",
    branchName: `aiw/${aiwId}`,
    worktreePath: `/tmp/trees/${aiwId}`,
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });

  logPhaseStart(paths, state, PhaseName.Plan);
  logPhaseEnd(paths, state, PhaseName.Plan, {
    status: "done",
    costUsd: 0.01,
    turns: 2,
  });
  logPhaseStart(paths, state, PhaseName.Build);
  logPhaseEnd(paths, state, PhaseName.Build, {
    status: "error",
    costUsd: 0.005,
    turns: 1,
    errorMessage: "compile fail",
  });

  const events = readAiwEvents(paths);
  // 4 events (start + end for each phase)
  assert.equal(events.length, 4);
  assert.equal(events[0]!.kind, "phase_started");
  assert.equal(events[0]!.phase, PhaseName.Plan);
  assert.equal(events[1]!.kind, "phase_ended");
  assert.equal(events[1]!.phase, PhaseName.Plan);
  assert.equal(events[2]!.kind, "phase_started");
  assert.equal(events[2]!.phase, PhaseName.Build);
  assert.equal(events[3]!.kind, "phase_ended");
  assert.equal(events[3]!.phase, PhaseName.Build);
  // The error message is in the end event's fields
  const errorFields = events[3]!.fields as Record<string, unknown>;
  assert.equal(errorFields["error_message"], "compile fail");
}

async function testExecutionLog(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "2".repeat(16);
  const paths = aiwStatePaths(configDir, aiwId);
  const logger = makeAiwLogger(paths);
  logger.info("test message");
  logger.warn("warn message");
  logger.error("err message");
  // execution.log should have 3 lines
  const log = fs.readFileSync(paths.executionLog, "utf-8");
  const lines = log.split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /test message/);
  assert.match(lines[1]!, /WARN: warn message/);
  assert.match(lines[2]!, /ERROR: err message/);
}

async function testNullLogger(): Promise<void> {
  const log = nullAiwLogger();
  // No throw, no output.
  log.info("x");
  log.warn("y");
  log.error("z");
}

async function testPromptAudit(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "3".repeat(16);
  const paths = aiwStatePaths(configDir, aiwId);
  ensureAiwStateDirs(paths);
  recordPhasePrompt(paths, PhaseName.Plan, "build a thing");
  recordPhasePrompt(paths, PhaseName.Build, "implement the thing");
  const files = fs.readdirSync(paths.promptsDir);
  assert.ok(files.length >= 2);
  for (const file of files) {
    assert.match(file, /^(plan|build)-.+\.txt$/);
    const content = fs.readFileSync(path.join(paths.promptsDir, file), "utf-8");
    assert.ok(content === "build a thing" || content === "implement the thing");
  }
}

async function testEventOrdering(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "4".repeat(16);
  const paths = aiwStatePaths(configDir, aiwId);
  ensureAiwStateDirs(paths);
  const state = makeQueuedAiwState({
    aiwId,
    workflow: WorkflowName.PlanBuild,
    prompt: "x",
    workingDir: "/tmp",
    branchName: `aiw/${aiwId}`,
    worktreePath: `/tmp/trees/${aiwId}`,
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });
  // Events must be appended in chronological order.
  logPhaseStart(paths, state, PhaseName.Plan);
  await new Promise((r) => setTimeout(r, 5));
  logPhaseEnd(paths, state, PhaseName.Plan, { status: "done", costUsd: 0.01, turns: 1 });
  const events = readAiwEvents(paths);
  assert.equal(events.length, 2);
  const t1 = Date.parse(events[0]!.at);
  const t2 = Date.parse(events[1]!.at);
  assert.ok(t2 >= t1);
}

async function testPhaseSkipped(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "5".repeat(16);
  const paths = aiwStatePaths(configDir, aiwId);
  ensureAiwStateDirs(paths);
  const state = makeQueuedAiwState({
    aiwId,
    workflow: WorkflowName.PlanBuildReviewFix,
    prompt: "x",
    workingDir: "/tmp",
    branchName: `aiw/${aiwId}`,
    worktreePath: `/tmp/trees/${aiwId}`,
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });
  logPhaseStart(paths, state, PhaseName.Plan);
  logPhaseEnd(paths, state, PhaseName.Plan, { status: "done", costUsd: 0.01, turns: 2 });
  logPhaseStart(paths, state, PhaseName.Build);
  logPhaseEnd(paths, state, PhaseName.Build, { status: "done", costUsd: 0.04, turns: 5 });
  logPhaseStart(paths, state, PhaseName.Review);
  logPhaseEnd(paths, state, PhaseName.Review, { status: "done", costUsd: 0.01, turns: 2 });
  logPhaseEnd(paths, state, PhaseName.Fix, { status: "skipped", costUsd: null, turns: 0 });
  const events = readAiwEvents(paths);
  assert.equal(events.length, 7);
  assert.equal(events[6]!.kind, "phase_ended");
  const fields = events[6]!.fields as Record<string, unknown>;
  assert.equal(fields["status"], "skipped");
}

await testPhaseLifecycle();
await testExecutionLog();
await testNullLogger();
await testPromptAudit();
await testEventOrdering();
await testPhaseSkipped();

console.log("aiw logging tests passed.");