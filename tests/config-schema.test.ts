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

async function loaderRoundTripsModelsByRole(): Promise<void> {
  const configDir = tempDir("config-schema-roundtrip-");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // Write a config.json with a modelsByRole block via raw write.
    fs.writeFileSync(
      configPath(configDir),
      JSON.stringify(
        {
          provider: "openai",
          model: "gpt-4o",
          thinkingLevel: "high",
          modelsByRole: {
            primary: { provider: "openai", model: "gpt-4o" },
            explorer: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
          },
        },
        null,
        2,
      ),
    );
    const loaded = loadAgentifyConfig(configDir);
    assert.deepEqual(loaded.modelsByRole?.primary, { provider: "openai", model: "gpt-4o" });
    assert.deepEqual(loaded.modelsByRole?.explorer, {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
    assert.equal(loaded.modelsByRole?.lite, undefined);
    // Re-save and re-load: equality holds.
    saveAgentifyConfig(configDir, loaded);
    const reloaded = loadAgentifyConfig(configDir);
    assert.deepEqual(reloaded, loaded);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function loaderRejectsMalformedModelsByRole(): Promise<void> {
  const configDir = tempDir("config-schema-malformed-");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // Mix of valid and invalid slots: valid primary, invalid explorer
    // (unknown provider, empty model), and a valid-but-unset scoring.
    fs.writeFileSync(
      configPath(configDir),
      JSON.stringify({
        modelsByRole: {
          primary: { provider: "openai", model: "gpt-4o" },
          explorer: { provider: "not-a-real-provider", model: "x" },
          scoring: { provider: "anthropic", model: "" }, // empty model → drop
        },
      }),
    );
    const loaded = loadAgentifyConfig(configDir);
    assert.deepEqual(loaded.modelsByRole?.primary, { provider: "openai", model: "gpt-4o" });
    assert.equal(loaded.modelsByRole?.explorer, undefined);
    assert.equal(loaded.modelsByRole?.scoring, undefined);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function loaderDropsTopLevelModelsByRoleThatIsNotAnObject(): Promise<void> {
  const configDir = tempDir("config-schema-nonobject-");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      configPath(configDir),
      JSON.stringify({ modelsByRole: "not-an-object" }),
    );
    const loaded = loadAgentifyConfig(configDir);
    assert.equal(loaded.modelsByRole, undefined);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "loaderRoundTripsModelsByRole", fn: loaderRoundTripsModelsByRole },
  { name: "loaderRejectsMalformedModelsByRole", fn: loaderRejectsMalformedModelsByRole },
  { name: "loaderDropsTopLevelModelsByRoleThatIsNotAnObject", fn: loaderDropsTopLevelModelsByRoleThatIsNotAnObject },
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
console.log(`config-schema tests passed (${passed}/${tests.length}).`);