// tests/core/workflow-afk.test.ts — workflow-level AFK auto-promotion.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { aiwPaths } from "../../src/core/aiw/paths.ts";
import { recordRun } from "../../src/core/aiw/kpis.ts";
import { shouldAutoShip } from "../../src/core/workflow-afk.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testShouldNotShipWithoutKpis(): Promise<void> {
  const cfg = tempDir("agentify-wafk-nokpis-");
  try {
    const result = shouldAutoShip("nonexistent-aiw", "feature", 5, cfg);
    assert.equal(result.shouldShip, false);
    assert.equal(result.gate.currentStreak, 0);
    assert.match(result.gate.reason, /not earned/i);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

async function testShouldNotShipWithoutConfigDir(): Promise<void> {
  const result = shouldAutoShip("any-aiw", "feature", 5);
  assert.equal(result.shouldShip, false);
  assert.match(result.gate.reason, /configDir/);
}

async function testShouldShipWhenZteEarned(): Promise<void> {
  const cfg = tempDir("agentify-wafk-earned-");
  try {
    // Write 6 consecutive one-attempt feature runs to kpis.md.
    const paths = aiwPaths(cfg);
    fs.mkdirSync(paths.aiwRoot, { recursive: true });
    for (let i = 0; i < 6; i++) {
      recordRun(paths, {
        aiwId: `aiw-feat-${i}`,
        changeType: "feature",
        at: `2026-07-0${i + 1}T10:00:00Z`,
        attempts: 1,
        planLines: 200,
        diffStat: { added: 10, removed: 5, files: 2 },
        oneAttempt: true,
      });
    }
    const result = shouldAutoShip("any-aiw", "feature", 5, cfg);
    assert.equal(result.shouldShip, true);
    assert.equal(result.gate.allowed, true);
    assert.equal(result.gate.currentStreak, 6);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

async function testShouldNotShipWhenStreakBelowThreshold(): Promise<void> {
  const cfg = tempDir("agentify-wafk-below-");
  try {
    const paths = aiwPaths(cfg);
    fs.mkdirSync(paths.aiwRoot, { recursive: true });
    // Two consecutive one-attempt runs (current streak = 2, < 5).
    recordRun(paths, {
      aiwId: "aiw-1", changeType: "feature", at: "2026-07-02T10:00:00Z",
      attempts: 1, planLines: 200, diffStat: { added: 10, removed: 5, files: 2 }, oneAttempt: true,
    });
    recordRun(paths, {
      aiwId: "aiw-2", changeType: "feature", at: "2026-07-03T10:00:00Z",
      attempts: 1, planLines: 200, diffStat: { added: 10, removed: 5, files: 2 }, oneAttempt: true,
    });
    const result = shouldAutoShip("any-aiw", "feature", 5, cfg);
    assert.equal(result.shouldShip, false);
    assert.equal(result.gate.currentStreak, 2);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

async function testShouldNotShipForWrongClass(): Promise<void> {
  const cfg = tempDir("agentify-wafk-wrongclass-");
  try {
    const paths = aiwPaths(cfg);
    fs.mkdirSync(paths.aiwRoot, { recursive: true });
    // AFK earned for chores only.
    for (let i = 0; i < 6; i++) {
      recordRun(paths, {
        aiwId: `aiw-chore-${i}`,
        changeType: "chore",
        at: `2026-07-0${i + 1}T10:00:00Z`,
        attempts: 1,
        planLines: 50,
        diffStat: { added: 5, removed: 2, files: 1 },
        oneAttempt: true,
      });
    }
    // Features AFK not earned → should not ship.
    const featResult = shouldAutoShip("any-aiw", "feature", 5, cfg);
    assert.equal(featResult.shouldShip, false);
    // Chores AFK earned → should ship.
    const choreResult = shouldAutoShip("any-aiw", "chore", 5, cfg);
    assert.equal(choreResult.shouldShip, true);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

await testShouldNotShipWithoutKpis();
await testShouldNotShipWithoutConfigDir();
await testShouldShipWhenZteEarned();
await testShouldNotShipWhenStreakBelowThreshold();
await testShouldNotShipForWrongClass();

console.log("workflow-afk tests passed.");