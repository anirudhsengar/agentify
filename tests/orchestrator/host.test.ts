// tests/orchestrator/host.test.ts — OrchestratorHost wiring + boot + shutdown.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OrchestratorHost } from "../../src/core/orchestrator/host.ts";
import { FakeRuntime } from "./fake-runtime.ts";
import {
  orchestratorPaths,
  readOrchestratorSession,
} from "../../src/core/orchestrator/paths.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testBoot(): Promise<void> {
  const cfg = tempDir("agentify-host-boot-");
  const cwd = tempDir("agentify-host-cwd-");
  try {
    const runtime = new FakeRuntime();
    const host = new OrchestratorHost({
      configDir: cfg,
      cwd,
      runtime,
      noBoot: true,
    });
    host.start();
    // Session record was written.
    const rec = readOrchestratorSession(orchestratorPaths(cfg));
    assert.ok(rec);
    assert.equal(rec?.cwd, cwd);
    assert.match(rec?.session_id ?? "", /^orch-[0-9a-f]{16}$/);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testShutdownArchivesLive(): Promise<void> {
  const cfg = tempDir("agentify-host-shutdown-");
  const cwd = tempDir("agentify-host-cwd-");
  try {
    const runtime = new FakeRuntime();
    const host = new OrchestratorHost({
      configDir: cfg,
      cwd,
      runtime,
      noBoot: true,
    });
    host.start();
    await host.shutdown();
    // Orchestrator events.jsonl has shutdown event.
    const eventsFile = path.join(cfg, "orchestrator", "events.jsonl");
    const events = fs.readFileSync(eventsFile, "utf-8").split("\n").filter(Boolean);
    const kinds = events.map((line) => JSON.parse(line).kind);
    assert.ok(kinds.includes("orchestrator_shutdown"));
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testStatus(): Promise<void> {
  const cfg = tempDir("agentify-host-status-");
  const cwd = tempDir("agentify-host-cwd-");
  try {
    const runtime = new FakeRuntime();
    const host = new OrchestratorHost({
      configDir: cfg,
      cwd,
      runtime,
      noBoot: true,
    });
    host.start();
    const status = host.status();
    assert.equal(status.cwd, cwd);
    assert.equal(status.config_dir, cfg);
    assert.equal(status.live_agents, 0);
    assert.equal(status.live_aiws, 0);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testChatDelegatesToSubAgent(): Promise<void> {
  const cfg = tempDir("agentify-host-chat-");
  const cwd = tempDir("agentify-host-cwd-");
  try {
    // Pre-script the runtime to respond to a "create_agent" call
    // by... actually, FakeRuntime doesn't interpret LLM tool calls;
    // it just plays the script. We test that the orchestrator's
    // session was created with the right tools and prompt.

    const runtime = new FakeRuntime();
    runtime.enqueue({ resultText: "ok", costUsd: 0.05 });

    const host = new OrchestratorHost({
      configDir: cfg,
      cwd,
      runtime,
      noBoot: true,
    });
    host.start();
    const reply = await host.chat("create a tester agent and run /scout");
    assert.equal(reply.text, "ok");
    assert.equal(reply.cost_usd, 0.05);
    // The runtime was called once (one session), with 14 customTools
    // (G1: 10 + G2: 4). The orchestrator's allowlist is +4 since G2.
    assert.equal(runtime.calls.length, 1);
    assert.equal(runtime.calls[0]?.customTools, 14);
    // The orchestrator's session has tools: [] (no Pi built-ins).
    assert.deepEqual(runtime.calls[0]?.tools, []);
    // The system prompt contains the cardinal rule + registry.
    const prompt = runtime.calls[0]?.systemPrompt ?? "";
    assert.ok(prompt.includes("You DO NOT have"));
    assert.ok(prompt.includes("create_agent"));
    assert.ok(prompt.includes("no sub-agent templates") || prompt.includes("(no sub-agent templates"));
    // The user prompt is forwarded as-is.
    assert.equal(runtime.calls[0]?.userPrompt, "create a tester agent and run /scout");
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testSessionIdPersistsAcrossBoot(): Promise<void> {
  const cfg = tempDir("agentify-host-sessid-");
  const cwd = tempDir("agentify-host-cwd-");
  try {
    const runtime = new FakeRuntime();
    // First boot.
    const host1 = new OrchestratorHost({
      configDir: cfg,
      cwd,
      runtime,
      noBoot: true,
    });
    host1.start();
    const id1 = host1.sessionId;
    // Second boot (simulated daemon restart).
    const host2 = new OrchestratorHost({
      configDir: cfg,
      cwd,
      runtime,
      noBoot: true,
    });
    host2.start();
    assert.equal(host2.sessionId, id1);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testGetAgentManager(): Promise<void> {
  const cfg = tempDir("agentify-host-getm-");
  const cwd = tempDir("agentify-host-cwd-");
  try {
    const runtime = new FakeRuntime();
    const host = new OrchestratorHost({
      configDir: cfg,
      cwd,
      runtime,
      noBoot: true,
    });
    const manager = host.getAgentManager();
    assert.ok(manager);
    assert.equal(typeof manager.createAgent, "function");
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await testBoot();
await testShutdownArchivesLive();
await testStatus();
await testChatDelegatesToSubAgent();
await testSessionIdPersistsAcrossBoot();
await testGetAgentManager();

console.log("orchestrator host tests passed.");