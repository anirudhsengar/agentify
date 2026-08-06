import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureAgentifyConfig,
  loadAgentifyConfig,
  pickTierPreset,
} from "../src/core/agentify-config.ts";
import type { AgentifyUi } from "../src/core/types.ts";

class TestUi implements AgentifyUi {
  constructor(
    private readonly selections: string[],
    private readonly secrets: string[],
  ) {}

  status(): void {}
  info(): void {}
  error(): void {}

  async promptSelect(): Promise<string> {
    const answer = this.selections.shift();
    if (answer === undefined) throw new Error("unexpected select prompt");
    return answer;
  }

  async promptSecret(): Promise<string> {
    const answer = this.secrets.shift();
    if (answer === undefined) throw new Error("unexpected secret prompt");
    return answer;
  }
}

const models = [
  { provider: "openai" as const, id: "strong", reasoning: true, contextWindow: 200_000 },
  { provider: "openai" as const, id: "medium", reasoning: true, contextWindow: 100_000 },
  { provider: "openai" as const, id: "fast", reasoning: false, contextWindow: 50_000 },
];
assert.equal(pickTierPreset(models, "max-quality").primary?.model, "strong");
assert.equal(pickTierPreset(models, "balanced").explorer?.model, "medium");
assert.equal(pickTierPreset(models, "cost-optimized").lite?.model, "fast");
assert.deepEqual(pickTierPreset([], "balanced"), {});

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-first-run-"));
try {
  const config = await ensureAgentifyConfig(
    configDir,
    new TestUi(["openai", "max-quality"], ["sk-test"]),
  );
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.provider, "openai");
  assert.equal(config.thinkingLevel, "high");
  assert.ok(config.models.primary);
  assert.deepEqual(loadAgentifyConfig(configDir), config);
} finally {
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log("first-run picker tests passed");
