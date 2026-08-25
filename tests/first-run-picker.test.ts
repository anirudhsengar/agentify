import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureAgentifyConfig,
  loadAgentifyConfig,
  pickTierPreset,
} from "../src/core/agentify-config.ts";
import { AGENTIFY_PROVIDERS } from "../src/core/provider-auth.ts";
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

  async promptText(): Promise<string> {
    throw new Error("unexpected text prompt");
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

// A stored OAuth subscription credential counts as usable auth: after
// `agentify login` (ChatGPT/Claude subscription) and `agentify models`, a
// plain `agentify` run must not fall into provider setup or ask for an API
// key. Any prompt here makes TestUi throw. Provider environment variables
// are cleared so the ambient shell cannot outrank the stored credential.
const providerEnvNames = new Set(
  AGENTIFY_PROVIDERS.flatMap((definition) => definition.env),
);
const savedEnv = new Map<string, string | undefined>();
for (const name of providerEnvNames) {
  savedEnv.set(name, process.env[name]);
  delete process.env[name];
}
const oauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-oauth-first-run-"));
try {
  fs.writeFileSync(path.join(oauthDir, "auth.json"), `${JSON.stringify({
    "openai-codex": { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 },
  }, null, 2)}\n`);
  const ui = new TestUi([], []);
  const withProvider = await ensureAgentifyConfig(oauthDir, ui);
  assert.equal(withProvider.provider, "openai-codex");

  fs.rmSync(path.join(oauthDir, "config.json"), { force: true });
  const withoutProvider = await ensureAgentifyConfig(oauthDir, ui);
  assert.equal(withoutProvider.provider, "openai-codex");
  assert.deepEqual(loadAgentifyConfig(oauthDir), withoutProvider);
} finally {
  fs.rmSync(oauthDir, { recursive: true, force: true });
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log("first-run picker tests passed");
