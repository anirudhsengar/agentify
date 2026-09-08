import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configPath,
  loadAgentifyConfig,
  saveAgentifyConfig,
} from "../src/core/agentify-config.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withConfig(value: unknown, assertion: (configDir: string) => void): void {
  const configDir = tempDir("agentify-config-schema-");
  try {
    fs.writeFileSync(configPath(configDir), JSON.stringify(value));
    assertion(configDir);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

withConfig({
  schemaVersion: 1,
  provider: "openai",
  thinkingLevel: "high",
  models: {
    primary: { provider: "openai", model: "gpt-4o" },
    explorer: { provider: "anthropic", model: "claude-sonnet" },
  },
}, (configDir) => {
  const loaded = loadAgentifyConfig(configDir);
  assert.deepEqual(loaded.models.primary, { provider: "openai", model: "gpt-4o" });
  assert.deepEqual(loaded.models.explorer, { provider: "anthropic", model: "claude-sonnet" });
  saveAgentifyConfig(configDir, loaded);
  assert.deepEqual(loadAgentifyConfig(configDir), loaded);
});

withConfig({
  schemaVersion: 1,
  thinkingLevel: "high",
  models: {},
  auditBudgets: {
    maxSemanticRepairPasses: 2,
    maxTotalDurationMs: 3_600_000,
  },
}, (configDir) => {
  assert.deepEqual(loadAgentifyConfig(configDir).auditBudgets, {
    maxSemanticRepairPasses: 2,
    maxTotalDurationMs: 3_600_000,
  });
});

withConfig({
  provider: "openai",
  model: "legacy-default",
  thinkingLevel: "high",
  modelsByRole: {
    primary: { provider: "minimax", model: "MiniMax-M2.7-highspeed" },
    scoring: { provider: "openai", model: "legacy-lite" },
  },
  targets: ["pi"],
}, (configDir) => {
  const loaded = loadAgentifyConfig(configDir);
  assert.deepEqual(loaded, {
    schemaVersion: 1,
    provider: "openai",
    thinkingLevel: "high",
    models: {
      primary: { provider: "minimax", model: "MiniMax-M2.7-highspeed" },
      lite: { provider: "openai", model: "legacy-lite" },
    },
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(configPath(configDir), "utf-8")) as unknown,
    loaded,
  );
});

withConfig({
  provider: "minimax",
  model: "MiniMax-M2.7-highspeed",
  modelsByRole: {},
}, (configDir) => {
  assert.deepEqual(loadAgentifyConfig(configDir).models.primary, {
    provider: "minimax",
    model: "MiniMax-M2.7-highspeed",
  });
});

for (const malformed of [
  null,
  {},
  { schemaVersion: 2, thinkingLevel: "high", models: {} },
  { schemaVersion: 1, thinkingLevel: "invalid", models: {} },
  { schemaVersion: 1, thinkingLevel: "high", models: { primary: { provider: "unknown", model: "x" } } },
  { schemaVersion: 1, thinkingLevel: "high", models: {}, unexpected: true },
  { schemaVersion: 1, thinkingLevel: "high", models: {}, auditBudgets: { maxSemanticRepairPasses: 0 } },
  { schemaVersion: 1, thinkingLevel: "high", models: {}, auditBudgets: { maxModelCalls: 1_025 } },
  { schemaVersion: 1, thinkingLevel: "high", models: {}, auditBudgets: { maxTotalDurationMs: 1_000, maxSessionDurationMs: 2_000 } },
  { schemaVersion: 1, thinkingLevel: "high", models: {}, auditBudgets: { unknownBudget: 1 } },
  { thinkingLevel: "high", modelsByRole: {}, unexpected: true },
]) {
  withConfig(malformed, (configDir) => {
    assert.throws(() => loadAgentifyConfig(configDir));
  });
}

const emptyDir = tempDir("agentify-config-default-");
try {
  assert.deepEqual(loadAgentifyConfig(emptyDir), {
    schemaVersion: 1,
    thinkingLevel: "high",
    models: {},
  });
} finally {
  fs.rmSync(emptyDir, { recursive: true, force: true });
}

console.log("config schema tests passed");
