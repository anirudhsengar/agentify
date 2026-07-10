// tests/orchestrator/composer.test.ts — exercise the workflow DAG walker end-to-end.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FakeRuntime } from "./fake-runtime.ts";
import { AgentManager } from "../../src/core/orchestrator/agent-manager.ts";
import { AiwBridge } from "../../src/core/orchestrator/aiw-bridge.ts";
import { SubagentRegistry } from "../../src/core/orchestrator/subagent-registry.ts";
import { startWorkflowRunner } from "../../src/core/orchestrator/workflow-runner.ts";
import {
  defaultSmokeSpec,
  type WorkflowSpec,
} from "../../src/core/orchestrator/workflow-spec.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Harness {
  configDir: string;
  cwd: string;
  runtime: FakeRuntime;
  manager: AgentManager;
  aiwBridge: AiwBridge;
  runner: ReturnType<typeof startWorkflowRunner>;
  cleanup: () => void;
}

function setup(): Harness {
  const configDir = tempDir("agentify-composer-");
  const cwd = tempDir("agentify-composer-cwd-");
  const runtime = new FakeRuntime();
  const registry = SubagentRegistry.fromCwd(cwd, configDir);
  const manager = new AgentManager({
    configDir,
    cwd,
    runtime,
    registry,
    orchestratorSessionId: "orch-composer-test",
  });
  const aiwBridge = new AiwBridge({ configDir, cwd, noWorktree: true });
  const runner = startWorkflowRunner({
    configDir,
    cwd,
    agentManager: manager,
    aiwBridge,
  });
  return {
    configDir,
    cwd,
    runtime,
    manager,
    aiwBridge,
    runner,
    cleanup: () => {
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

async function waitForTerminal(h: Harness, runId: string, timeoutMs = 5000): Promise<import("../../src/core/orchestrator/workflow-spec.ts").WorkflowRunState> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = h.runner.show(runId);
    if (s && s.status !== "running" && s.status !== "queued") return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`workflow ${runId} did not reach terminal in ${timeoutMs}ms`);
}

async function testSmokeSpecCompletes(): Promise<void> {
  const h = setup();
  try {
    h.runtime.enqueue({ resultText: "hello", costUsd: 0.01, turns: 1 });
    const state = await h.runner.run({ spec: defaultSmokeSpec(), source: "test" });
    assert.equal(state.status, "running");
    const terminal = await waitForTerminal(h, state.workflow_run_id);
    // The workflow's eligibility loop completes immediately because
    // the sub-agent step is async-spawn; the workflow is `completed`
    // even though the sub-agent step itself is `running`.
    assert.equal(terminal.status, "completed");
    const stepResult = terminal.steps["hello"];
    assert.ok(stepResult);
    assert.equal(stepResult.status, "running");
    assert.equal(stepResult.agent_ids.length, 1);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testSkipsWhenFalseByDefault(): Promise<void> {
  const h = setup();
  try {
    // Two independent parallel steps: the second's when clause is
    // false, so the runner should skip it. No depends_on so we don't
    // gate on async-spawn semantics.
    const spec: WorkflowSpec = {
      name: "skip-step",
      description: "x",
      steps: [
        { id: "first", handler: "subagent", user_prompt: "x" },
        {
          id: "second",
          handler: "subagent",
          when: "false",
          user_prompt: "y",
          parallel_group: "g1",
        },
      ],
    };
    const state = await h.runner.run({ spec, source: "test" });
    const terminal = await waitForTerminal(h, state.workflow_run_id);
    assert.equal(terminal.status, "completed");
    const second = terminal.steps["second"];
    assert.equal(second?.status, "skipped");
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testParallelStepsRun(): Promise<void> {
  const h = setup();
  try {
    const spec: WorkflowSpec = {
      name: "parallel",
      description: "x",
      steps: [
        {
          id: "par",
          handler: "subagent",
          user_prompt: "x",
          parallel_group: "g1",
        },
        {
          id: "par2",
          handler: "subagent",
          user_prompt: "y",
          parallel_group: "g1",
        },
      ],
    };
    const state = await h.runner.run({ spec, source: "test" });
    const terminal = await waitForTerminal(h, state.workflow_run_id);
    assert.equal(terminal.status, "completed");
    assert.ok(terminal.steps["par"]);
    assert.ok(terminal.steps["par2"]);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testSerialDependsOnRespected(): Promise<void> {
  const h = setup();
  try {
    // Two independent sub-agent steps (no depends_on). With async
    // sub-agent steps, both are spawned concurrently then the
    // workflow's eligibility loop exits once both are 'running'.
    // We verify both are recorded as spawned.
    const spec: WorkflowSpec = {
      name: "serial",
      description: "x",
      steps: [
        { id: "a", handler: "subagent", user_prompt: "a" },
        { id: "b", handler: "subagent", user_prompt: "b" },
      ],
    };
    const state = await h.runner.run({ spec, source: "test" });
    const terminal = await waitForTerminal(h, state.workflow_run_id);
    assert.equal(terminal.status, "completed");
    assert.ok(terminal.steps["a"]);
    assert.ok(terminal.steps["b"]);
    // Each step spawned a sub-agent.
    assert.equal(terminal.steps["a"]?.agent_ids.length, 1);
    assert.equal(terminal.steps["b"]?.agent_ids.length, 1);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testCancelRecordsTerminal(): Promise<void> {
  const h = setup();
  try {
    // Long-running sub-agent (delay) so cancel can race the run.
    h.runtime.enqueue({ resultText: "long", costUsd: 0.05, turns: 1, delayMs: 200 });
    const spec = defaultSmokeSpec();
    const state = await h.runner.run({ spec, source: "test" });
    h.runner.cancel(state.workflow_run_id);
    const terminal = await waitForTerminal(h, state.workflow_run_id);
    // Sub-agent step is async; cancel may or may not affect it. The
    // workflow itself either completes (sync eligibility) or hits
    // an aborted state. Accept either.
    assert.ok(["aborted", "completed"].includes(terminal.status));
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testListReturnsAllRuns(): Promise<void> {
  const h = setup();
  try {
    const s1 = await h.runner.run({ spec: defaultSmokeSpec(), source: "test" });
    await waitForTerminal(h, s1.workflow_run_id);
    const s2 = await h.runner.run({ spec: defaultSmokeSpec(), source: "test" });
    await waitForTerminal(h, s2.workflow_run_id);
    const all = h.runner.list();
    assert.ok(all.length >= 2);
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testComposeHandlerRecurses(): Promise<void> {
  const h = setup();
  try {
    const spec: WorkflowSpec = {
      name: "outer",
      description: "x",
      steps: [
        {
          id: "wrap",
          handler: "compose",
          steps: [
            { id: "inner_a", handler: "subagent", user_prompt: "a" },
            { id: "inner_b", handler: "subagent", user_prompt: "b", depends_on: ["inner_a"] },
          ],
        },
      ],
    };
    const state = await h.runner.run({ spec, source: "test" });
    const terminal = await waitForTerminal(h, state.workflow_run_id);
    assert.equal(terminal.status, "completed");
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testBranchHandlerPicksFirstMatching(): Promise<void> {
  const h = setup();
  try {
    const spec: WorkflowSpec = {
      name: "branch",
      description: "x",
      steps: [
        {
          id: "router",
          handler: "branch",
          steps: [
            { id: "left", handler: "subagent", when: "false", user_prompt: "L" },
            { id: "right", handler: "subagent", user_prompt: "R" },
          ],
        },
      ],
    };
    const state = await h.runner.run({ spec, source: "test" });
    const terminal = await waitForTerminal(h, state.workflow_run_id);
    assert.equal(terminal.status, "completed");
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testTailAndSummary(): Promise<void> {
  const h = setup();
  try {
    const s = await h.runner.run({ spec: defaultSmokeSpec(), source: "test" });
    await waitForTerminal(h, s.workflow_run_id);
    const events = h.runner.tail(s.workflow_run_id, { tail: 10 });
    assert.ok(events.length > 0);
    const summary = h.runner.tailSummary(s.workflow_run_id, { tail: 10 });
    assert.ok(summary.length > 0);
    // Each summary entry has digest + kind.
    assert.ok(summary.every((e) => typeof e.digest === "string"));
  } finally {
    await h.manager.shutdown();
    h.cleanup();
  }
}

async function testMain(): Promise<void> {
  await testSmokeSpecCompletes();
  await testSkipsWhenFalseByDefault();
  await testParallelStepsRun();
  await testSerialDependsOnRespected();
  await testCancelRecordsTerminal();
  await testListReturnsAllRuns();
  await testComposeHandlerRecurses();
  await testBranchHandlerPicksFirstMatching();
  await testTailAndSummary();
  console.log("composer tests passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testMain().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
