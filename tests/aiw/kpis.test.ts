// tests/aiw/kpis.test.ts — agentic KPIs computation tests.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  aiwPaths,
} from "../../src/core/aiw/paths.ts";
import {
  computeSnapshot,
  readSnapshot,
  recordFromAiw,
  recordRun,
  type RunRecord,
} from "../../src/core/aiw/kpis.ts";
import { makeQueuedAiwState, completeAiw, finishPhase, startPhase, AiwStatus, WorkflowName, PhaseName } from "../../src/core/aiw/state.ts";

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-aiw-kpis-"));
}

function makeRecord(overrides: Partial<RunRecord>): RunRecord {
  return {
    aiwId: "abc",
    changeType: "unknown",
    at: new Date().toISOString(),
    attempts: 1,
    planLines: null,
    diffStat: null,
    oneAttempt: true,
    ...overrides,
  };
}

async function testCurrentStreak(): Promise<void> {
  const records = [
    makeRecord({ aiwId: "1", oneAttempt: true }),
    makeRecord({ aiwId: "2", oneAttempt: true }),
    makeRecord({ aiwId: "3", oneAttempt: false }),
    makeRecord({ aiwId: "4", oneAttempt: true }),
    makeRecord({ aiwId: "5", oneAttempt: true }),
  ];
  const s = computeSnapshot(records);
  assert.equal(s.currentStreak, 2);
}

async function testLongestStreak(): Promise<void> {
  const records = [
    makeRecord({ aiwId: "1", oneAttempt: true }),
    makeRecord({ aiwId: "2", oneAttempt: true }),
    makeRecord({ aiwId: "3", oneAttempt: true }),
    makeRecord({ aiwId: "4", oneAttempt: false }),
    makeRecord({ aiwId: "5", oneAttempt: true }),
    makeRecord({ aiwId: "6", oneAttempt: true }),
  ];
  const s = computeSnapshot(records);
  assert.equal(s.longestStreak, 3);
}

async function testPlanSize(): Promise<void> {
  const records = [
    makeRecord({ aiwId: "1", planLines: 100 }),
    makeRecord({ aiwId: "2", planLines: 200 }),
    makeRecord({ aiwId: "3", planLines: 300 }),
  ];
  const s = computeSnapshot(records);
  assert.equal(s.planSizeMedian, 200);
  assert.ok(s.planSizeP95 !== null && s.planSizeP95 >= 200);
}

async function testDiffSize(): Promise<void> {
  const records = [
    makeRecord({ aiwId: "1", diffStat: { added: 10, removed: 5, files: 2 } }),
    makeRecord({ aiwId: "2", diffStat: { added: 20, removed: 10, files: 4 } }),
    makeRecord({ aiwId: "3", diffStat: { added: 30, removed: 15, files: 6 } }),
  ];
  const s = computeSnapshot(records);
  assert.ok(s.diffSizeMedian !== null);
  assert.equal(s.diffSizeMedian.added, 20);
  assert.equal(s.diffSizeMedian.removed, 10);
  assert.equal(s.diffSizeMedian.files, 4);
}

async function testAveragePresence(): Promise<void> {
  const records = [
    makeRecord({ aiwId: "1", attempts: 1 }),
    makeRecord({ aiwId: "2", attempts: 2 }),
    makeRecord({ aiwId: "3", attempts: 3 }),
  ];
  const s = computeSnapshot(records);
  assert.equal(s.averagePresence, 2);
}

async function testZteEarnedChores(): Promise<void> {
  const records: RunRecord[] = [];
  for (let i = 0; i < 6; i++) {
    records.push(makeRecord({ aiwId: `c${i}`, changeType: "chore", oneAttempt: true }));
  }
  const s = computeSnapshot(records);
  assert.equal(s.afkEarned.chores, true);
  assert.equal(s.afkEarned.bugs, false);
  assert.equal(s.afkEarned.features, false);
}

async function testZteNotEarnedOnFailure(): Promise<void> {
  const records: RunRecord[] = [];
  for (let i = 0; i < 5; i++) {
    records.push(makeRecord({ aiwId: `c${i}`, changeType: "chore", oneAttempt: true }));
  }
  // Break the streak
  records.push(makeRecord({ aiwId: "c5", changeType: "chore", oneAttempt: false }));
  records.push(makeRecord({ aiwId: "c6", changeType: "chore", oneAttempt: true }));
  records.push(makeRecord({ aiwId: "c7", changeType: "chore", oneAttempt: true }));
  const s = computeSnapshot(records);
  assert.equal(s.afkEarned.chores, false);
}

async function testRecordRunRoundTrip(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = aiwPaths(configDir);
  // First write
  recordRun(paths, makeRecord({ aiwId: "x1", oneAttempt: true }));
  // Same id twice: dedupes
  recordRun(paths, makeRecord({ aiwId: "x1", oneAttempt: true, attempts: 2 }));
  const snap = readSnapshot(paths);
  assert.equal(snap.attempts, 1);
  // Idempotent file: a different id adds a new record
  recordRun(paths, makeRecord({ aiwId: "x2", oneAttempt: true }));
  const snap2 = readSnapshot(paths);
  assert.equal(snap2.attempts, 2);
}

async function testRecordFromAiw(): Promise<void> {
  let state = makeQueuedAiwState({
    aiwId: "y".repeat(16),
    workflow: WorkflowName.PlanBuild,
    prompt: "x",
    workingDir: "/tmp",
    branchName: "aiw/yyyy",
    worktreePath: "/tmp/trees/yyyy",
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
  });
  state = { ...state, status: AiwStatus.Running };
  state = startPhase(state, PhaseName.Plan);
  state = finishPhase(state, PhaseName.Plan, { costUsd: 0.01, turns: 2 });
  state = startPhase(state, PhaseName.Build);
  state = finishPhase(state, PhaseName.Build, { costUsd: 0.04, turns: 5 });
  state = completeAiw(state);
  // Simulate the workflow runner having incremented attempts.
  state = { ...state, attempts: 1 };
  const rec = recordFromAiw(state, { changeType: "chore", planLines: 50 });
  assert.equal(rec.oneAttempt, true);
  assert.equal(rec.attempts, 1);
  assert.equal(rec.changeType, "chore");
  assert.equal(rec.planLines, 50);
}

async function testMarkdownRendering(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = aiwPaths(configDir);
  recordRun(paths, makeRecord({ aiwId: "m1", changeType: "chore", oneAttempt: true }));
  recordRun(paths, makeRecord({ aiwId: "m2", changeType: "chore", oneAttempt: true }));
  recordRun(paths, makeRecord({ aiwId: "m3", changeType: "chore", oneAttempt: true }));
  // Read the file and check it has Markdown sections.
  const content = fs.readFileSync(paths.kpisFile, "utf-8");
  assert.match(content, /# Agentic KPIs/);
  assert.match(content, /## Current Streak/);
  assert.match(content, /## AFK Earned/);
}

await testCurrentStreak();
await testLongestStreak();
await testPlanSize();
await testDiffSize();
await testAveragePresence();
await testZteEarnedChores();
await testZteNotEarnedOnFailure();
await testRecordRunRoundTrip();
await testRecordFromAiw();
await testMarkdownRendering();

console.log("aiw kpis tests passed.");