// tests/orchestrator/agent-manager.test.ts — AgentManager lifecycle.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentManager } from "../../src/core/orchestrator/agent-manager.ts";
import { SubagentRegistry } from "../../src/core/orchestrator/subagent-registry.ts";
import { FakeRuntime } from "./fake-runtime.ts";
import {
  agentPaths,
  orchestratorPaths,
  readAgentState,
} from "../../src/core/orchestrator/paths.ts";
import {
  AgentStatus,
  isTerminal,
} from "../../src/core/orchestrator/state.ts";
import type { AgentState } from "../../src/core/orchestrator/state.ts";

interface TestHarness {
  configDir: string;
  cwd: string;
  runtime: FakeRuntime;
  registry: SubagentRegistry;
  manager: AgentManager;
  cleanup: () => void;
}

function setup(extraAgents: Array<{ name: string; body: string }> = []): TestHarness {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-mgr-cfg-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-mgr-cwd-"));
  // Pre-create orchestrator dir.
  const orchPaths = orchestratorPaths(configDir);
  fs.mkdirSync(orchPaths.orchestratorRoot, { recursive: true });
  fs.writeFileSync(orchPaths.eventsFile, "");
  fs.writeFileSync(orchPaths.costFile, JSON.stringify({ orchestrator_cost_usd: 0, total_cost_usd: 0, per_agent: {}, per_aiw: {} }));

  // Optionally create .pi/agents/*.md fixtures.
  if (extraAgents.length > 0) {
    const agentsDir = path.join(cwd, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const a of extraAgents) {
      fs.writeFileSync(path.join(agentsDir, `${a.name}.md`), a.body, { mode: 0o600 });
    }
  }

  const runtime = new FakeRuntime();
  const registry = SubagentRegistry.fromCwd(cwd, configDir);
  const manager = new AgentManager({
    configDir,
    cwd,
    runtime,
    registry,
    orchestratorSessionId: "orch-test",
  });

  return {
    configDir,
    cwd,
    runtime,
    registry,
    manager,
    cleanup: () => {
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

// helper: wait for an agent's state on disk to reach a terminal status.
async function waitForTerminal(
  configDir: string,
  agentId: string,
  timeoutMs = 5000,
): Promise<AgentState> {
  const paths = agentPaths(configDir, agentId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = readAgentState(paths);
    if (s && isTerminal(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitForTerminal: agent ${agentId} did not reach terminal in ${timeoutMs}ms`);
}

async function testCreateAndComplete(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "scout done", costUsd: 0.012, turns: 3 });
    const result = await h.manager.createAgent({
      name: "tester",
      system_prompt: "You are a tester.",
      user_prompt: "Run the test suite.",
      tools: ["read"],
    });
    assert.match(result.agent_id, /^tester-[0-9a-f]{3}$/);
    assert.equal(result.name, "tester");
    assert.equal(result.status, AgentStatus.Running);

    // Wait for terminal state.
    const final = await waitForTerminal(h.configDir, result.agent_id);
    assert.equal(final.status, AgentStatus.Completed);
    assert.equal(final.turns, 3);
    assert.equal(final.cost_usd, 0.012);
    assert.equal(final.result_text, "scout done");

    // The fake runtime recorded one call.
    assert.equal(h.runtime.calls.length, 1);
    assert.equal(h.runtime.calls[0]?.systemPrompt, "You are a tester.");
    assert.equal(h.runtime.calls[0]?.userPrompt, "Run the test suite.");
    assert.deepEqual(h.runtime.calls[0]?.tools, ["read"]);

    // list_agents returns the completed agent.
    const list = h.manager.listAgents();
    assert.ok(list.find((a) => a.agent_id === result.agent_id));
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCreateAgentFilterList(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    const a1 = await h.manager.createAgent({ name: "x", system_prompt: "x", user_prompt: "x", tools: ["read"] });
    const a2 = await h.manager.createAgent({ name: "y", system_prompt: "y", user_prompt: "y", tools: ["read"] });
    await waitForTerminal(h.configDir, a1.agent_id);
    await waitForTerminal(h.configDir, a2.agent_id);

    const all = h.manager.listAgents();
    assert.equal(all.length, 2);

    const completed = h.manager.listAgents({ status: [AgentStatus.Completed] });
    assert.equal(completed.length, 2);

    const running = h.manager.listAgents({ status: [AgentStatus.Running] });
    assert.equal(running.length, 0);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testInterruptSoft(): Promise<void> {
  const h = setup();
  try {
    // Soft interrupt = AbortController fires; fake runtime flips aborted=true.
    h.runtime.enqueue({ resultText: "partial", costUsd: 0.005, turns: 1, delayMs: 200 });
    const result = await h.manager.createAgent({
      name: "slow",
      system_prompt: "x",
      user_prompt: "x",
      tools: ["read"],
    });
    // Issue a soft interrupt immediately.
    await h.manager.interruptAgent(result.agent_id, { hard: false });
    const final = await waitForTerminal(h.configDir, result.agent_id);
    assert.equal(final.status, AgentStatus.Interrupted);
    assert.equal(final.interrupt_kind, "soft");
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testInterruptHard(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "running", costUsd: 0.005, turns: 1, delayMs: 200 });
    const result = await h.manager.createAgent({
      name: "fast",
      system_prompt: "x",
      user_prompt: "x",
      tools: ["read"],
    });
    await h.manager.interruptAgent(result.agent_id, { hard: true });
    const final = await waitForTerminal(h.configDir, result.agent_id);
    assert.equal(final.status, AgentStatus.Interrupted);
    assert.equal(final.interrupt_kind, "hard");
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testDeleteArchive(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    const result = await h.manager.createAgent({
      name: "x",
      system_prompt: "x",
      user_prompt: "x",
      tools: ["read"],
    });
    await waitForTerminal(h.configDir, result.agent_id);
    const out = await h.manager.deleteAgent(result.agent_id, { archive: true });
    assert.equal(out.archived, true);
    // Original agent root should not exist; the _archive should.
    const archiveRoot = path.join(h.configDir, "orchestrator", "agents", "_archive");
    assert.ok(fs.existsSync(archiveRoot));
    const archived = fs.readdirSync(archiveRoot);
    assert.equal(archived.length, 1);
    assert.ok(archived[0]?.startsWith(result.agent_id));
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testDeleteNoArchive(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    const result = await h.manager.createAgent({
      name: "x",
      system_prompt: "x",
      user_prompt: "x",
      tools: ["read"],
    });
    await waitForTerminal(h.configDir, result.agent_id);
    const out = await h.manager.deleteAgent(result.agent_id, { archive: false });
    assert.equal(out.archived, false);
    const paths = agentPaths(h.configDir, result.agent_id);
    assert.equal(fs.existsSync(paths.agentRoot), false);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCommandAgent(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "first reply", costUsd: 0.001 });
    h.runtime.enqueue({ resultText: "second reply", costUsd: 0.001 });
    const initial = await h.manager.createAgent({
      name: "x",
      system_prompt: "p",
      user_prompt: "first",
      tools: ["read"],
    });
    await waitForTerminal(h.configDir, initial.agent_id);
    // Capture the ended_at from the first session — we use it to
    // detect when the second session has written its terminal state.
    const firstState = readAgentState(agentPaths(h.configDir, initial.agent_id));
    assert.ok(firstState);
    const firstEndedAt = firstState?.ended_at ?? "";

    const cmd = await h.manager.commandAgent({
      agent_id: initial.agent_id,
      prompt: "second",
    });
    assert.equal(cmd.agent_id, initial.agent_id);

    // Wait for the second session to write a NEW terminal state
    // (ended_at strictly greater than the first session's).
    const start = Date.now();
    let final: AgentState | null = null;
    while (Date.now() - start < 5000) {
      const s = readAgentState(agentPaths(h.configDir, initial.agent_id));
      if (s && s.ended_at && s.ended_at > firstEndedAt) {
        final = s;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(final, "second session terminal state not written");
    assert.ok((final?.result_text ?? "").includes("first reply"));
    assert.ok((final?.result_text ?? "").includes("second reply"));
    assert.equal(h.runtime.calls.length, 2);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testReportCost(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.05 });
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.02 });
    const a1 = await h.manager.createAgent({ name: "a", system_prompt: "p", user_prompt: "u", tools: ["read"] });
    const a2 = await h.manager.createAgent({ name: "b", system_prompt: "p", user_prompt: "u", tools: ["read"] });
    await waitForTerminal(h.configDir, a1.agent_id);
    await waitForTerminal(h.configDir, a2.agent_id);
    const cost = h.manager.reportCost();
    assert.equal(cost.orchestrator_session_id, "orch-test");
    assert.equal(cost.orchestrator_cost_usd, 0);
    assert.equal(cost.subagents.length, 2);
    const sumSub = cost.subagents.reduce((acc, s) => acc + (s.cost_usd ?? 0), 0);
    assert.equal(sumSub, 0.07);
    assert.equal(cost.total_cost_usd, 0.07);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testReportCostWithAiw(): Promise<void> {
  const h = setup();
  try {
    const cost = h.manager.reportCost([
      { aiw_id: "a1", workflow: "plan_build", cost_usd: 0.10, status: "completed" },
      { aiw_id: "a2", workflow: "plan_build_review", cost_usd: 0.25, status: "running" },
    ]);
    assert.equal(cost.aiws.length, 2);
    assert.equal(cost.total_cost_usd, 0.35);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCheckAgentStatus(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.005 });
    const result = await h.manager.createAgent({
      name: "x",
      system_prompt: "p",
      user_prompt: "u",
      tools: ["read"],
    });
    await waitForTerminal(h.configDir, result.agent_id);

    const status = h.manager.checkAgentStatus(result.agent_id);
    assert.equal(status.agent_id, result.agent_id);
    assert.equal(status.status, AgentStatus.Completed);
    assert.equal(status.cost_usd, 0.005);
    assert.ok(status.recent_events.length > 0);
    // Tail of 1 returns 1 event.
    const tail1 = h.manager.checkAgentStatus(result.agent_id, { tail: 1 });
    assert.equal(tail1.recent_events.length, 1);
    // Offset 1 returns events[1:].
    const off1 = h.manager.checkAgentStatus(result.agent_id, { offset: 1, tail: 1 });
    assert.equal(off1.recent_events.length, 1);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCheckAgentStatusUnknown(): Promise<void> {
  const h = setup();
  try {
    let threw = false;
    try {
      h.manager.checkAgentStatus("nope-not-here");
    } catch (err) {
      threw = true;
      assert.ok((err as Error).message.includes("not found"));
    }
    assert.equal(threw, true);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testReadSystemLogsAgent(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    const result = await h.manager.createAgent({
      name: "x",
      system_prompt: "p",
      user_prompt: "u",
      tools: ["read"],
    });
    await waitForTerminal(h.configDir, result.agent_id);

    const logs = h.manager.readSystemLogs({ agent_id: result.agent_id, tail: 50 });
    assert.equal(logs.source, "agent");
    assert.equal(logs.agent_id, result.agent_id);
    assert.ok(logs.events.length > 0);

    // Filter by event_type
    const filtered = h.manager.readSystemLogs({
      agent_id: result.agent_id,
      event_type: "message_end",
    });
    for (const e of filtered.events) {
      assert.equal(e.kind.includes("message_end"), true);
    }
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCreateAgentWithTemplate(): Promise<void> {
  const h = setup([
    {
      name: "scout-report-suggest",
      body: `---
name: scout-report-suggest
description: Read-only scout.
tools: read, grep, find, ls
model: haiku
---

You are a scout.`,
    },
  ]);
  try {
    h.runtime.enqueue({ resultText: "scouted", costUsd: 0.01 });
    const result = await h.manager.createAgent({
      name: "scout-1",
      subagent_template: "scout-report-suggest",
      user_prompt: "scout this dir",
    });
    await waitForTerminal(h.configDir, result.agent_id);
    const final = readAgentState(agentPaths(h.configDir, result.agent_id));
    assert.ok(final);
    assert.equal(final?.subagent_template, "scout-report-suggest");
    // The system prompt sent to the runtime is the template body.
    assert.equal(h.runtime.calls[0]?.systemPrompt.trim(), "You are a scout.");
    assert.deepEqual(h.runtime.calls[0]?.tools, ["read", "grep", "find", "ls"]);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCreateAgentBadTemplate(): Promise<void> {
  const h = setup();
  try {
    let threw = false;
    try {
      await h.manager.createAgent({
        name: "x",
        subagent_template: "no-such-template",
        user_prompt: "u",
      });
    } catch (err) {
      threw = true;
      assert.ok((err as Error).message.includes("no-such-template"));
    }
    assert.equal(threw, true);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCreateAgentFiltersCreateAgent(): Promise<void> {
  // Cardinal rule: sub-agents cannot have create_agent in their tools.
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.0 });
    await h.manager.createAgent({
      name: "x",
      system_prompt: "p",
      user_prompt: "u",
      tools: ["read", "create_agent"], // create_agent must be filtered
    });
    // The runtime recorded tools without create_agent.
    assert.deepEqual(h.runtime.calls[0]?.tools, ["read"]);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testShutdownArchivesLive(): Promise<void> {
  const h = setup();
  try {
    // Long-running agent (delay so we can shutdown before completion).
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001, delayMs: 200 });
    await h.manager.createAgent({
      name: "x",
      system_prompt: "p",
      user_prompt: "u",
      tools: ["read"],
    });
    // Capture pre-shutdown state.
    const preList = h.manager.listAgents();
    assert.equal(preList.length, 1);
    // Shutdown before the agent completes.
    await h.manager.shutdown();
    // Live map cleared.
    assert.equal(h.manager["agents"].size, 0);
    // On-disk states are still there (status=interrupted); that's fine
    // — they're not deleted, just marked.
    const postList = h.manager.listAgents();
    assert.equal(postList.length, 1);
    assert.equal(postList[0]?.status, AgentStatus.Interrupted);
  } finally {
    h.cleanup();
  }
}

await testCreateAndComplete();
await testCreateAgentFilterList();
await testInterruptSoft();
await testInterruptHard();
await testDeleteArchive();
await testDeleteNoArchive();
await testCommandAgent();
await testReportCost();
await testReportCostWithAiw();
await testCheckAgentStatus();
await testCheckAgentStatusUnknown();
await testReadSystemLogsAgent();
await testCreateAgentWithTemplate();
await testCreateAgentBadTemplate();
await testCreateAgentFiltersCreateAgent();
await testShutdownArchivesLive();

console.log("agent-manager tests passed.");
