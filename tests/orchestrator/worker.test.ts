// tests/orchestrator/worker.test.ts — OrchestratorWorker tests.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { OrchestratorWorker } from "../../src/core/orchestrator/worker.ts";
import { ComsPeer } from "../../src/core/orchestrator/comms/server.ts";
import { PeerRegistry, projectHash } from "../../src/core/orchestrator/comms/registry.ts";
import { orchestratorPaths } from "../../src/core/orchestrator/paths.ts";
import { FakeRuntime } from "./fake-runtime.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupHarness(opts: {
  domain: string[];
  name?: string;
}): { configDir: string; cwd: string; comsRoot: string; runtime: FakeRuntime; worker: OrchestratorWorker; cleanup: () => void } {
  const configDir = tempDir("agentify-worker-cfg-");
  const cwd = tempDir("agentify-worker-cwd-");
  const comsRoot = tempDir("agentify-worker-coms-");
  const orchPaths = orchestratorPaths(configDir);
  fs.mkdirSync(orchPaths.orchestratorRoot, { recursive: true });
  fs.writeFileSync(orchPaths.eventsFile, "");
  fs.writeFileSync(orchPaths.costFile, JSON.stringify({ orchestrator_cost_usd: 0, total_cost_usd: 0, per_agent: {}, per_aiw: {} }));

  const runtime = new FakeRuntime();
  const worker = new OrchestratorWorker({
    configDir,
    cwd,
    domain: opts.domain,
    ...(opts.name ? { name: opts.name } : {}),
    comsRoot,
    runtime,
  });

  return {
    configDir,
    cwd,
    comsRoot,
    runtime,
    worker,
    cleanup: () => {
      try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(comsRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

async function testWorkerStartsAndRegisters(): Promise<void> {
  const h = setupHarness({ domain: ["src/core/webhook/**"], name: "webhook-worker" });
  try {
    await h.worker.start();
    const registry = new PeerRegistry({ registryDir: h.comsRoot, project: projectHash(h.cwd) });
    const peers = registry.list().live;
    assert.equal(peers.length, 1);
    assert.equal(peers[0]?.name, "webhook-worker");
    assert.equal(peers[0]?.purpose, "domain-locked worker: src/core/webhook/**");
  } finally {
    await h.worker.stop();
    h.cleanup();
  }
}

async function testWorkerPing(): Promise<void> {
  const h = setupHarness({ domain: ["src/core/webhook/**"], name: "ping-worker" });
  try {
    await h.worker.start();
    const result = h.worker.routePing();
    assert.equal(result.pong, true);
    assert.equal(result.name, "ping-worker");
    assert.deepEqual(result.domain, ["src/core/webhook/**"]);
    assert.equal(result.pid, process.pid);
  } finally {
    await h.worker.stop();
    h.cleanup();
  }
}

async function testWorkerCreateAgentLocal(): Promise<void> {
  const h = setupHarness({ domain: ["src/core/webhook/**"], name: "create-worker" });
  try {
    await h.worker.start();
    h.runtime.enqueue({ resultText: "done", costUsd: 0.01, turns: 1 });
    const result = await h.worker.routeCreateAgent({
      name: "scout",
      system_prompt: "you are a scout",
      user_prompt: "scout the code",
      tools: ["read"],
    });
    assert.match(result.agent_id, /^scout-/);
    assert.equal(result.name, "scout");
    assert.equal(result.status, "running");
    const { readAgentState, agentPaths } = await import("../../src/core/orchestrator/paths.ts");
    const state = readAgentState(agentPaths(h.configDir, result.agent_id));
    assert.ok(state);
    assert.deepEqual(state?.domain, ["src/core/webhook/**"]);
  } finally {
    await h.worker.stop();
    h.cleanup();
  }
}

async function testWorkerListAgents(): Promise<void> {
  const h = setupHarness({ domain: ["src/**"], name: "list-worker" });
  try {
    await h.worker.start();
    h.runtime.enqueue({ resultText: "ok", costUsd: 0.001 });
    const agent = await h.worker.routeCreateAgent({
      name: "x",
      system_prompt: "x",
      user_prompt: "x",
      tools: ["read"],
    });
    const { readAgentState, agentPaths } = await import("../../src/core/orchestrator/paths.ts");
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const state = readAgentState(agentPaths(h.configDir, agent.agent_id));
      if (state?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const list = h.worker.routeListAgents();
    assert.equal(list.agents.length, 1);
    assert.equal(list.agents[0]?.agent_id, agent.agent_id);
  } finally {
    await h.worker.stop();
    h.cleanup();
  }
}

async function testWorkerPeerMeshRoundTrip(): Promise<void> {
  const h = setupHarness({ domain: ["src/**"], name: "mesh-worker" });
  try {
    await h.worker.start();
    const sender = new ComsPeer({ name: "test-sender", cwd: h.cwd, comsRoot: h.comsRoot });
    await sender.listen();
    const peers = sender.list();
    assert.ok(peers.find((peer) => peer.name === "mesh-worker"));
    const pending = sender.send("mesh-worker", JSON.stringify({ op: "ping", args: {} }));
    const result = await sender.await(pending.msg_id, 5_000);
    assert.equal(result.status, "complete");
    const response = JSON.parse(result.response?.body ?? "{}") as { ok: boolean; result: { pong: boolean; name: string } };
    assert.equal(response.ok, true);
    assert.equal(response.result.pong, true);
    assert.equal(response.result.name, "mesh-worker");
    await sender.close();
  } finally {
    await h.worker.stop();
    h.cleanup();
  }
}

async function testWorkerCheckAgentStatus(): Promise<void> {
  const h = setupHarness({ domain: ["src/**"], name: "check-worker" });
  try {
    await h.worker.start();
    h.runtime.enqueue({ resultText: "scout done", costUsd: 0.01 });
    const agent = await h.worker.routeCreateAgent({
      name: "scout",
      system_prompt: "x",
      user_prompt: "x",
      tools: ["read"],
    });
    const { readAgentState, agentPaths } = await import("../../src/core/orchestrator/paths.ts");
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const state = readAgentState(agentPaths(h.configDir, agent.agent_id));
      if (state?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const result = h.worker.routeCheckAgentStatus({ agent_id: agent.agent_id }) as { agent_id: string; status: string };
    assert.equal(result.agent_id, agent.agent_id);
    assert.equal(result.status, "completed");
  } finally {
    await h.worker.stop();
    h.cleanup();
  }
}

async function testWorkerStopDeregisters(): Promise<void> {
  const h = setupHarness({ domain: ["src/**"], name: "stop-worker" });
  try {
    await h.worker.start();
    const registry = new PeerRegistry({ registryDir: h.comsRoot, project: projectHash(h.cwd) });
    assert.equal(registry.list().live.length, 1);
    await h.worker.stop();
    assert.equal(registry.list().live.length, 0);
  } finally {
    h.cleanup();
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "workerStartsAndRegisters", fn: testWorkerStartsAndRegisters },
  { name: "workerPing", fn: testWorkerPing },
  { name: "workerCreateAgentLocal", fn: testWorkerCreateAgentLocal },
  { name: "workerListAgents", fn: testWorkerListAgents },
  { name: "workerPeerMeshRoundTrip", fn: testWorkerPeerMeshRoundTrip },
  { name: "workerCheckAgentStatus", fn: testWorkerCheckAgentStatus },
  { name: "workerStopDeregisters", fn: testWorkerStopDeregisters },
];

let passed = 0;
for (const testCase of tests) {
  try {
    await testCase.fn();
    passed += 1;
    console.log(`  ok ${testCase.name}`);
  } catch (err) {
    console.error(`  FAIL ${testCase.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
}
console.log(`orchestrator worker tests passed (${passed}/${tests.length}).`);
