import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model, Api } from "@earendil-works/pi-ai";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { createSpawnExplorerTool } from "../../src/core/audit/spawn-explorer-tool.ts";
import { attestCodebaseMap, makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function textFrom(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return result.content?.find((block) => block.type === "text")?.text ?? "";
}

function assertBudgetResume(result: { details?: unknown }): void {
  const details = result.details as {
    resume?: {
      can_continue?: boolean;
      actions?: string[];
      state_files?: string[];
    };
  } | undefined;
  assert.equal(details?.resume?.can_continue, true);
  assert.ok(
    details?.resume?.actions?.some((action) => action.includes("write_map")),
    "budget recovery must tell the builder how to persist partial audit state",
  );
  assert.ok(
    details?.resume?.actions?.some((action) => action.includes("honest null")),
    "budget recovery must permit honest nulls for genuinely unobservable gaps",
  );
  assert.ok(
    details?.resume?.state_files?.includes(".agentify/runtime/audit/codebase_map.json"),
    "budget recovery must point at the canonical map",
  );
}

/**
 * Stub `explorerModel` for budget tests — these tests
 * never reach the model resolution path because the budget gate fires
 * before any sub-session is created.
 */
function stubExplorerArgs() {
  const stubModel = {
    id: "stub",
    name: "stub",
    provider: "stub",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    api: "openai-completions",
  } as unknown as Model<Api>;
  return { explorerModel: stubModel };
}

async function testRejectsWhenTotalSpawnBudgetIsExhausted(): Promise<void> {
  const cwd = tempDir("spawn-budget-total");
  try {
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      maxTotalSpawns: 0,
      ...stubExplorerArgs(),
    });
    const result = await tool.execute(
      "test-spawn-budget-total",
      { target_path: "." } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textFrom(result), /spawn_explorer budget exhausted/i);
    assert.deepEqual((result.details as { budget?: { max_total_spawns?: number } } | undefined)?.budget, {
      max_total_spawns: 0,
    });
    assertBudgetResume(result);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRefusesDuplicateCurrentHeadConcernScout(): Promise<void> {
  const cwd = tempDir("spawn-budget-duplicate-scout");
  let sessionCreated = false;
  try {
    fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const head = git(cwd, "rev-parse", "HEAD");
    const auditDir = path.join(cwd, ".agentify", "runtime", "audit");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, "codebase_map.json"),
      JSON.stringify(attestCodebaseMap(makeValidCodebaseMap(), head)),
    );

    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      ...stubExplorerArgs(),
      createSession: async () => {
        sessionCreated = true;
        return {
          session: {
            messages: [{ role: "assistant", content: "## Report\nconcerns:\n- concern: duplicate" }],
            async prompt(): Promise<void> {},
            dispose(): void {},
          },
        };
      },
    });
    const result = await tool.execute(
      "test-duplicate-current-head-scout",
      { mode: "concern_scout", target_path: "." } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textFrom(result), /successful current-HEAD concern_scout already exists/i);
    assert.equal(sessionCreated, false, "duplicate scout must be refused before model execution");

    fs.writeFileSync(path.join(cwd, "README.md"), "# advanced fixture\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "advance head");
    sessionCreated = false;
    const staleResult = await tool.execute(
      "test-stale-scout-receipt",
      { mode: "concern_scout", target_path: "." } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((staleResult as { isError?: boolean }).isError, undefined);
    assert.equal(sessionCreated, true, "a stale-HEAD scout receipt cannot suppress new evidence collection");

    const currentHead = git(cwd, "rev-parse", "HEAD");
    const failedScoutMap = attestCodebaseMap(makeValidCodebaseMap(), currentHead);
    failedScoutMap.explorer_receipts!.receipts[0]!.success = false;
    failedScoutMap.explorer_receipts!.receipts[0]!.failure_kind = "timeout";
    fs.writeFileSync(
      path.join(auditDir, "codebase_map.json"),
      JSON.stringify(failedScoutMap),
    );
    sessionCreated = false;
    const failedResult = await tool.execute(
      "test-failed-current-head-scout",
      { mode: "concern_scout", target_path: "." } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((failedResult as { isError?: boolean }).isError, undefined);
    assert.equal(sessionCreated, true, "a failed current-HEAD scout remains retriable");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRejectsWhenConcurrentSpawnBudgetIsExhausted(): Promise<void> {
  const cwd = tempDir("spawn-budget-concurrent");
  try {
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      maxConcurrentSpawns: 0,
      ...stubExplorerArgs(),
    });
    const result = await tool.execute(
      "test-spawn-budget-concurrent",
      { target_path: "." } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textFrom(result), /spawn_explorer concurrency budget exhausted/i);
    assert.deepEqual((result.details as { budget?: { max_concurrent_spawns?: number } } | undefined)?.budget, {
      max_concurrent_spawns: 0,
    });
    assertBudgetResume(result);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRejectsWhenCostBudgetIsExhausted(): Promise<void> {
  const cwd = tempDir("spawn-budget-cost");
  try {
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      maxTotalCostUsd: 0.01,
      ...stubExplorerArgs(),
      createSession: async () => ({
        session: {
          messages: [
            {
              role: "assistant",
              content: "## Report\n\nExploration complete.",
              usage: { cost: { total: 0.02 } },
            },
          ],
          async prompt(): Promise<void> {},
          dispose(): void {},
        },
      }),
    });

    const first = await tool.execute(
      "test-spawn-budget-cost-first",
      { target_path: "." } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((first as { isError?: boolean }).isError, undefined);
    assert.equal(
      (first.details as { cost_usd?: number } | undefined)?.cost_usd,
      0.02,
    );

    const second = await tool.execute(
      "test-spawn-budget-cost-second",
      { target_path: "." } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((second as { isError?: boolean }).isError, true);
    assert.match(textFrom(second), /spawn_explorer cost budget exhausted/i);
    assert.deepEqual(
      (second.details as { budget?: { max_total_cost_usd?: number; total_cost_usd?: number } } | undefined)?.budget,
      {
        max_total_cost_usd: 0.01,
        total_cost_usd: 0.02,
      },
    );
    assertBudgetResume(second);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testDefaultsBoundSmallRepositoryAudits(): Promise<void> {
  const cwd = tempDir("spawn-budget-defaults");
  try {
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      ...stubExplorerArgs(),
      createSession: async () => ({
        session: {
          messages: [{ role: "assistant", content: "## Report\n\nExploration complete." }],
          async prompt(): Promise<void> {},
          dispose(): void {},
        },
      }),
    });
    const result = await tool.execute(
      "test-spawn-budget-defaults",
      { target_path: "." } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    const details = result.details as {
      max_total_spawns?: number;
      max_concurrent_spawns?: number;
      max_subagent_duration_ms?: number;
      max_total_cost_usd?: number;
    } | undefined;
    assert.deepEqual(details, {
      ...details,
      max_total_spawns: 16,
      max_concurrent_spawns: 1,
      max_subagent_duration_ms: 180_000,
      max_total_cost_usd: 5,
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

interface FakeExplorerEvent {
  type: "message_end";
  message: {
    role: "assistant";
    content: string;
    stopReason: "toolUse" | "stop";
    usage: { input: number; output: number; cost: { total: number } };
  };
}

async function testHardProviderCallCapAbortsContinuation(): Promise<void> {
  const cwd = tempDir("spawn-budget-hard-call-cap");
  let abortCount = 0;
  let aborted = false;
  try {
    const listeners = new Set<(event: unknown) => void>();
    const messages: FakeExplorerEvent["message"][] = [];
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      ...stubExplorerArgs(),
      createSession: async () => ({
        session: {
          messages,
          subscribe(listener: (event: unknown) => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          clearQueue(): void {},
          async abort(): Promise<void> {
            abortCount += 1;
            aborted = true;
          },
          async prompt(): Promise<void> {
            for (let index = 0; index < 3; index += 1) {
              if (aborted) break;
              const message: FakeExplorerEvent["message"] = {
                role: "assistant",
                content: index === 1 ? "## Report\n\nPartial evidence." : "",
                stopReason: "toolUse",
                usage: { input: 10, output: 5, cost: { total: 0.001 } },
              };
              messages.push(message);
              for (const listener of listeners) listener({ type: "message_end", message });
              await Promise.resolve();
            }
          },
          dispose(): void {},
        },
      }),
    });

    const result = await tool.execute(
      "test-hard-provider-call-cap",
      { mode: "topography", target_path: ".", max_total_steps: 2 } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textFrom(result), /provider call cap of 2/i);
    assert.equal(abortCount, 1, "runtime must abort an explorer that requests another turn at the cap");
    const details = result.details as { provider_calls?: number; max_provider_calls?: number } | undefined;
    assert.equal(details?.provider_calls, 2);
    assert.equal(details?.max_provider_calls, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testFinalReportAtProviderCallCapSucceeds(): Promise<void> {
  const cwd = tempDir("spawn-budget-final-at-call-cap");
  let abortCount = 0;
  try {
    const listeners = new Set<(event: unknown) => void>();
    const messages: FakeExplorerEvent["message"][] = [];
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      ...stubExplorerArgs(),
      createSession: async () => ({
        session: {
          messages,
          subscribe(listener: (event: unknown) => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          clearQueue(): void {},
          async abort(): Promise<void> {
            abortCount += 1;
          },
          async prompt(): Promise<void> {
            for (const [content, stopReason] of [
              ["", "toolUse"],
              ["## Report\n\nComplete evidence.", "stop"],
            ] as const) {
              const message: FakeExplorerEvent["message"] = {
                role: "assistant",
                content,
                stopReason,
                usage: { input: 10, output: 5, cost: { total: 0.001 } },
              };
              messages.push(message);
              for (const listener of listeners) listener({ type: "message_end", message });
              await Promise.resolve();
            }
          },
          dispose(): void {},
        },
      }),
    });

    const result = await tool.execute(
      "test-final-at-provider-call-cap",
      { mode: "topography", target_path: ".", max_total_steps: 2 } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.match(textFrom(result), /Complete evidence/);
    assert.equal(abortCount, 0, "a complete final report at the cap must not be aborted");
    const details = result.details as { provider_calls?: number; max_provider_calls?: number } | undefined;
    assert.equal(details?.provider_calls, 2);
    assert.equal(details?.max_provider_calls, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testAggregateRemainingCallsReduceExplorerCap(): Promise<void> {
  const cwd = tempDir("spawn-budget-aggregate-call-cap");
  let abortCount = 0;
  let aborted = false;
  try {
    const budget = new AuditResourceBudget({ maxModelCalls: 3 });
    const parent = budget.beginSession();
    for (let index = 0; index < 2; index += 1) {
      budget.observeParentEvent({
        type: "message_end",
        message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0 } } },
      } as never, parent);
    }
    const listeners = new Set<(event: unknown) => void>();
    const messages: FakeExplorerEvent["message"][] = [];
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      resourceBudget: budget,
      ...stubExplorerArgs(),
      createSession: async () => ({
        session: {
          messages,
          subscribe(listener: (event: unknown) => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          clearQueue(): void {},
          async abort(): Promise<void> {
            abortCount += 1;
            aborted = true;
          },
          async prompt(): Promise<void> {
            for (let index = 0; index < 2; index += 1) {
              if (aborted) break;
              const message: FakeExplorerEvent["message"] = {
                role: "assistant",
                content: "",
                stopReason: "toolUse",
                usage: { input: 1, output: 1, cost: { total: 0 } },
              };
              messages.push(message);
              for (const listener of listeners) listener({ type: "message_end", message });
              await Promise.resolve();
            }
          },
          dispose(): void {},
        },
      }),
    });
    const result = await tool.execute(
      "test-aggregate-remaining-call-cap",
      { mode: "concern_scout", target_path: "." } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textFrom(result), /model calls reached 3 while requesting continuation/i);
    assert.equal(abortCount, 1);
    assert.equal((result.details as { max_provider_calls?: number } | undefined)?.max_provider_calls, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testModelOverridesMayOnlyNarrowTrustedModeCaps(): Promise<void> {
  const cwd = tempDir("spawn-budget-narrow-only");
  try {
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      ...stubExplorerArgs(),
      createSession: async () => ({
        session: {
          messages: [{ role: "assistant", content: "## Report\n\nComplete." }],
          async prompt(): Promise<void> {},
          dispose(): void {},
        },
      }),
    });
    const result = await tool.execute(
      "test-narrow-only",
      { mode: "topography", target_path: ".", max_reads: 32, max_total_steps: 40 } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    const details = result.details as { max_reads?: number; max_provider_calls?: number } | undefined;
    assert.equal(details?.max_reads, 8, "model input cannot raise the trusted topography read cap");
    assert.equal(details?.max_provider_calls, 12, "model input cannot raise the trusted topography call cap");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testLiveExplorerUsageAbortsAtAggregateTokenLimit(): Promise<void> {
  const cwd = tempDir("spawn-budget-live-token-cap");
  let abortCount = 0;
  let aborted = false;
  try {
    const budget = new AuditResourceBudget({ maxInputTokens: 15, maxModelCalls: 10 });
    const listeners = new Set<(event: unknown) => void>();
    const messages: FakeExplorerEvent["message"][] = [];
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      resourceBudget: budget,
      ...stubExplorerArgs(),
      createSession: async () => ({
        session: {
          messages,
          subscribe(listener: (event: unknown) => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          clearQueue(): void {},
          async abort(): Promise<void> {
            abortCount += 1;
            aborted = true;
          },
          async prompt(): Promise<void> {
            for (let index = 0; index < 3; index += 1) {
              if (aborted) break;
              const message: FakeExplorerEvent["message"] = {
                role: "assistant",
                content: "",
                stopReason: "toolUse",
                usage: { input: 10, output: 1, cost: { total: 0 } },
              };
              messages.push(message);
              for (const listener of listeners) listener({ type: "message_end", message });
              await Promise.resolve();
            }
          },
          dispose(): void {},
        },
      }),
    });
    const result = await tool.execute(
      "test-live-token-cap",
      { mode: "topography", target_path: ".", max_total_steps: 5 } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textFrom(result), /input token reserve.*next provider request/i);
    assert.equal(abortCount, 1, "aggregate token exhaustion must abort the explorer immediately");
    assert.equal((result.details as { provider_calls?: number } | undefined)?.provider_calls, 1);
    assert.equal(
      budget.snapshot().input_tokens,
      10,
      "explorer admission must stop before aggregate input usage crosses the configured cap",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testOversizedReportsFailInsteadOfBecomingReceipts(): Promise<void> {
  const cwd = tempDir("spawn-budget-report-cap");
  try {
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      ...stubExplorerArgs(),
      createSession: async () => ({
        session: {
          messages: [{ role: "assistant", content: `## Report\n\n${"x".repeat(40_000)}` }],
          async prompt(): Promise<void> {},
          dispose(): void {},
        },
      }),
    });
    const result = await tool.execute(
      "test-report-cap",
      { mode: "concern_tracer", target_path: ".", focus: "argument parsing" } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textFrom(result), /report exceeded hard output cap/i);
    assert.equal((result.details as { failure_kind?: string } | undefined)?.failure_kind, "output_limit");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testSubagentTimeoutReturnsControlToAudit(): Promise<void> {
  const cwd = tempDir("spawn-budget-timeout");
  try {
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      maxSubagentDurationMs: 20,
      ...stubExplorerArgs(),
      createSession: async () => ({
        session: {
          messages: [],
          async prompt(): Promise<void> {
            await new Promise<void>(() => {});
          },
          dispose(): void {},
        },
      }),
    });
    const result = await tool.execute(
      "test-spawn-budget-timeout",
      {
        mode: "concern_tracer",
        target_path: ".",
        focus: "procedural macro derives and diagnostics",
      } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textFrom(result), /exceeded timeout of 20ms/i);
    const details = result.details as {
      mode?: string;
      target_path?: string;
      focus?: string;
      failure_kind?: string;
    } | undefined;
    assert.equal(details?.mode, "concern_tracer");
    assert.equal(details?.target_path, ".");
    assert.equal(details?.focus, "procedural macro derives and diagnostics");
    assert.equal(details?.failure_kind, "timeout");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await testRejectsWhenTotalSpawnBudgetIsExhausted();
await testRefusesDuplicateCurrentHeadConcernScout();
await testRejectsWhenConcurrentSpawnBudgetIsExhausted();
await testRejectsWhenCostBudgetIsExhausted();
await testHardProviderCallCapAbortsContinuation();
await testFinalReportAtProviderCallCapSucceeds();
await testAggregateRemainingCallsReduceExplorerCap();
await testModelOverridesMayOnlyNarrowTrustedModeCaps();
await testLiveExplorerUsageAbortsAtAggregateTokenLimit();
await testOversizedReportsFailInsteadOfBecomingReceipts();
await testDefaultsBoundSmallRepositoryAudits();
await testSubagentTimeoutReturnsControlToAudit();

console.log("spawn-explorer budget tests passed.");
