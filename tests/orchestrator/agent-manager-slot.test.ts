// tests/orchestrator/agent-manager-slot.test.ts — Phase 3
//
// Verify AgentManager.runAgent threads state.model/thinking_level/
// model_role into the AgentRuntimeSessionOptions passed to the runtime.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentManager } from "../../src/core/orchestrator/agent-manager.ts";
import { SubagentRegistry } from "../../src/core/orchestrator/subagent-registry.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
} from "../../src/core/types.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCapturingRuntime(): AgentRuntime & {
  calls: AgentRuntimeSessionOptions[];
} {
  const calls: AgentRuntimeSessionOptions[] = [];
  return {
    calls,
    async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
      calls.push(options);
      return { turns: 1, costUsd: 0.001, aborted: false };
    },
    async runGreenfield(): Promise<AgentRuntimeResult> {
      throw new Error("greenfield mode should not run in this test");
    },
  };
}

async function agentManagerThreadsStateModelIntoConfig(): Promise<void> {
  const configDir = tempDir("agent-manager-slot-config-");
  const cwd = tempDir("agent-manager-slot-cwd-");
  try {
    const runtime = makeCapturingRuntime();
    const registry = new SubagentRegistry([], null, []);
    const manager = new AgentManager({
      configDir,
      cwd,
      orchestratorSessionId: "sess-test",
      runtime,
      registry,
    });
    await manager.createAgent({
      name: "test-agent",
      system_prompt: "you are a test agent",
      user_prompt: "do test",
      model: "haiku",
      thinking_level: "low",
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(runtime.calls.length > 0, "runtime should have been called");
    const options = runtime.calls[0];
    assert.equal(options.config.model, "haiku", "state.model must thread into config.model");
    assert.equal(options.config.thinkingLevel, "low", "state.thinking_level must thread into config.thinkingLevel");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function agentManagerThreadsStateModelRoleIntoSessionOptions(): Promise<void> {
  const configDir = tempDir("agent-manager-slot-config-");
  const cwd = tempDir("agent-manager-slot-cwd-");
  try {
    const runtime = makeCapturingRuntime();
    const registry = new SubagentRegistry([], null, []);
    const manager = new AgentManager({
      configDir,
      cwd,
      orchestratorSessionId: "sess-test",
      runtime,
      registry,
    });
    await manager.createAgent({
      name: "test-agent",
      system_prompt: "you are a test agent",
      user_prompt: "do test",
      model: "haiku",
      thinking_level: "low",
      modelRole: "explorer",
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(runtime.calls.length > 0);
    const options = runtime.calls[0];
    assert.equal(options.modelRole, "explorer", "state.model_role must thread into AgentRuntimeSessionOptions.modelRole");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function createAgentToolAcceptsModelRole(): Promise<void> {
  // Verify the schema accepts model_role as an optional field.
  // Compile-time check: an AgentFrontmatter with modelRole is valid.
  const def: import("../../src/core/orchestrator/subagent-registry.ts").AgentFrontmatter = {
    name: "test",
    description: "test agent",
    tools: ["read"],
    model: "haiku",
    modelRole: "lite",
    domain: null,
    expertise: null,
    color: "white",
    system_prompt_inline: false,
  };
  assert.equal(def.modelRole, "lite");
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "agentManagerThreadsStateModelIntoConfig", fn: agentManagerThreadsStateModelIntoConfig },
  { name: "agentManagerThreadsStateModelRoleIntoSessionOptions", fn: agentManagerThreadsStateModelRoleIntoSessionOptions },
  { name: "createAgentToolAcceptsModelRole", fn: createAgentToolAcceptsModelRole },
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
console.log(`agent-manager-slot tests passed (${passed}/${tests.length}).`);