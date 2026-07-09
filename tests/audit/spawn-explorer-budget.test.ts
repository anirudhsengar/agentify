import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSpawnExplorerTool } from "../../src/core/audit/spawn-explorer-tool.ts";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
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
    details?.resume?.state_files?.includes(".pi/agentify/codebase_map.json"),
    "budget recovery must point at the canonical map",
  );
}

async function testRejectsWhenTotalSpawnBudgetIsExhausted(): Promise<void> {
  const cwd = tempDir("spawn-budget-total");
  try {
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      maxTotalSpawns: 0,
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

async function testRejectsWhenConcurrentSpawnBudgetIsExhausted(): Promise<void> {
  const cwd = tempDir("spawn-budget-concurrent");
  try {
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      maxConcurrentSpawns: 0,
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
      maxTotalCostUsd: 0.01,
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

await testRejectsWhenTotalSpawnBudgetIsExhausted();
await testRejectsWhenConcurrentSpawnBudgetIsExhausted();
await testRejectsWhenCostBudgetIsExhausted();

console.log("spawn-explorer budget tests passed.");
