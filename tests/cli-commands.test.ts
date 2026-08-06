import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import {
  authPath,
  loadAgentifyConfig,
  saveAgentifyConfig,
} from "../src/core/agentify-config.ts";
import {
  dispatchSubcommand,
  loginCommand,
  logoutCommand,
  modelsCommand,
  type SubcommandContext,
} from "../src/core/cli-commands.ts";
import type { AgentifyUi } from "../src/core/types.ts";
import { AgentifyCredentialStore } from "../src/core/pi-credential-store.ts";

class CollectingWritable extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

class TestUi implements AgentifyUi {
  constructor(
    private readonly selectAnswers: string[] = [],
    private readonly secretAnswers: string[] = [],
  ) {}

  status(): void {}
  info(): void {}
  error(): void {}

  async promptSelect(): Promise<string> {
    const answer = this.selectAnswers.shift();
    if (answer === undefined) throw new Error("unexpected select prompt");
    return answer;
  }

  async promptSecret(): Promise<string> {
    const answer = this.secretAnswers.shift();
    if (answer === undefined) throw new Error("unexpected secret prompt");
    return answer;
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-cli-commands-"));
}

function context(
  configDir: string,
  ui: AgentifyUi,
  stdinIsTTY = true,
): { ctx: SubcommandContext; out: CollectingWritable; err: CollectingWritable } {
  const out = new CollectingWritable();
  const err = new CollectingWritable();
  return {
    ctx: { cwd: configDir, configDir, ui, out, err, stdinIsTTY },
    out,
    err,
  };
}

function baseConfig() {
  return { schemaVersion: 1 as const, provider: "openai" as const, thinkingLevel: "high" as const, models: {} };
}

async function withConfig(test: (configDir: string) => Promise<void>): Promise<void> {
  const configDir = tempDir();
  try {
    await test(configDir);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "interactive login stores a masked-prompt credential",
    run: () => withConfig(async (configDir) => {
      const { ctx } = context(configDir, new TestUi([], ["sk-test"]));
      assert.equal(await loginCommand(["--provider", "openai"], ctx), 0);
      assert.equal(await new AgentifyCredentialStore(authPath(configDir)).has("openai"), true);
      assert.equal(loadAgentifyConfig(configDir).provider, "openai");
    }),
  },
  {
    name: "login rejects credential command-line arguments",
    run: () => withConfig(async (configDir) => {
      const { ctx, err } = context(configDir, new TestUi());
      assert.equal(await loginCommand(["--provider", "openai", "--key", "secret"], ctx), 1);
      assert.match(err.text(), /unknown flag --key/);
      assert.equal(await new AgentifyCredentialStore(authPath(configDir)).has("openai"), false);
    }),
  },
  {
    name: "non-interactive login requires an environment credential",
    run: () => withConfig(async (configDir) => {
      const { ctx, err } = context(configDir, new TestUi(), false);
      assert.equal(await loginCommand(["--provider", "openai"], ctx), 1);
      assert.match(err.text(), /set OPENAI_API_KEY/);
    }),
  },
  {
    name: "OAuth providers print setup instructions",
    run: () => withConfig(async (configDir) => {
      const { ctx, out } = context(configDir, new TestUi());
      assert.equal(await loginCommand(["--provider", "openai-codex"], ctx), 0);
      assert.match(out.text(), /pi auth login openai-codex/);
    }),
  },
  {
    name: "provider logout clears matching role assignments",
    run: () => withConfig(async (configDir) => {
      const auth = new AgentifyCredentialStore(authPath(configDir));
      await auth.set("openai", { type: "api_key", key: "sk-test" });
      saveAgentifyConfig(configDir, {
        ...baseConfig(),
        models: {
          primary: { provider: "openai", model: "gpt-4o" },
          explorer: { provider: "anthropic", model: "claude-sonnet" },
        },
      });
      const { ctx } = context(configDir, new TestUi());
      assert.equal(await logoutCommand(["--provider", "openai"], ctx), 0);
      const config = loadAgentifyConfig(configDir);
      assert.equal(config.provider, undefined);
      assert.equal(config.models.primary, undefined);
      assert.ok(config.models.explorer);
    }),
  },
  {
    name: "models set and unset update the current role schema",
    run: () => withConfig(async (configDir) => {
      await new AgentifyCredentialStore(authPath(configDir)).set("openai", { type: "api_key", key: "sk-test" });
      saveAgentifyConfig(configDir, baseConfig());
      const { ctx } = context(configDir, new TestUi());
      assert.equal(await modelsCommand(["set", "primary", "openai/gpt-4o"], ctx), 0);
      assert.deepEqual(loadAgentifyConfig(configDir).models.primary, {
        provider: "openai",
        model: "gpt-4o",
      });
      assert.equal(await modelsCommand(["set", "explorer", "openai/gpt-4o-mini"], ctx), 0);
      assert.equal(loadAgentifyConfig(configDir).models.explorer?.model, "gpt-4o-mini");
      assert.equal(await modelsCommand(["unset", "explorer"], ctx), 0);
      assert.equal(loadAgentifyConfig(configDir).models.explorer, undefined);
    }),
  },
  {
    name: "secondary roles require a primary assignment",
    run: () => withConfig(async (configDir) => {
      await new AgentifyCredentialStore(authPath(configDir)).set("openai", { type: "api_key", key: "sk-test" });
      saveAgentifyConfig(configDir, baseConfig());
      const { ctx, err } = context(configDir, new TestUi());
      assert.equal(await modelsCommand(["set", "explorer", "openai/gpt-4o-mini"], ctx), 1);
      assert.match(err.text(), /requires a primary model/);
    }),
  },
  {
    name: "models show reports resolved inheritance",
    run: () => withConfig(async (configDir) => {
      await new AgentifyCredentialStore(authPath(configDir)).set("openai", { type: "api_key", key: "sk-test" });
      saveAgentifyConfig(configDir, {
        ...baseConfig(),
        models: { primary: { provider: "openai", model: "gpt-4o" } },
      });
      const { ctx, out } = context(configDir, new TestUi());
      assert.equal(await modelsCommand(["show", "--resolved"], ctx), 0);
      assert.match(out.text(), /inherits primary/);
    }),
  },
  {
    name: "dispatcher exposes only current commands",
    run: () => withConfig(async (configDir) => {
      const { ctx, out } = context(configDir, new TestUi());
      assert.equal(await dispatchSubcommand(["models", "--help"], ctx), true);
      assert.match(out.text(), /Usage:/);
      assert.equal(await dispatchSubcommand(["revert"], ctx), false);
    }),
  },
];

for (const test of tests) {
  await test.run();
  console.log(`  ok ${test.name}`);
}
console.log(`cli command tests passed (${tests.length}/${tests.length})`);
