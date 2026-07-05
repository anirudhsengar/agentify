// tests/aiw/afk-gate.test.ts — AFK gate check + unlock tests.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { aiwPaths } from "../../src/core/aiw/paths.ts";
import {
  checkAfkGate,
  readGate,
  unlockZte,
  readOverrides,
  DEFAULT_AFK_THRESHOLD,
  type GateResult,
} from "../../src/core/aiw/afk-gate.ts";
import { recordRun } from "../../src/core/aiw/kpis.ts";
import type { KpisSnapshot } from "../../src/core/aiw/kpis.ts";

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-afk-gate-"));
}

function emptySnapshot(): KpisSnapshot {
  return {
    currentStreak: 0,
    longestStreak: 0,
    planSizeMedian: null,
    planSizeP95: null,
    diffSizeMedian: null,
    diffSizeP95: null,
    averagePresence: 0,
    attempts: 0,
    afkEarned: { chores: false, bugs: false, features: false },
    updatedAt: new Date().toISOString(),
  };
}

async function testGateDeniesWhenStreakBelow(): Promise<void> {
  const snap: KpisSnapshot = {
    ...emptySnapshot(),
    currentStreak: 2,
  };
  const result = checkAfkGate(snap, "chore");
  assert.equal(result.allowed, false);
  assert.equal(result.changeType, "chore");
  assert.equal(result.threshold, 5);
  assert.match(result.reason, /streak is 2, need 5/);
}

async function testGateDeniesUnknown(): Promise<void> {
  const result = checkAfkGate(emptySnapshot(), "unknown");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /change type/);
}

async function testGateAllowsWhenEarned(): Promise<void> {
  const snap: KpisSnapshot = {
    ...emptySnapshot(),
    currentStreak: 5,
    afkEarned: { chores: true, bugs: false, features: false },
  };
  const result = checkAfkGate(snap, "chore");
  assert.equal(result.allowed, true);
  assert.equal(result.changeType, "chore");
  assert.match(result.reason, /earned/);
}

async function testGateIndependentPerClass(): Promise<void> {
  const snap: KpisSnapshot = {
    ...emptySnapshot(),
    currentStreak: 5,
    afkEarned: { chores: true, bugs: false, features: false },
  };
  // Chores: earned
  assert.equal(checkAfkGate(snap, "chore").allowed, true);
  // Bugs: not earned
  assert.equal(checkAfkGate(snap, "bug").allowed, false);
  // Features: not earned
  assert.equal(checkAfkGate(snap, "feature").allowed, false);
}

async function testCustomThreshold(): Promise<void> {
  const snap: KpisSnapshot = { ...emptySnapshot(), currentStreak: 3 };
  const result = checkAfkGate(snap, "chore", 3);
  // With threshold 3, the gate is "denied" because the snapshot
  // doesn't say earned. The current-streak approximation only
  // returns >=threshold when afkEarned is true.
  assert.equal(result.allowed, false);
  assert.equal(result.threshold, 3);
}

async function testReadGateFromDisk(): Promise<void> {
  const configDir = tempConfigDir();
  const paths = aiwPaths(configDir);
  // Record 5 chore runs to earn the gate.
  for (let i = 0; i < 5; i++) {
    recordRun(paths, {
      aiwId: `chore${i}`,
      changeType: "chore",
      at: new Date(Date.now() - (5 - i) * 1000).toISOString(),
      attempts: 1,
      planLines: null,
      diffStat: null,
      oneAttempt: true,
    });
  }
  const result = readGate(configDir, "chore");
  assert.equal(result.allowed, true);
  // Bugs/features remain unearned.
  assert.equal(readGate(configDir, "bug").allowed, false);
  assert.equal(readGate(configDir, "feature").allowed, false);
}

async function testUnlockRecordsOverride(): Promise<void> {
  const configDir = tempConfigDir();
  unlockZte(configDir, "features", { reason: "manual approval for the launch", reviewer: "alice" });
  const overrides = readOverrides(configDir);
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0]!.changeType, "features");
  assert.equal(overrides[0]!.reason, "manual approval for the launch");
  assert.equal(overrides[0]!.reviewer, "alice");
  // Append a second override.
  unlockZte(configDir, "bugs", { reason: "second unlock" });
  const overrides2 = readOverrides(configDir);
  assert.equal(overrides2.length, 2);
  assert.equal(overrides2[1]!.changeType, "bugs");
}

async function testGateNoDataFile(): Promise<void> {
  const configDir = tempConfigDir();
  // No kpis.md file exists; readGate should return "not earned".
  const result = readGate(configDir, "chore");
  assert.equal(result.allowed, false);
  assert.equal(result.currentStreak, 0);
}

async function testDefaultThresholdIsFive(): Promise<void> {
  assert.equal(DEFAULT_AFK_THRESHOLD, 5);
}

async function testGateResultShape(): Promise<void> {
  // Ensure the GateResult interface is what we expect.
  const result: GateResult = checkAfkGate(emptySnapshot(), "chore");
  assert.equal(typeof result.allowed, "boolean");
  assert.equal(typeof result.reason, "string");
  assert.equal(typeof result.currentStreak, "number");
  assert.equal(typeof result.threshold, "number");
  assert.equal(typeof result.unlocked, "boolean");
  assert.ok(["chore", "bug", "feature", "unknown"].includes(result.changeType));
}

await testGateDeniesWhenStreakBelow();
await testGateDeniesUnknown();
await testGateAllowsWhenEarned();
await testGateIndependentPerClass();
await testCustomThreshold();
await testReadGateFromDisk();
await testUnlockRecordsOverride();
await testGateNoDataFile();
await testDefaultThresholdIsFive();
await testGateResultShape();

console.log("aiw afk-gate tests passed.");