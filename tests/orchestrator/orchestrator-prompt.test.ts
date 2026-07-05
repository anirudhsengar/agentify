// tests/orchestrator/orchestrator-prompt.test.ts — orchestrator prompt rendering.

import assert from "node:assert/strict";
import {
  DEFAULT_AIW_TYPES,
  defaultOrchestratorPaths,
  renderOrchestratorPrompt,
  type OrchestratorPromptInputs,
} from "../../src/core/orchestrator/orchestrator-prompt.ts";

function sampleInputs(overrides: Partial<OrchestratorPromptInputs> = {}): OrchestratorPromptInputs {
  return {
    subagentRegistryMarkdown: "| `scout` | Read-only scout | read | inherit |",
    workflowRegistryMarkdown: "(no workflows registered)",
    availableAiwTypes: DEFAULT_AIW_TYPES,
    sessionDir: "/tmp/orchestrator",
    conversationLog: "/tmp/orchestrator/events.jsonl",
    parentSessionId: "orch-sess-1",
    activeAgentsMarkdown: "(no agents)",
    openEscalationsMarkdown: "(no open escalations)",
    liveWorkflowsMarkdown: "(no live workflows)",
    ...overrides,
  };
}

async function testAllSubstitutions(): Promise<void> {
  const prompt = renderOrchestratorPrompt(sampleInputs({
    parentSessionId: "parent-42",
    sessionDir: "/var/orch",
    conversationLog: "/var/orch/events.jsonl",
  }));
  assert.ok(prompt.includes("parent-42"));
  assert.ok(prompt.includes("/var/orch"));
  assert.ok(prompt.includes("/var/orch/events.jsonl"));
  assert.ok(prompt.includes("| `scout` | Read-only scout | read | inherit |"));
  assert.ok(prompt.includes("plan_build_review_ship"));
  assert.ok(prompt.includes("(no agents)"));
}

async function testNoRawVariables(): Promise<void> {
  const prompt = renderOrchestratorPrompt(sampleInputs());
  // No unreplaced variable markers should remain.
  assert.equal(prompt.includes("(SUBAGENT_REGISTRY)"), false);
  assert.equal(prompt.includes("(AVAILABLE_AIW_TYPES)"), false);
  assert.equal(prompt.includes("(SESSION_DIR)"), false);
  assert.equal(prompt.includes("(CONVERSATION_LOG)"), false);
  assert.equal(prompt.includes("(PARENT_SESSION_ID)"), false);
  assert.equal(prompt.includes("(ACTIVE_AGENTS)"), false);
}

async function testCardinalRule(): Promise<void> {
  const prompt = renderOrchestratorPrompt(sampleInputs());
  // The cardinal rule must be present.
  assert.ok(prompt.includes("You DO NOT have"));
  assert.ok(prompt.includes("read"));
  assert.ok(prompt.includes("write"));
  assert.ok(prompt.includes("edit"));
  assert.ok(prompt.includes("bash"));
  // Sub-agents cannot create agents (depth cap 1).
  assert.ok(prompt.includes("NO `create_agent`"));
}

async function testAllTenToolsListed(): Promise<void> {
  const prompt = renderOrchestratorPrompt(sampleInputs());
  const requiredTools = [
    "create_agent",
    "list_agents",
    "command_agent",
    "check_agent_status",
    "delete_agent",
    "interrupt_agent",
    "read_system_logs",
    "report_cost",
    "start_aiw",
    "check_aiw",
  ];
  for (const t of requiredTools) {
    assert.ok(prompt.includes(`\`${t}\``), `prompt must mention tool ${t}`);
  }
}

async function testDefaultAiwTypesMatchesEngine(): Promise<void> {
  assert.deepEqual([...DEFAULT_AIW_TYPES], [
    "plan_build",
    "plan_build_review",
    "plan_build_review_fix",
    "plan_build_review_ship",
  ]);
}

async function testDefaultPaths(): Promise<void> {
  const paths = defaultOrchestratorPaths("/home/me/.agentify");
  assert.equal(paths.sessionDir, "/home/me/.agentify/orchestrator");
  assert.equal(paths.conversationLog, "/home/me/.agentify/orchestrator/events.jsonl");
}

async function testActiveAgentsTable(): Promise<void> {
  const prompt = renderOrchestratorPrompt(sampleInputs({
    activeAgentsMarkdown: "| tester-1-ab3 | running | 4 turns | $0.012 |",
  }));
  assert.ok(prompt.includes("tester-1-ab3"));
}

await testAllSubstitutions();
await testNoRawVariables();
await testCardinalRule();
await testAllTenToolsListed();
await testDefaultAiwTypesMatchesEngine();
await testDefaultPaths();
await testActiveAgentsTable();

console.log("orchestrator-prompt tests passed.");