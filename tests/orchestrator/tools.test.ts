// tests/orchestrator/tools.test.ts — exercise each of the 10 management tools.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentManager } from "../../src/core/orchestrator/agent-manager.ts";
import { AiwBridge } from "../../src/core/orchestrator/aiw-bridge.ts";
import { SubagentRegistry } from "../../src/core/orchestrator/subagent-registry.ts";
import { FakeRuntime } from "./fake-runtime.ts";
import {
  createManagementTools,
  MANAGEMENT_TOOL_NAMES,
} from "../../src/core/orchestrator/tools/index.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Harness {
  configDir: string;
  cwd: string;
  runtime: FakeRuntime;
  manager: AgentManager;
  aiwBridge: AiwBridge;
  tools: ReturnType<typeof createManagementTools>;
  cleanup: () => void;
}

function setup(): Harness {
  const configDir = tempDir("agentify-tools-");
  const cwd = tempDir("agentify-tools-cwd-");
  const orchPaths = path.join(configDir, "orchestrator");
  fs.mkdirSync(orchPaths, { recursive: true });
  fs.writeFileSync(path.join(orchPaths, "events.jsonl"), "");
  fs.writeFileSync(path.join(orchPaths, "cost.json"), JSON.stringify({ orchestrator_cost_usd: 0, total_cost_usd: 0, per_agent: {}, per_aiw: {} }));

  const runtime = new FakeRuntime();
  const registry = SubagentRegistry.fromCwd(cwd, configDir);
  const manager = new AgentManager({
    configDir,
    cwd,
    runtime,
    registry,
    orchestratorSessionId: "orch-tools-test",
  });
  const aiwBridge = new AiwBridge({ configDir, cwd, noWorktree: true });
  const workflowRegistry = { list: () => [], get: () => null, errors: [], packagedWorkflowsDir: null, projectWorkflowsDir: null, userWorkflowsDir: null, formatForPrompt: () => "(no workflows registered)", has: () => false } as unknown as import("../../src/core/orchestrator/workflow-registry.ts").WorkflowRegistry;
  const workflowRunner = {
    run: async () => { throw new Error("test stub"); },
    show: () => null,
    list: () => [],
    cancel: () => {},
    tail: () => [],
    tailSummary: () => [],
  } as unknown as import("../../src/core/orchestrator/workflow-runner.ts").WorkflowRunner;
  const tools = createManagementTools({
    agentManager: manager,
    aiwBridge,
    workflowRegistry,
    workflowRunner,
    configDir,
    projectWorkflowsDir: null,
  });

  return {
    configDir,
    cwd,
    runtime,
    manager,
    aiwBridge,
    tools,
    cleanup: () => {
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}


async function callTool(h: Harness, name: string, params: Record<string, unknown>): Promise<{
  text: string;
  details?: unknown;
  isError?: boolean;
}> {
  const t = h.tools.find((tt) => tt.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  const result = await t.execute(
    "test-call",
    params as never,
    undefined,
    undefined,
    // ctx is unused in the tools
    {} as never,
  );
  const text = result.content?.[0]?.type === "text" ? (result.content[0] as { type: "text"; text: string }).text : "";
  // The tools include `isError` at runtime even though TypeBox's
  // AgentToolResult doesn't have it. Cast to access.
  const isError = (result as { isError?: boolean }).isError;
  return {
    text,
    details: result.details,
    isError,
  };
}

async function testAllGrade2Registered(): Promise<void> {
  const h = setup();
  try {
    const names = h.tools.map((t) => t.name).sort();
    // Class 3 Grade 2 = G1 (10) + G2 (4) = 14.
    assert.deepEqual(names, [...MANAGEMENT_TOOL_NAMES].sort());
    assert.equal(h.tools.length, 14);
    // G1 set is still present.
    for (const n of [
      "create_agent", "list_agents", "command_agent", "check_agent_status",
      "delete_agent", "interrupt_agent", "read_system_logs", "report_cost",
      "start_aiw", "check_aiw",
    ]) {
      assert.ok(names.includes(n as never), `missing G1 tool: ${n}`);
    }
    // G2 set is present.
    for (const n of ["run_workflow", "compose_workflow", "check_workflow", "stream_agent_logs"]) {
      assert.ok(names.includes(n as never), `missing G2 tool: ${n}`);
    }
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCreateAgentTool(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    const r = await callTool(h, "create_agent", {
      name: "tester",
      system_prompt: "p",
      user_prompt: "do work",
    });
    assert.notEqual(r.isError, true);
    const parsed = JSON.parse(r.text);
    assert.match(parsed.agent_id, /^tester-[0-9a-f]{3}$/);
    assert.equal(parsed.status, "running");
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCreateAgentMissingFields(): Promise<void> {
  const h = setup();
  try {
    const r = await callTool(h, "create_agent", {
      name: "x",
      user_prompt: "u",
    });
    assert.equal(r.isError, true);
    assert.ok(r.text.includes("system_prompt"));
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testListAgentsTool(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    await callTool(h, "create_agent", {
      name: "x",
      system_prompt: "p",
      user_prompt: "u",
    });
    const r = await callTool(h, "list_agents", {});
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.agents[0].name, "x");
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCommandAgentTool(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "first", costUsd: 0.001 });
    h.runtime.enqueue({ resultText: "second", costUsd: 0.001 });
    const create = await callTool(h, "create_agent", {
      name: "x",
      system_prompt: "p",
      user_prompt: "first",
    });
    const cid = JSON.parse(create.text).agent_id;
    await new Promise((r) => setTimeout(r, 50));
    const r = await callTool(h, "command_agent", {
      agent_id: cid,
      prompt: "second",
    });
    assert.notEqual(r.isError, true);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCheckAgentStatusTool(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    const create = await callTool(h, "create_agent", {
      name: "x",
      system_prompt: "p",
      user_prompt: "u",
    });
    const cid = JSON.parse(create.text).agent_id;
    await new Promise((r) => setTimeout(r, 50));
    const r = await callTool(h, "check_agent_status", { agent_id: cid });
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.agent_id, cid);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCheckAgentStatusUnknown(): Promise<void> {
  const h = setup();
  try {
    const r = await callTool(h, "check_agent_status", { agent_id: "nope" });
    assert.equal(r.isError, true);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testDeleteAgentTool(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    const create = await callTool(h, "create_agent", {
      name: "x",
      system_prompt: "p",
      user_prompt: "u",
    });
    const cid = JSON.parse(create.text).agent_id;
    await new Promise((r) => setTimeout(r, 50));
    const r = await callTool(h, "delete_agent", { agent_id: cid, archive: false });
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.archived, false);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testInterruptAgentTool(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001, delayMs: 200 });
    const create = await callTool(h, "create_agent", {
      name: "x",
      system_prompt: "p",
      user_prompt: "u",
    });
    const cid = JSON.parse(create.text).agent_id;
    await new Promise((r) => setTimeout(r, 50));
    const r = await callTool(h, "interrupt_agent", { agent_id: cid, hard: true });
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.kind, "hard");
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testReadSystemLogsTool(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    const create = await callTool(h, "create_agent", {
      name: "x",
      system_prompt: "p",
      user_prompt: "u",
    });
    const cid = JSON.parse(create.text).agent_id;
    await new Promise((r) => setTimeout(r, 50));
    const r = await callTool(h, "read_system_logs", { agent_id: cid });
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.source, "agent");
    assert.equal(parsed.agent_id, cid);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testReportCostTool(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.05 });
    await callTool(h, "create_agent", {
      name: "x",
      system_prompt: "p",
      user_prompt: "u",
    });
    await new Promise((r) => setTimeout(r, 50));
    const r = await callTool(h, "report_cost", {});
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.orchestrator_session_id, "orch-tools-test");
    assert.equal(parsed.subagents.length, 1);
    assert.equal(parsed.total_cost_usd, 0.05);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testStartAiwToolValidation(): Promise<void> {
  const h = setup();
  try {
    // Bad workflow.
    const r1 = await callTool(h, "start_aiw", {
      name_of_aiw: "x",
      workflow_type: "bogus",
      prompt: "u",
    });
    assert.equal(r1.isError, true);
    // Empty prompt.
    const r2 = await callTool(h, "start_aiw", {
      name_of_aiw: "x",
      workflow_type: "plan_build",
      prompt: "",
    });
    assert.equal(r2.isError, true);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCheckAiwToolNotFound(): Promise<void> {
  const h = setup();
  try {
    const r = await callTool(h, "check_aiw", { aiw_id: "nonexistent" });
    assert.equal(r.isError, true);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testToolLabelsAndDescriptions(): Promise<void> {
  const h = setup();
  try {
    for (const t of h.tools) {
      assert.ok(t.label.length > 0, `tool ${t.name} has no label`);
      assert.ok(t.description.length > 0, `tool ${t.name} has no description`);
    }
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

await testAllGrade2Registered();
await testCreateAgentTool();
await testCreateAgentMissingFields();
await testListAgentsTool();
await testCommandAgentTool();
await testCheckAgentStatusTool();
await testCheckAgentStatusUnknown();
await testDeleteAgentTool();
await testInterruptAgentTool();
await testReadSystemLogsTool();
await testReportCostTool();
await testStartAiwToolValidation();
await testCheckAiwToolNotFound();
await testToolLabelsAndDescriptions();

console.log("management tools tests passed.");
