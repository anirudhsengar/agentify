import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  defaultConfigDir,
  ensureAgentifyConfig,
  loadAgentifyConfig,
} from "../src/core/agentify-config.ts";
import type { AgentifyUi } from "../src/core/types.ts";

class TestUi implements AgentifyUi {
  statuses: string[] = [];
  infos: string[] = [];
  errors: string[] = [];
  selectAnswers: string[] = [];
  secretAnswers: string[] = [];
  selectCalls = 0;

  constructor(options: { selectAnswers?: string[]; secretAnswers?: string[] } = {}) {
    this.selectAnswers = options.selectAnswers ? [...options.selectAnswers] : [];
    this.secretAnswers = options.secretAnswers ? [...options.secretAnswers] : [];
  }

  status(message: string): void {
    this.statuses.push(message);
  }

  info(message: string): void {
    this.infos.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  async promptSelect(_message: string, choices: ReadonlyArray<{ label: string; value: string }>): Promise<string> {
    this.selectCalls += 1;
    if (this.selectAnswers.length === 0) {
      throw new Error(`promptSelect called with no answer queued (call #${this.selectCalls}, choices=${choices.length})`);
    }
    return this.selectAnswers.shift() as string;
  }

  async promptSecret(_message: string): Promise<string> {
    if (this.secretAnswers.length === 0) {
      throw new Error("promptSecret called with no answer queued");
    }
    return this.secretAnswers.shift() as string;
  }
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withTempHome<T>(fn: (configDir: string) => Promise<T>): Promise<T> {
  const prevHome = process.env["HOME"];
  const tempHome = tempDir("agentify-first-run-home-");
  process.env["HOME"] = tempHome;
  const configDir = defaultConfigDir();
  try {
    return await fn(configDir);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

/** Wipe auth.json and config.json so the picker fires on next call. */
function wipeAgentifyState(configDir: string): void {
  try { fs.unlinkSync(path.join(configDir, "auth.json")); } catch {}
  try { fs.unlinkSync(path.join(configDir, "config.json")); } catch {}
}

/** Seed auth.json with openai key — used for tests that bypass the picker. */
function seedAuth(configDir: string): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  AuthStorage.create(path.join(configDir, "auth.json")).set("openai", {
    type: "api_key",
    key: "sk-test",
  });
}

async function ensureAgentifyConfigPromptsForModelStrategyOnFirstRun(): Promise<void> {
  await withTempHome(async (configDir) => {
    // No auth, no config → picker fires after provider + secret capture.
    wipeAgentifyState(configDir);
    const ui = new TestUi({
      // 1. provider, 2. strategy = split, 3. primary model, 4. explorer?, 5. scoring?
      selectAnswers: ["openai", "split", "openai/gpt-4o", "skip", "skip"],
      secretAnswers: ["sk-test"],
    });
    await ensureAgentifyConfig(configDir, ui);
    // 5 select prompts fired (provider + strategy + primary + explorer + scoring).
    assert.equal(ui.selectCalls, 5, `expected 5 prompts, got ${ui.selectCalls}`);
    const config = loadAgentifyConfig(configDir);
    assert.equal(config.provider, "openai");
    assert.deepEqual(config.modelsByRole?.primary, { provider: "openai", model: "gpt-4o" });
    assert.equal(config.modelsByRole?.explorer, undefined);
    assert.equal(config.modelsByRole?.scoring, undefined);
  });
}

async function ensureAgentifyConfigSingleStrategySetsOnlyPrimary(): Promise<void> {
  await withTempHome(async (configDir) => {
    wipeAgentifyState(configDir);
    const ui = new TestUi({
      // 1. provider, 2. strategy = single, 3. primary model
      selectAnswers: ["openai", "single", "openai/gpt-4o"],
      secretAnswers: ["sk-test"],
    });
    await ensureAgentifyConfig(configDir, ui);
    const config = loadAgentifyConfig(configDir);
    assert.equal(config.provider, "openai");
    assert.deepEqual(config.modelsByRole?.primary, { provider: "openai", model: "gpt-4o" });
    assert.equal(config.modelsByRole?.explorer, undefined);
    assert.equal(config.modelsByRole?.scoring, undefined);
    assert.equal(ui.selectCalls, 3, "single strategy: provider + strategy + primary = 3 prompts");
  });
}

async function ensureAgentifyConfigSplitStrategyPromptsForEachSlotIndependently(): Promise<void> {
  await withTempHome(async (configDir) => {
    wipeAgentifyState(configDir);
    const ui = new TestUi({
      // 1. provider, 2. strategy = split, 3. primary, 4. explorer skip, 5. scoring pick, 6. scoring model
      selectAnswers: ["openai", "split", "openai/gpt-4o-mini", "skip", "pick", "openai/gpt-4o-mini"],
      secretAnswers: ["sk-test"],
    });
    await ensureAgentifyConfig(configDir, ui);
    const config = loadAgentifyConfig(configDir);
    assert.deepEqual(config.modelsByRole?.primary, { provider: "openai", model: "gpt-4o-mini" });
    assert.equal(config.modelsByRole?.explorer, undefined);
    assert.deepEqual(config.modelsByRole?.scoring, { provider: "openai", model: "gpt-4o-mini" });
  });
}

async function ensureAgentifyConfigDoesNotRepromptWhenModelsByRoleExists(): Promise<void> {
  await withTempHome(async (configDir) => {
    seedAuth(configDir);
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        provider: "openai",
        thinkingLevel: "high",
        modelsByRole: { primary: { provider: "openai", model: "gpt-4o" } },
      }),
    );
    const ui = new TestUi();
    const config = await ensureAgentifyConfig(configDir, ui);
    assert.equal(config.provider, "openai");
    assert.deepEqual(config.modelsByRole?.primary, { provider: "openai", model: "gpt-4o" });
    assert.equal(ui.selectCalls, 0, "no prompts should fire when modelsByRole exists");
  });
}

async function ensureAgentifyConfigHandlesEmptyAvailableListGracefully(): Promise<void> {
  await withTempHome(async (configDir) => {
    wipeAgentifyState(configDir);
    // The picker must not crash even if the user accidentally picks a
    // model id that the registry doesn't list. We queue a fake model id;
    // the parser accepts it (no registry check at write time), and the
    // resolver will surface a clean error if it's invoked later.
    const ui = new TestUi({
      // provider, strategy = single, primary = fake-but-accepted-id
      selectAnswers: ["openai", "single", "openai/anything-user-types"],
      secretAnswers: ["sk-test"],
    });
    const config = await ensureAgentifyConfig(configDir, ui);
    assert.equal(config.provider, "openai");
    assert.ok(config.modelsByRole?.primary, "primary must be set even with unverified id");
  });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "ensureAgentifyConfigPromptsForModelStrategyOnFirstRun", fn: ensureAgentifyConfigPromptsForModelStrategyOnFirstRun },
  { name: "ensureAgentifyConfigSingleStrategySetsOnlyPrimary", fn: ensureAgentifyConfigSingleStrategySetsOnlyPrimary },
  { name: "ensureAgentifyConfigSplitStrategyPromptsForEachSlotIndependently", fn: ensureAgentifyConfigSplitStrategyPromptsForEachSlotIndependently },
  { name: "ensureAgentifyConfigDoesNotRepromptWhenModelsByRoleExists", fn: ensureAgentifyConfigDoesNotRepromptWhenModelsByRoleExists },
  { name: "ensureAgentifyConfigHandlesEmptyAvailableListGracefully", fn: ensureAgentifyConfigHandlesEmptyAvailableListGracefully },
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
console.log(`first-run-picker tests passed (${passed}/${tests.length}).`);