import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model, Api } from "@earendil-works/pi-ai";
import { createReadTool, createGrepTool } from "@earendil-works/pi-coding-agent";
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
    contextWindow: 1,
    maxTokens: 1,
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
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "checkout.ts"), "export function checkout() { return true; }\n");
    fs.writeFileSync(path.join(cwd, "tests", "checkout.test.ts"), "import { checkout } from '../src/checkout.js';\ncheckout();\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const head = git(cwd, "rev-parse", "HEAD");
    const auditDir = path.join(cwd, ".agentify", "runtime", "audit");
    fs.mkdirSync(auditDir, { recursive: true });
    const existingMap = makeValidCodebaseMap();
    delete existingMap.expert_evidence;
    existingMap.concern_evidence = { concerns: [], not_concerns: [] };
    const attestedMap = attestCodebaseMap(existingMap, head);
    fs.writeFileSync(
      path.join(auditDir, "codebase_map.json"),
      JSON.stringify(attestedMap),
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
    const missingIdentity = await tool.execute(
      "test-concern-portfolio-missing-identity",
      { mode: "concern_tracer", target_path: ".", focus: "Repository orientation" } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((missingIdentity as { isError?: boolean }).isError, true);
    assert.match(textFrom(missingIdentity), /requires concern with the exact application-bound concern identity/i);
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

    const unrelatedFocus = await tool.execute(
      "test-unrelated-supplemental-scout",
      { mode: "concern_scout", target_path: ".", focus: "Search for deployment behavior" } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((unrelatedFocus as { isError?: boolean }).isError, true);
    assert.equal(sessionCreated, false, "a supplemental scout must name a current compiler obligation");

    const focusedResult = await tool.execute(
      "test-focused-supplemental-scout",
      {
        mode: "concern_scout",
        target_path: ".",
        focus: "Identify the missing behavior owning checkout [src/checkout.ts, tests/checkout.test.ts]",
      } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((focusedResult as { isError?: boolean }).isError, undefined);
    assert.equal(sessionCreated, true, "a focused scout may expand an omitted compiler obligation");

    attestedMap.explorer_receipts!.receipts.push({
      sequence: 2,
      mode: "concern_scout",
      success: true,
      target_path: ".",
      focus: "Identify the missing behavior owning checkout [src/checkout.ts, tests/checkout.test.ts]",
      report_concern: null,
      failure_kind: null,
      proposed_concerns: ["Checkout lifecycle"],
    });
    fs.writeFileSync(path.join(auditDir, "codebase_map.json"), JSON.stringify(attestedMap));
    sessionCreated = false;
    const repeatedFocus = await tool.execute(
      "test-repeated-supplemental-scout",
      {
        mode: "concern_scout",
        target_path: ".",
        focus: "Identify the missing behavior owning checkout [src/checkout.ts, tests/checkout.test.ts]",
      } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((repeatedFocus as { isError?: boolean }).isError, true);
    assert.equal(sessionCreated, false, "the same uncovered cluster cannot be scouted twice");

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

async function testInitialConcernScoutRejectsParentAuthoredPortfolioCaps(): Promise<void> {
  const cwd = tempDir("spawn-budget-initial-scout-cap");
  let sessionCreated = false;
  try {
    fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      ...stubExplorerArgs(),
      createSession: async () => {
        sessionCreated = true;
        return {
          session: {
            messages: [],
            async prompt(): Promise<void> {},
            dispose(): void {},
          },
        };
      },
    });
    const result = await tool.execute(
      "test-initial-scout-cap",
      {
        mode: "concern_scout",
        target_path: ".",
        focus: "Find at most four core behavioral concerns and be concise.",
      } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textFrom(result), /initial concern_scout must derive portfolio size from evidence/i);
    assert.equal(sessionCreated, false, "an application-authored numeric cap must fail before model execution");
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
    for (let index = 0; index < 1; index += 1) {
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
            for (let index = 0; index < 1; index += 1) {
              if (aborted) break;
              const message: FakeExplorerEvent["message"] = {
                role: "assistant",
                content: "## Report\n\nComplete bounded evidence.",
                stopReason: "stop",
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
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.match(textFrom(result), /Complete bounded evidence/i);
    assert.equal(abortCount, 0);
    assert.equal((result.details as { max_provider_calls?: number } | undefined)?.max_provider_calls, 1);
    assert.equal(budget.snapshot().model_calls, 2, "one aggregate call must remain for the parent");
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
    fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
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
      { mode: "topography", target_path: ".", focus: "repository shape" } as never,
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

async function testParentCancellationStopsExplorer(): Promise<void> {
  for (const phase of ["before-dispatch", "during-creation", "during-prompt", "during-completion"] as const) {
    const cwd = tempDir("spawn-parent-cancellation");
    const controller = new AbortController();
    let created = 0;
    let prompted = 0;
    let aborted = 0;
    let disposed = 0;
    let cleared = 0;
    try {
      if (phase === "before-dispatch") controller.abort();
      const tool = createSpawnExplorerTool({
        agentDir: cwd,
        stateDir: ".agentify/runtime/audit",
        maxSubagentDurationMs: 20,
        ...stubExplorerArgs(),
        createSession: async () => {
          created += 1;
          if (phase === "during-creation") controller.abort();
          return { session: {
            messages: [{ role: "assistant", content: "## Report\nRepository entry documented." }],
            async prompt(): Promise<void> {
              prompted += 1;
              controller.abort();
              if (phase === "during-completion") return;
              await new Promise<void>(() => {});
            },
            async abort(): Promise<void> { aborted += 1; },
            clearQueue(): void { cleared += 1; },
            dispose(): void { disposed += 1; },
          } };
        },
      });
      const result = await tool.execute("cancel", { target_path: "." } as never,
        controller.signal, undefined, { cwd } as never);
      assert.equal((result as { isError?: boolean }).isError, true, phase);
      assert.match(textFrom(result), /abort|cancel/i, phase);
      assert.equal(created, phase === "before-dispatch" ? 0 : 1, phase);
      assert.equal(prompted, phase === "during-prompt" || phase === "during-completion" ? 1 : 0, phase);
      assert.equal(aborted, created, phase);
      assert.equal(cleared, created, phase);
      assert.equal(disposed, created, phase);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}

async function testSubagentTimeoutReturnsControlToAudit(): Promise<void> {
  const cwd = tempDir("spawn-budget-timeout");
  try {
    fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
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
        target_path: cwd,
        concern: "procedural macro derives and diagnostics",
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
    assert.equal(
      details?.target_path,
      ".",
      "trusted receipt details must canonicalize an absolute repository target",
    );
    assert.equal(details?.focus, "procedural macro derives and diagnostics");
    assert.equal(details?.failure_kind, "timeout");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testConcernTracerDefaultsLeaveRoomForARealPortfolio(
  observation: "read" | "grep-directory" | "grep-file" | "wrong-subtree" | "listing" | "failed-read" | "no-matches" | "none" | "cancelled" | "compact" | "ownership-context" | "terminal-at-cap" | "terminal-early" | "invalid-at-cap",
): Promise<void> {
  const cwd = tempDir("spawn-budget-concern-portfolio");
  const controller = new AbortController();
  try {
    fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
    fs.mkdirSync(path.join(cwd, "other"));
    fs.writeFileSync(path.join(cwd, "other/README.md"), "# fixture\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const report = `## Report
\`\`\`json
{"concern":"Repository orientation","one_line":"Owns the documented entry path.","covers":"The repository entry documentation.","excludes":"Runtime behavior outside the entry path.","flows":[{"name":"read entry documentation","description":"A reader follows the repository entry path.","steps":[{"path":"README.md","what_happens":"Introduces the repository."},{"path":"README.md","what_happens":"Provides the first operational reference."}]}],"touchpoints":[{"path":"README.md","symbol":null,"role":"Defines the entry documentation.","line_range":null,"centrality":"core"}],"invariants":[{"rule":"The entry remains documented.","why":"New contributors otherwise lack a starting point.","reference":"README.md"}],"pitfalls":[{"risk":"The entry documentation drifts.","consequence":"Repository orientation becomes unreliable.","reference":"README.md"}],"entry_questions":["Does this change alter the documented entry?"],"validation":[],"spans_subtrees":["README.md"],"stability":"high","recurrence":"medium","confidence":"high","adjacent_concerns":[],"blocker_reason":null}
\`\`\``;
    if (observation === "ownership-context") {
      const existing = makeValidCodebaseMap();
      type Concern = NonNullable<typeof existing.concern_evidence>["concerns"][number];
      const prior = JSON.parse(report.slice(report.indexOf("{"), report.lastIndexOf("}") + 1)) as Concern;
      const lastUpdated = git(cwd, "show", "-s", "--format=%cI", "HEAD");
      existing.concern_evidence = { concerns: [
        { ...prior, concern: "Entry dispatch", last_updated: lastUpdated },
        ...Array.from({ length: 40 }, (_, index) => ({
          ...prior, concern: `Other provisional owner ${index}: ${"x".repeat(250)}`, last_updated: lastUpdated,
        })),
      ], not_concerns: [] };
      const dir = path.join(cwd, ".agentify/runtime/audit");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "codebase_map.json"), JSON.stringify(existing));
    }
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      // This observation test starts the real grep subprocess; deadline
      // enforcement has its own 20ms timeout test above.
      maxSubagentDurationMs: 5_000,
      ...stubExplorerArgs(),
      createSession: async (sessionOptions) => {
        assert.ok(sessionOptions);
        const submissionTool = sessionOptions.customTools?.find((candidate) => candidate.name === "submit_concern_report");
        assert.ok(submissionTool, "concern tracer must receive the typed submission tool");
        assert.ok(
          sessionOptions.tools?.includes("submit_concern_report"),
          "the typed submission tool must be requested in the explorer session tool list",
        );
        let aborted = false;
        let release: (() => void) | undefined;
        const listeners = new Set<(event: unknown) => void>();
        return {
          session: {
            messages: [],
            subscribe(listener: (event: unknown) => void): () => void {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            async abort(): Promise<void> { aborted = true; release?.(); },
            clearQueue(): void {},
            async prompt(task: string): Promise<void> {
              if (observation === "ownership-context") {
                assert.ok(task.includes(cwd), "the stateless tracer needs the actual repository tool root");
                assert.ok(task.includes('"Entry dispatch"'), "the tracer needs existing core claims before proposing overlap");
                assert.ok(task.includes('"README.md"'));
                assert.match(task, /provisional.*claims/i);
                assert.ok(Buffer.byteLength(task) < 10_000, "ownership context must stay bounded independently of portfolio size");
                assert.match(task, /[1-9][0-9]* claims omitted/);
              }
              if (observation !== "none") {
                const isGrep = observation.startsWith("grep-") || observation === "no-matches" || observation === "wrong-subtree";
                const input = isGrep
                  ? { path: observation === "grep-file" ? "README.md" : observation === "wrong-subtree" ? "other" : ".", pattern: observation === "no-matches" ? "absentPattern" : "fixture" }
                  : { path: "README.md" };
                const observed = observation === "listing"
                  ? { content: [{ type: "text" as const, text: "README.md" }], details: undefined }
                  : isGrep
                    ? await createGrepTool(cwd).execute("observe", input as never)
                    : await createReadTool(cwd).execute("observe", input);
                for (const extension of sessionOptions.resourceLoader!.getExtensions().extensions) {
                  for (const handler of extension.handlers.get("tool_result") ?? []) {
                    await handler({
                      type: "tool_result", toolCallId: "observe",
                      toolName: observation === "listing" ? "ls" : isGrep ? "grep" : "read",
                      input, ...observed, isError: observation === "failed-read",
                    }, { cwd } as never);
                  }
                }
              }
              if (observation === "cancelled") controller.abort();
              let reportJson = report.match(/```json\s*([\s\S]*?)```/u)?.[1] ?? "null";
              if (observation === "compact") {
                const body = JSON.parse(reportJson) as { covers: string };
                while (Buffer.byteLength(JSON.stringify(body)) < 15_700) body.covers += " Observed entry contract.";
                assert.ok(Buffer.byteLength(JSON.stringify(body, null, 2)) > 16_000,
                  "whitespace alone must reproduce the historical cap failure");
                reportJson = JSON.stringify(body);
              }
              const terminal = observation.startsWith("terminal-") || observation === "invalid-at-cap";
              if (terminal) {
                const calls = observation === "terminal-early" ? 1 : 8;
                for (let call = 1; call <= calls; call += 1) {
                  for (const listener of listeners) listener({ type: "message_end", message: {
                    role: "assistant", stopReason: "toolUse",
                    content: call === calls ? [{ type: "toolCall", name: "submit_concern_report" }] : [],
                    usage: { input: 1, output: 1, cost: { total: 0 } },
                  } });
                  if (aborted) return;
                }
              }
              await submissionTool.execute(
                "submit",
                { report_json: observation === "invalid-at-cap" ? "{}" : reportJson },
                undefined,
                undefined,
                { cwd } as never,
              );
              // A provider need not settle or emit prose after its validated
              // terminal tool. Agentify must finish and cancel it itself.
              if (terminal && !aborted) await new Promise<void>((resolve) => { release = resolve; });
            },
            dispose(): void {},
          },
        };
      },
    });
    const result = await tool.execute(
      "test-concern-portfolio-budget",
      {
        mode: "concern_tracer",
        target_path: ".",
        concern: "Repository orientation",
        focus: "Repository orientation",
      } as never,
      controller.signal,
      undefined,
      { cwd } as never,
    );
    const backedBySource = observation === "read" || observation === "compact" || observation === "ownership-context" || observation.startsWith("grep-") || observation.startsWith("terminal-");
    assert.equal((result as { isError?: boolean }).isError, backedBySource ? undefined : true, `${observation}: ${textFrom(result).slice(0,1_500)}`);
    if (observation === "ownership-context") {
      const details = result.details as { structured_concern?: { touchpoints: Array<{ centrality: string }> } };
      assert.equal(details.structured_concern?.touchpoints[0]?.centrality, "core",
        "provisional hints must not silently resolve an ambiguous core claim; the compiler still owns closure");
    }
    if (observation === "cancelled") {
      assert.equal(fs.existsSync(path.join(cwd, ".agentify/runtime/audit/codebase_map.json")), false,
        "a cancelled tracer must not checkpoint a late report after parent rollback");
    }
    if (!backedBySource) return;
    if (observation === "compact") {
      const emitted = textFrom(result).match(/## Report\n```json\n([\s\S]*?)\n```/u);
      assert.ok(emitted);
      assert.ok(Buffer.byteLength(emitted[0]) <= 16_000, "the actual emitted report must satisfy the same cap");
      const original = JSON.parse(report.match(/```json\s*([\s\S]*?)```/u)![1]!) as { flows: unknown };
      const returned = JSON.parse(emitted[1]!) as { flows: unknown };
      assert.deepEqual(returned.flows, original.flows, "compact transport must preserve every flow step");
    }
    const details = result.details as { max_reads?: number; max_provider_calls?: number } | undefined;
    assert.equal(details?.max_reads, 6);
    assert.equal(details?.max_provider_calls, 8);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testCancelledRequestAdmissionIsCharged(kind: "cancel" | "retry"): Promise<void> {
  const cwd = tempDir("spawn-admission-cancellation");
  const controller = new AbortController();
  const budget = new AuditResourceBudget({ maxModelCalls: 3 });
  try {
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".agentify/runtime/audit",
      ...stubExplorerArgs(),
      resourceBudget: budget,
      createSession: async (options) => ({
        session: {
          messages: [],
          subscribe(): () => void { return () => {}; },
          async abort(): Promise<void> {},
          clearQueue(): void {},
          dispose(): void {},
          async prompt(): Promise<void> {
            const handlers = options!.resourceLoader!.getExtensions().extensions
              .flatMap((extension) => extension.handlers.get("before_provider_request") ?? []);
            assert.ok(handlers.length > 0);
            for (const handler of handlers) await handler({ payload: {} } as never, { cwd } as never);
            if (kind === "cancel") controller.abort();
            for (const handler of handlers) {
              if (kind === "retry") await handler({ payload: {} } as never, { cwd } as never);
              else await assert.rejects(async () => handler({ payload: {} } as never, { cwd } as never),
                /cancelled by parent audit/);
            }
          },
        },
      }),
    });
    const result = await tool.execute("cancel-admitted-request",
      { mode: "topography", target_path: ".", max_total_steps: 1 } as never,
      controller.signal, undefined, { cwd } as never);
    assert.equal((result as { isError?: boolean }).isError, true);
    if (kind === "retry") assert.match(textFrom(result), /hard provider call cap/);
    assert.equal(budget.snapshot().model_calls, 1);
    assert.equal(budget.snapshot().turns, 0);
    assert.equal((result.details as { provider_calls?: number }).provider_calls, 1,
      "the explorer diagnostic must include its interrupted admitted request");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await testCancelledRequestAdmissionIsCharged("cancel");
await testCancelledRequestAdmissionIsCharged("retry");
await testRejectsWhenTotalSpawnBudgetIsExhausted();
await testInitialConcernScoutRejectsParentAuthoredPortfolioCaps();
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
await testParentCancellationStopsExplorer();
await testSubagentTimeoutReturnsControlToAudit();
for (const observation of ["terminal-at-cap", "terminal-early", "invalid-at-cap", "read", "grep-directory", "grep-file", "wrong-subtree", "listing", "failed-read", "no-matches", "none", "cancelled", "compact", "ownership-context"] as const) {
  await testConcernTracerDefaultsLeaveRoomForARealPortfolio(observation);
}

console.log("spawn-explorer budget tests passed.");
