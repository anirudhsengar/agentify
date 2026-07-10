import assert from "node:assert/strict";
import { pickTierPreset } from "../src/core/agentify-config.ts";
import type { AgentifyProvider } from "../src/core/types.ts";

function model(
  id: string,
  reasoning: boolean,
  contextWindow: number,
  provider: AgentifyProvider = "anthropic",
): { provider: AgentifyProvider; id: string; reasoning: boolean; contextWindow: number } {
  return { provider, id, reasoning, contextWindow };
}

async function maxQualityPutsStrongestInAllSlots(): Promise<void> {
  const strongest = model("claude-opus-4-8", true, 1_000_000);
  const medium = model("claude-sonnet-4-6", true, 500_000);
  const fast = model("claude-haiku-4-5-20251001", true, 200_000);
  const result = pickTierPreset([strongest, medium, fast], "max-quality");
  assert.ok(result);
  assert.deepEqual(result?.primary, { provider: "anthropic", model: "claude-opus-4-8" });
  assert.deepEqual(result?.explorer, { provider: "anthropic", model: "claude-opus-4-8" });
  assert.deepEqual(result?.lite, { provider: "anthropic", model: "claude-opus-4-8" });
}

async function balancedPutsMediumInExplorerAndScoring(): Promise<void> {
  const strongest = model("claude-opus-4-8", true, 1_000_000);
  const medium = model("claude-sonnet-4-6", true, 500_000);
  const fast = model("claude-haiku-4-5-20251001", true, 200_000);
  const result = pickTierPreset([strongest, medium, fast], "balanced");
  assert.ok(result);
  assert.deepEqual(result?.primary, { provider: "anthropic", model: "claude-opus-4-8" });
  assert.deepEqual(result?.explorer, { provider: "anthropic", model: "claude-sonnet-4-6" });
  assert.deepEqual(result?.lite, { provider: "anthropic", model: "claude-sonnet-4-6" });
}

async function costOptimizedPutsFastInExplorerAndScoring(): Promise<void> {
  const strongest = model("claude-opus-4-8", true, 1_000_000);
  const medium = model("claude-sonnet-4-6", true, 500_000);
  const fast = model("claude-haiku-4-5-20251001", true, 200_000);
  const result = pickTierPreset([strongest, medium, fast], "cost-optimized");
  assert.ok(result);
  assert.deepEqual(result?.primary, { provider: "anthropic", model: "claude-sonnet-4-6" });
  assert.deepEqual(result?.explorer, { provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  assert.deepEqual(result?.lite, { provider: "anthropic", model: "claude-haiku-4-5-20251001" });
}

async function pickerPresetsHandleEmptyRegistryGracefully(): Promise<void> {
  const result = pickTierPreset([], "max-quality");
  assert.equal(result, undefined);
}

async function pickerPresetsCollapseForSingleModel(): Promise<void> {
  // Only one model available → all three presets collapse to that model.
  const only = model("claude-haiku-4-5-20251001", true, 200_000);
  const maxQuality = pickTierPreset([only], "max-quality");
  assert.deepEqual(maxQuality?.primary, { provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  assert.deepEqual(maxQuality?.explorer, { provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  assert.deepEqual(maxQuality?.lite, { provider: "anthropic", model: "claude-haiku-4-5-20251001" });

  const balanced = pickTierPreset([only], "balanced");
  assert.deepEqual(balanced?.primary, { provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  assert.deepEqual(balanced?.explorer, { provider: "anthropic", model: "claude-haiku-4-5-20251001" });

  const cost = pickTierPreset([only], "cost-optimized");
  assert.deepEqual(cost?.primary, { provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  assert.deepEqual(cost?.explorer, { provider: "anthropic", model: "claude-haiku-4-5-20251001" });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "maxQualityPutsStrongestInAllSlots", fn: maxQualityPutsStrongestInAllSlots },
  { name: "balancedPutsMediumInExplorerAndScoring", fn: balancedPutsMediumInExplorerAndScoring },
  { name: "costOptimizedPutsFastInExplorerAndScoring", fn: costOptimizedPutsFastInExplorerAndScoring },
  { name: "pickerPresetsHandleEmptyRegistryGracefully", fn: pickerPresetsHandleEmptyRegistryGracefully },
  { name: "pickerPresetsCollapseForSingleModel", fn: pickerPresetsCollapseForSingleModel },
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
console.log(`picker-presets tests passed (${passed}/${tests.length}).`);