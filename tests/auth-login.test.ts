import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import {
  buildLoginOptions,
  createAuthInteraction,
  loginOptionLabel,
} from "../src/core/auth-login.ts";
import { AGENTIFY_PROVIDERS } from "../src/core/provider-auth.ts";
import { createAgentifyModelRuntime } from "../src/core/pi-credential-store.ts";
import type { AgentifyUi } from "../src/core/types.ts";

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

class RecordingUi implements AgentifyUi {
  readonly selects: string[] = [];
  readonly secrets: string[] = [];

  status(): void {}
  info(): void {}
  error(): void {}

  async promptSelect(message: string): Promise<string> {
    this.selects.push(message);
    return "chosen";
  }

  async promptSecret(message: string): Promise<string> {
    this.secrets.push(message);
    return "sk-secret";
  }

  async promptText(): Promise<string> {
    throw new Error("text prompts go through askText");
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-auth-login-"));
}

async function withRegistry(
  test: (providers: Awaited<ReturnType<typeof loadProviders>>) => void | Promise<void>,
): Promise<void> {
  const dir = tempDir();
  try {
    const providers = await loadProviders(dir);
    await test(providers);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function loadProviders(dir: string) {
  const { modelRuntime } = await createAgentifyModelRuntime({
    authFile: path.join(dir, "auth.json"),
    modelsFile: path.join(dir, "models.json"),
  });
  return modelRuntime.getProviders();
}

const tests: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "the static provider allowlist matches the Pi registry exactly",
    run: () => withRegistry(async (providers) => {
      const registryIds = providers.map((provider) => provider.id).sort();
      const allowlistIds = AGENTIFY_PROVIDERS.map((entry) => entry.value).sort();
      assert.deepEqual(allowlistIds, registryIds);
    }),
  },
  {
    name: "login options mirror Pi: subscriptions first, openai-codex OAuth-only",
    run: () => withRegistry(async (providers) => {
      const { subscriptions, apiKeys } = buildLoginOptions(providers);

      const anthropicOauth = subscriptions.find((option) => option.providerId === "anthropic");
      assert.ok(anthropicOauth);
      assert.equal(anthropicOauth.isSubscription, true);
      assert.match(anthropicOauth.methodName, /Claude Pro\/Max/);

      const codexOauth = subscriptions.find((option) => option.providerId === "openai-codex");
      assert.ok(codexOauth);
      assert.equal(codexOauth.isSubscription, true);
      assert.equal(
        apiKeys.some((option) => option.providerId === "openai-codex"),
        false,
        "openai-codex must remain OAuth-only",
      );

      const openaiKey = apiKeys.find((option) => option.providerId === "openai");
      assert.ok(openaiKey);
      assert.equal(openaiKey.ambientOnly, false);

      // Every OAuth provider also keeps its API-key entry when Pi defines
      // one, so `--provider anthropic` can offer both methods.
      const anthropicKey = apiKeys.find((option) => option.providerId === "anthropic");
      assert.ok(anthropicKey);

      const subscriptionOrder = subscriptions.map((option) => option.methodName);
      assert.deepEqual(subscriptionOrder, [...subscriptionOrder].sort((a, b) => a.localeCompare(b)));
    }),
  },
  {
    name: "loginOptionLabel prefers Pi's loginLabel for OAuth entries",
    run: () => withRegistry(async (providers) => {
      const { subscriptions, apiKeys } = buildLoginOptions(providers);
      const labelled = subscriptions.find((option) => option.loginLabel !== undefined);
      if (labelled) assert.equal(loginOptionLabel(labelled), labelled.loginLabel);
      const unlabelled = subscriptions.find((option) => option.loginLabel === undefined);
      if (unlabelled) assert.equal(loginOptionLabel(unlabelled), unlabelled.methodName);
      const openaiKey = apiKeys.find((option) => option.providerId === "openai");
      assert.ok(openaiKey);
      assert.equal(loginOptionLabel(openaiKey), openaiKey.providerName);
    }),
  },
  {
    name: "auth interaction routes secret and select prompts to the UI",
    run: async () => {
      const ui = new RecordingUi();
      const out = new CollectingWritable();
      const interaction = createAuthInteraction({ ui, out, askText: async () => "unused" });

      const secret = await interaction.prompt({ type: "secret", message: "Enter OpenAI API key" });
      assert.equal(secret, "sk-secret");
      assert.deepEqual(ui.secrets, ["Enter OpenAI API key"]);

      const selected = await interaction.prompt({
        type: "select",
        message: "Pick a region",
        options: [{ id: "us", label: "US", description: "United States" }],
      });
      assert.equal(selected, "chosen");
      assert.deepEqual(ui.selects, ["Pick a region"]);
    },
  },
  {
    name: "manual code prompts use the abortable text channel",
    run: async () => {
      const ui = new RecordingUi();
      const out = new CollectingWritable();
      const seen: AuthPrompt[] = [];
      const interaction = createAuthInteraction({
        ui,
        out,
        askText: async (prompt) => {
          seen.push(prompt);
          return "paste-code";
        },
      });
      const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
      assert.equal(code, "paste-code");
      assert.equal(seen.length, 1);
      assert.equal(ui.secrets.length, 0);
    },
  },
  {
    name: "auth_url events print the URL and open the browser hook",
    run: async () => {
      const ui = new RecordingUi();
      const out = new CollectingWritable();
      const opened: string[] = [];
      const interaction = createAuthInteraction({
        ui,
        out,
        askText: async () => "unused",
        openUrl: (url) => opened.push(url),
      });
      interaction.notify({ type: "auth_url", url: "https://example.com/oauth", instructions: "Approve access" });
      assert.match(out.text(), /https:\/\/example\.com\/oauth/);
      assert.match(out.text(), /Approve access/);
      assert.deepEqual(opened, ["https://example.com/oauth"]);

      interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device" });
      assert.match(out.text(), /ABCD-1234/);
      assert.match(out.text(), /https:\/\/example\.com\/device/);
    },
  },
];

for (const test of tests) {
  await test.run();
  console.log(`  ok ${test.name}`);
}
console.log(`auth login tests passed (${tests.length}/${tests.length})`);
