// tests/orchestrator/auto-improve.test.ts — AutoImproveScheduler tests.
//
// The scheduler implements the LEARN half of ACT -> LEARN -> REUSE
// for orchestrator-spawned agents. When an agent ends and its state
// has a non-null `expertise_path`, the scheduler:
//   1. Reads the agent's events.jsonl to find touched paths
//   2. Resolves which experts those paths belong to (via
//      `expertsTouchedBy`)
//   3. Acquires a per-domain file lock (no concurrent LEARN runs)
//   4. Runs `runSelfImprove` for each matched expert
//   5. Releases the lock
//
// The scheduler is invoked by the OrchestratorHost on every
// `agent_end` event. Tests construct it directly and call
// `onAgentEnd`; the host wiring is exercised by host.test.ts.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  AutoImproveScheduler,
  type AutoImproveSchedulerOptions,
} from "../../src/core/orchestrator/auto-improve.ts";
import {
  AgentStatus,
  makeQueuedAgentState,
  type AgentState,
} from "../../src/core/orchestrator/state.ts";
import {
  agentPaths,
  appendAgentEvent,
  ensureOrchestratorDirs,
  orchestratorPaths,
  writeAgentState,
} from "../../src/core/orchestrator/paths.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupExpert(cwd: string, domain: string, opts: { primaryPaths?: string[] } = {}): { expertisePath: string } {
  const dir = path.join(cwd, ".pi", "prompts", "experts", domain);
  fs.mkdirSync(dir, { recursive: true });
  const expertisePath = path.join(dir, "expertise.yaml");
  fs.writeFileSync(
    expertisePath,
    [
      `domain: ${domain}`,
      `last_updated: 2026-06-01T00:00:00Z`,
      `overview:`,
      `  description: ${domain} expert for tests`,
      `primary_paths:`,
      ...((opts.primaryPaths ?? [`src/${domain}/`]).map((p) => `  - ${p}`)),
      `patterns:`,
      `  - name: factory`,
      `    description: use factory`,
      `    example_ref: src/${domain}/foo.ts:12`,
      ``,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "question.md"),
    `---\ndescription: ${domain} expert — answer questions.\nargument-hint: "<question>"\n---\n\n# ${domain} Expert\n`,
  );
  fs.writeFileSync(
    path.join(dir, "self-improve.md"),
    `# ${domain} Self-Improve\n`,
  );
  return { expertisePath };
}

function setupAgent(opts: {
  configDir: string;
  cwd: string;
  agentId: string;
  expertisePath: string | null;
  touchedPaths: string[];
}): AgentState {
  const paths = agentPaths(opts.configDir, opts.agentId);
  fs.mkdirSync(paths.agentRoot, { recursive: true });
  const state = makeQueuedAgentState({
    name: "test-agent",
    systemPrompt: "you are a test",
    userPrompt: "do the test",
    tools: ["read", "write", "edit"],
    parentSessionId: "orch-test",
    agentId: opts.agentId,
    expertisePath: opts.expertisePath,
  });
  // Mark running, then completed to mimic the orchestrator's lifecycle.
  writeAgentState(paths, { ...state, status: AgentStatus.Running });
  writeAgentState(paths, { ...state, status: AgentStatus.Completed, ended_at: new Date().toISOString(), turns: 1, cost_usd: 0.01, result_text: "ok" });
  // Write events with the touched paths.
  for (const p of opts.touchedPaths) {
    appendAgentEvent(paths, {
      kind: "tool_execution_start",
      fields: { tool_name: "edit", path: p },
    });
  }
  return state;
}

function setupScheduler(opts: AutoImproveSchedulerOptions): AutoImproveScheduler {
  // Default: pass a no-op syncer that records its invocations.
  const calls: Array<{ domain: string; todayIso: string }> = [];
  const syncer = opts.syncer ?? (async ({ expert, todayIso }) => {
    calls.push({ domain: expert.domain, todayIso });
    // The syncer is responsible for writing the new YAML.
    // For tests we just bump last_updated.
    const p = path.join(opts.cwd, ".pi", "prompts", "experts", expert.domain, "expertise.yaml");
    const raw = fs.readFileSync(p, "utf-8");
    const bumped = raw.replace(/^last_updated:.*$/m, `last_updated: ${todayIso}`);
    fs.writeFileSync(p, bumped);
    return { stdout: "synced", changed: true, summary: "test syncer" };
  });
  return new AutoImproveScheduler({ ...opts, syncer });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testAgentWithoutExpertisePathIsSkipped(): Promise<void> {
  const configDir = tempDir("agentify-autoimprove-noexp-");
  const cwd = tempDir("agentify-autoimprove-noexp-cwd-");
  try {
    ensureOrchestratorDirs(orchestratorPaths(configDir));
    const agentId = "test-noexp-aaa";
    setupAgent({ configDir, cwd, agentId, expertisePath: null, touchedPaths: ["src/foo.ts"] });
    const sched = setupScheduler({ configDir, cwd });
    // Should be a no-op (return immediately) for agents without expertise_path.
    await sched.onAgentEnd(agentId);
    await sched.drain();
    // No expert directory was created.
    assert.equal(fs.existsSync(path.join(cwd, ".pi", "prompts", "experts")), false);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testAgentWithMatchingExpertTriggersSelfImprove(): Promise<void> {
  const configDir = tempDir("agentify-autoimprove-match-");
  const cwd = tempDir("agentify-autoimprove-match-cwd-");
  try {
    ensureOrchestratorDirs(orchestratorPaths(configDir));
    const { expertisePath } = setupExpert(cwd, "billing");
    const agentId = "test-match-bbb";
    setupAgent({
      configDir,
      cwd,
      agentId,
      expertisePath,
      touchedPaths: ["src/billing/stripe.ts", "src/billing/invoice.ts"],
    });
    const sched = setupScheduler({ configDir, cwd, todayIso: "2026-07-03T10:00:00Z" });
    await sched.onAgentEnd(agentId);
    await sched.drain();

    // The YAML should have its last_updated bumped.
    const updated = fs.readFileSync(expertisePath, "utf-8");
    assert.match(updated, /last_updated: 2026-07-03T10:00:00Z/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testAgentWithNoMatchingExpertIsNoOp(): Promise<void> {
  const configDir = tempDir("agentify-autoimprove-nomatch-");
  const cwd = tempDir("agentify-autoimprove-nomatch-cwd-");
  try {
    ensureOrchestratorDirs(orchestratorPaths(configDir));
    const { expertisePath } = setupExpert(cwd, "billing");
    const agentId = "test-nomatch-ccc";
    setupAgent({
      configDir,
      cwd,
      agentId,
      expertisePath,
      // Touched paths do NOT overlap with billing's primary_paths.
      touchedPaths: ["src/auth/login.ts"],
    });
    const sched = setupScheduler({ configDir, cwd, todayIso: "2026-07-03T10:00:00Z" });
    await sched.onAgentEnd(agentId);
    await sched.drain();

    // YAML unchanged.
    const after = fs.readFileSync(expertisePath, "utf-8");
    assert.match(after, /last_updated: 2026-06-01T00:00:00Z/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testSchedulerSerializesSelfImprovePerDomain(): Promise<void> {
  const configDir = tempDir("agentify-autoimprove-serial-");
  const cwd = tempDir("agentify-autoimprove-serial-cwd-");
  try {
    ensureOrchestratorDirs(orchestratorPaths(configDir));
    const { expertisePath } = setupExpert(cwd, "billing");
    const sched = setupScheduler({ configDir, cwd, todayIso: "2026-07-03T10:00:00Z" });
    // Two agents end in parallel, both touching billing.
    for (const id of ["test-serial-aaa", "test-serial-bbb"]) {
      setupAgent({
        configDir,
        cwd,
        agentId: id,
        expertisePath,
        touchedPaths: ["src/billing/foo.ts"],
      });
    }
    // Fire both without awaiting individually.
    const p1 = sched.onAgentEnd("test-serial-aaa");
    const p2 = sched.onAgentEnd("test-serial-bbb");
    await Promise.all([p1, p2]);
    await sched.drain();

    // The YAML is valid (no race overwrote it with garbage).
    const after = fs.readFileSync(expertisePath, "utf-8");
    assert.match(after, /last_updated: 2026-07-03T10:00:00Z/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testSchedulerHandlesUnknownAgentGracefully(): Promise<void> {
  const configDir = tempDir("agentify-autoimprove-unknown-");
  const cwd = tempDir("agentify-autoimprove-unknown-cwd-");
  try {
    ensureOrchestratorDirs(orchestratorPaths(configDir));
    const sched = setupScheduler({ configDir, cwd });
    // Agent id that doesn't exist on disk.
    await sched.onAgentEnd("nonexistent-agent");
    await sched.drain();
    // No exception thrown — that's the assertion.
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "agentWithoutExpertisePathIsSkipped", fn: testAgentWithoutExpertisePathIsSkipped },
  { name: "agentWithMatchingExpertTriggersSelfImprove", fn: testAgentWithMatchingExpertTriggersSelfImprove },
  { name: "agentWithNoMatchingExpertIsNoOp", fn: testAgentWithNoMatchingExpertIsNoOp },
  { name: "schedulerSerializesSelfImprovePerDomain", fn: testSchedulerSerializesSelfImprovePerDomain },
  { name: "schedulerHandlesUnknownAgentGracefully", fn: testSchedulerHandlesUnknownAgentGracefully },
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
console.log(`auto-improve tests passed (${passed}/${tests.length}).`);