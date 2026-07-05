// tests/orchestrator/state.test.ts — AgentState schema + transitions.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentStatus,
  abortAgent,
  completeAgent,
  deleteAgent,
  durationMs,
  failAgent,
  generateAgentId,
  interruptAgent,
  isTerminal,
  makeQueuedAgentState,
  startAgent,
  updateAgent,
  validateAgentState,
} from "../../src/core/orchestrator/state.ts";
import {
  agentPaths,
  readAgentState,
  writeAgentState,
} from "../../src/core/orchestrator/paths.ts";

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-orch-state-"));
}

async function testGenerateId(): Promise<void> {
  const id1 = generateAgentId("tester-1");
  const id2 = generateAgentId("tester-1");
  // Same name, different suffix (3 hex chars).
  assert.match(id1, /^tester-1-[0-9a-f]{3}$/);
  assert.match(id2, /^tester-1-[0-9a-f]{3}$/);
  assert.notEqual(id1, id2);

  // Names are sanitized; non-alphanumerics become hyphens.
  const id3 = generateAgentId("foo bar!");
  assert.match(id3, /^foo-bar-[0-9a-f]{3}$/);

  // Empty / all-symbol names fall back to 'agent'.
  const id4 = generateAgentId("!!!");
  assert.match(id4, /^agent-[0-9a-f]{3}$/);

  // Long names are truncated to 32 chars.
  const longName = "a".repeat(100);
  const id5 = generateAgentId(longName);
  assert.ok(id5.length <= 32 + 1 + 3);
}

async function testMakeQueued(): Promise<void> {
  const state = makeQueuedAgentState({
    name: "tester-1",
    systemPrompt: "You are a tester.",
    userPrompt: "Run the test suite.",
    tools: ["read", "bash"],
    parentSessionId: "orch-1",
  });
  assert.equal(state.schema_version, "1");
  assert.equal(state.status, AgentStatus.Queued);
  assert.equal(state.name, "tester-1");
  assert.match(state.agent_id, /^tester-1-[0-9a-f]{3}$/);
  assert.equal(state.system_prompt, "You are a tester.");
  assert.equal(state.user_prompt, "Run the test suite.");
  assert.deepEqual(state.tools, ["read", "bash"]);
  assert.equal(state.model, null);
  assert.equal(state.parent_session_id, "orch-1");
  assert.equal(state.turns, 0);
  assert.equal(state.cost_usd, null);
  assert.equal(state.result_text, null);
  assert.equal(state.subagent_template, null);
  assert.equal(state.domain, null);
  assert.equal(state.interrupt_kind, null);
  assert.ok(state.started_at);
}

async function testLifecycle(): Promise<void> {
  let state = makeQueuedAgentState({
    name: "scout",
    systemPrompt: "scout",
    userPrompt: "scout this",
    tools: ["read"],
    parentSessionId: "orch-1",
  });
  state = startAgent(state);
  assert.equal(state.status, AgentStatus.Running);

  state = completeAgent(state, {
    turns: 4,
    costUsd: 0.018,
    resultText: "scout done",
  });
  assert.equal(state.status, AgentStatus.Completed);
  assert.equal(state.turns, 4);
  assert.equal(state.cost_usd, 0.018);
  assert.equal(state.result_text, "scout done");
  assert.ok(state.ended_at);
  assert.ok(durationMs(state) !== null);
  assert.equal(isTerminal(state), true);
}

async function testFail(): Promise<void> {
  let state = makeQueuedAgentState({
    name: "x",
    systemPrompt: "x",
    userPrompt: "x",
    tools: ["read"],
    parentSessionId: "o",
  });
  state = startAgent(state);
  state = failAgent(state, "compile error");
  assert.equal(state.status, AgentStatus.Failed);
  assert.equal(state.error_message, "compile error");
  assert.equal(isTerminal(state), true);
}

async function testAbort(): Promise<void> {
  let state = makeQueuedAgentState({
    name: "x",
    systemPrompt: "x",
    userPrompt: "x",
    tools: ["read"],
    parentSessionId: "o",
  });
  state = startAgent(state);
  state = abortAgent(state);
  assert.equal(state.status, AgentStatus.Aborted);
  assert.equal(isTerminal(state), true);
}

async function testInterruptSoft(): Promise<void> {
  let state = makeQueuedAgentState({
    name: "x",
    systemPrompt: "x",
    userPrompt: "x",
    tools: ["read"],
    parentSessionId: "o",
  });
  state = startAgent(state);
  state = interruptAgent(state, "soft");
  assert.equal(state.status, AgentStatus.Interrupted);
  assert.equal(state.interrupt_kind, "soft");
  assert.equal(isTerminal(state), true);
}

async function testInterruptHard(): Promise<void> {
  let state = makeQueuedAgentState({
    name: "x",
    systemPrompt: "x",
    userPrompt: "x",
    tools: ["read"],
    parentSessionId: "o",
  });
  state = startAgent(state);
  state = interruptAgent(state, "hard");
  assert.equal(state.status, AgentStatus.Interrupted);
  assert.equal(state.interrupt_kind, "hard");
}

async function testDelete(): Promise<void> {
  let state = makeQueuedAgentState({
    name: "x",
    systemPrompt: "x",
    userPrompt: "x",
    tools: ["read"],
    parentSessionId: "o",
  });
  state = startAgent(state);
  state = completeAgent(state, { turns: 1, costUsd: 0.01, resultText: "ok" });
  state = deleteAgent(state);
  assert.equal(state.status, AgentStatus.Deleted);
  // ended_at was set by completeAgent; deleteAgent doesn't overwrite.
  assert.ok(state.ended_at);
  assert.equal(isTerminal(state), true);
}

async function testUpdateAgent(): Promise<void> {
  let state = makeQueuedAgentState({
    name: "x",
    systemPrompt: "x",
    userPrompt: "x",
    tools: ["read"],
    parentSessionId: "o",
  });
  state = startAgent(state);
  state = updateAgent(state, { turns: 3, cost_usd: 0.005 });
  assert.equal(state.turns, 3);
  assert.equal(state.cost_usd, 0.005);
  state = updateAgent(state, { result_text: "partial" });
  assert.equal(state.result_text, "partial");
  // Original fields preserved.
  assert.equal(state.name, "x");
  assert.equal(state.status, AgentStatus.Running);
}

async function testValidation(): Promise<void> {
  const valid = makeQueuedAgentState({
    name: "x",
    systemPrompt: "x",
    userPrompt: "x",
    tools: ["read"],
    parentSessionId: "o",
  });
  const result = validateAgentState(valid);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.value.name, "x");
  }
  // Invalid: missing required fields.
  const result2 = validateAgentState({ name: "x" });
  assert.equal(result2.ok, false);
  if (!result2.ok) {
    assert.ok(result2.errors.length > 0);
  }
}

async function testRoundTrip(): Promise<void> {
  const configDir = tempConfigDir();
  const state = makeQueuedAgentState({
    name: "tester-1",
    systemPrompt: "p",
    userPrompt: "u",
    tools: ["read"],
    parentSessionId: "orch-1",
  });
  const paths = agentPaths(configDir, state.agent_id);
  writeAgentState(paths, state);
  const read = readAgentState(paths);
  assert.ok(read);
  assert.equal(read?.agent_id, state.agent_id);
  assert.equal(read?.name, "tester-1");
  assert.equal(read?.tools.length, 1);
  // File is 0600.
  const stat = fs.statSync(paths.stateFile);
  assert.equal(stat.mode & 0o777, 0o600);
}

async function testRoundTripCustomAgentId(): Promise<void> {
  const configDir = tempConfigDir();
  const state = makeQueuedAgentState({
    name: "x",
    systemPrompt: "p",
    userPrompt: "u",
    tools: ["read"],
    parentSessionId: "o",
    agentId: "custom-id-123",
  });
  assert.equal(state.agent_id, "custom-id-123");
  const paths = agentPaths(configDir, "custom-id-123");
  writeAgentState(paths, state);
  const read = readAgentState(paths);
  assert.equal(read?.agent_id, "custom-id-123");
}

async function testDuration(): Promise<void> {
  const state = makeQueuedAgentState({
    name: "x",
    systemPrompt: "p",
    userPrompt: "u",
    tools: ["read"],
    parentSessionId: "o",
    startedAt: "2026-07-01T12:00:00.000Z",
  });
  // No ended_at yet → null
  assert.equal(durationMs(state), null);
  const completed = completeAgent(state, {
    turns: 1,
    costUsd: 0.01,
    resultText: "ok",
  });
  // ended_at is `new Date().toISOString()` — non-null duration
  const ms = durationMs(completed);
  assert.ok(ms !== null && ms >= 0);
}

await testGenerateId();
await testMakeQueued();
await testLifecycle();
await testFail();
await testAbort();
await testInterruptSoft();
await testInterruptHard();
await testDelete();
await testUpdateAgent();
await testValidation();
await testRoundTrip();
await testRoundTripCustomAgentId();
await testDuration();

console.log("orchestrator state tests passed.");