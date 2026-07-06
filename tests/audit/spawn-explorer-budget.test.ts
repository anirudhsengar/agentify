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
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await testRejectsWhenTotalSpawnBudgetIsExhausted();
await testRejectsWhenConcurrentSpawnBudgetIsExhausted();

console.log("spawn-explorer budget tests passed.");
