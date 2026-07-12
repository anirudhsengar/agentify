// tests/orchestrator/aiw-bridge.test.ts — AiwBridge validation + translation.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AiwBridge } from "../../src/core/orchestrator/aiw-bridge.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testValidation(): Promise<void> {
  const cfg = tempDir("agentify-bridge-val-");
  try {
    const bridge = new AiwBridge({ configDir: cfg, cwd: cfg, noWorktree: true });

    // Missing name_of_aiw
    let threw = false;
    try {
      bridge.validateStartAiwArgs({
        name_of_aiw: "",
        workflow_type: "plan_build",
        prompt: "x",
      });
    } catch (err) { threw = true; assert.ok((err as Error).message.includes("name_of_aiw")); }
    assert.equal(threw, true);

    // Bad workflow
    threw = false;
    try {
      bridge.validateStartAiwArgs({
        name_of_aiw: "test",
        workflow_type: "invalid",
        prompt: "x",
      });
    } catch (err) { threw = true; assert.ok((err as Error).message.includes("workflow_type")); }
    assert.equal(threw, true);

    // Empty prompt
    threw = false;
    try {
      bridge.validateStartAiwArgs({
        name_of_aiw: "test",
        workflow_type: "plan_build",
        prompt: "  ",
      });
    } catch (err) { threw = true; assert.ok((err as Error).message.includes("prompt")); }
    assert.equal(threw, true);

    // Bad change_type
    threw = false;
    try {
      bridge.validateStartAiwArgs({
        name_of_aiw: "test",
        workflow_type: "plan_build",
        prompt: "x",
        change_type: "bogus",
      });
    } catch (err) { threw = true; assert.ok((err as Error).message.includes("change_type")); }
    assert.equal(threw, true);

    // Valid args
    bridge.validateStartAiwArgs({
      name_of_aiw: "test",
      workflow_type: "plan_build_review_fix",
      prompt: "implement X",
      change_type: "feature",
    });
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

async function testStartAndCheck(): Promise<void> {
  const cfg = tempDir("agentify-bridge-start-");
  try {
    // Use a FakeRuntime so we don't make LLM calls.
    // Build a custom bridge: but the AiwRunner inside uses its own
    // runtime — for full control we'd need to inject; for the smoke
    // test we just use a noWorktree config. The runner
    // uses PiSdkRuntime by default; we don't have a real provider
    // configured, so this will fail. Use a custom approach:
    // exercise only the validation path here, and exercise
    // start+check via the integration test elsewhere.

    // The bridge construction is safe; we only call validation.
    const bridge = new AiwBridge({ configDir: cfg, cwd: cfg, noWorktree: true });
    bridge.validateStartAiwArgs({
      name_of_aiw: "test",
      workflow_type: "plan_build",
      prompt: "x",
    });
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

async function testCheckAiwNotFound(): Promise<void> {
  const cfg = tempDir("agentify-bridge-nf-");
  try {
    const bridge = new AiwBridge({ configDir: cfg, cwd: cfg, noWorktree: true });
    let threw = false;
    try {
      bridge.checkAiw("nonexistent-aiw-id");
    } catch (err) {
      threw = true;
      assert.ok((err as Error).message.includes("not found"));
    }
    assert.equal(threw, true);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

async function testListEmpty(): Promise<void> {
  const cfg = tempDir("agentify-bridge-empty-");
  try {
    const bridge = new AiwBridge({ configDir: cfg, cwd: cfg, noWorktree: true });
    assert.deepEqual(bridge.listLiveAiw(), []);
    assert.deepEqual(bridge.listAllAiw(), []);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

await testValidation();
await testStartAndCheck();
await testCheckAiwNotFound();
await testListEmpty();

console.log("aiw-bridge tests passed.");
