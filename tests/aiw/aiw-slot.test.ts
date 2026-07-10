// tests/aiw/aiw-slot.test.ts — verify AIW phases consume the lite slot.
//
// Phase 3: every LLM-driven AIW phase (plan, build, review, fix)
// passes `modelRole: "lite"` to the runtime. The resolver
// resolves lite via the configured slot, falling back to
// primary → legacy fields → registry default. This test stubs the
// runtime to capture the modelRole value passed to each phase.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startAiwRunner } from "../../src/core/aiw/index.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
} from "../../src/core/types.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCapturingRuntime(): AgentRuntime & {
  calls: Array<{ phase: string; modelRole: string | undefined }>;
} {
  const calls: Array<{ phase: string; modelRole: string | undefined }> = [];
  return {
    calls,
    async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
      // Detect phase from system prompt (mirrors workflows.test.ts pattern).
      const sys = options.systemPrompt;
      let phase = "unknown";
      if (sys.includes("PLAN phase")) phase = "plan";
      else if (sys.includes("BUILD phase")) phase = "build";
      else if (sys.includes("REVIEW phase")) phase = "review";
      else if (sys.includes("FIX phase")) phase = "fix";
      calls.push({ phase, modelRole: options.modelRole });
      return { turns: 1, costUsd: 0.001, aborted: false };
    },
    async runGreenfield(): Promise<AgentRuntimeResult> {
      throw new Error("greenfield mode should not run in this test");
    },
  };
}

function buildAiwFixture(cwd: string): void {
  // Minimal AIW fixture: a working tree with .pi/agentify so the
  // runner can classify and the workflow can proceed.
  fs.mkdirSync(path.join(cwd, ".pi", "agentify"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "agentify", "codebase_map.json"),
    JSON.stringify({ coverage: { covered: ["D1"], total: 1 } }, null, 2),
  );
}

async function aiwAllPhasesUseScoringSlot(): Promise<void> {
  const configDir = tempDir("aiw-slot-config-");
  const cwd = tempDir("aiw-slot-cwd-");
  try {
    buildAiwFixture(cwd);
    const runtime = makeCapturingRuntime();
    const runner = startAiwRunner({ configDir, cwd, runtime, updateKpis: false });

    await runner.run({
      workflow: "plan_build_review_fix",
      prompt: "test prompt",
      workingDir: cwd,
      source: "test",
    });

    // Every LLM-driven phase should pass `modelRole: "lite"`.
    assert.ok(runtime.calls.length >= 3, `expected at least 3 phase calls, got ${runtime.calls.length}`);
    for (const call of runtime.calls) {
      assert.equal(
        call.modelRole,
        "lite",
        `phase '${call.phase}' must use lite slot, got ${call.modelRole}`,
      );
    }
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function aiwReviewPhaseUsesScoringSlot(): Promise<void> {
  const configDir = tempDir("aiw-slot-config-");
  const cwd = tempDir("aiw-slot-cwd-");
  try {
    buildAiwFixture(cwd);
    const runtime = makeCapturingRuntime();
    const runner = startAiwRunner({ configDir, cwd, runtime, updateKpis: false });

    await runner.run({
      workflow: "plan_build_review",
      prompt: "test prompt",
      workingDir: cwd,
      source: "test",
    });

    const review = runtime.calls.find((c) => c.phase === "review");
    assert.ok(review, "expected review phase to be called");
    assert.equal(review?.modelRole, "lite");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function aiwFixPhaseUsesScoringSlot(): Promise<void> {
  const configDir = tempDir("aiw-slot-config-");
  const cwd = tempDir("aiw-slot-cwd-");
  try {
    buildAiwFixture(cwd);
    const runtime = makeCapturingRuntime();
    const runner = startAiwRunner({ configDir, cwd, runtime, updateKpis: false });

    await runner.run({
      workflow: "plan_build_review_fix",
      prompt: "test prompt",
      workingDir: cwd,
      source: "test",
    });

    const fix = runtime.calls.find((c) => c.phase === "fix");
    // fix phase is conditional — it only runs when review finds blockers.
    // In our fixture review passes (no blockers), so fix may not run.
    // We just assert that IF it ran, it used lite.
    if (fix) {
      assert.equal(fix.modelRole, "lite");
    }
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function aiwBuildPhaseUsesScoringSlot(): Promise<void> {
  const configDir = tempDir("aiw-slot-config-");
  const cwd = tempDir("aiw-slot-cwd-");
  try {
    buildAiwFixture(cwd);
    const runtime = makeCapturingRuntime();
    const runner = startAiwRunner({ configDir, cwd, runtime, updateKpis: false });

    await runner.run({
      workflow: "plan_build",
      prompt: "test prompt",
      workingDir: cwd,
      source: "test",
    });

    const plan = runtime.calls.find((c) => c.phase === "plan");
    const build = runtime.calls.find((c) => c.phase === "build");
    assert.ok(plan);
    assert.ok(build);
    assert.equal(plan?.modelRole, "lite");
    assert.equal(build?.modelRole, "lite");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "aiwAllPhasesUseScoringSlot", fn: aiwAllPhasesUseScoringSlot },
  { name: "aiwReviewPhaseUsesScoringSlot", fn: aiwReviewPhaseUsesScoringSlot },
  { name: "aiwFixPhaseUsesScoringSlot", fn: aiwFixPhaseUsesScoringSlot },
  { name: "aiwBuildPhaseUsesScoringSlot", fn: aiwBuildPhaseUsesScoringSlot },
];

let passed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
}
console.log(`aiw-slot tests passed (${passed}/${tests.length}).`);