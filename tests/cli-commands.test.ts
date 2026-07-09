import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import {
  authPath,
  configPath,
  defaultConfigDir,
  loadAgentifyConfig,
  saveAgentifyConfig,
} from "../src/core/agentify-config.ts";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  dispatchSubcommand,
  loginCommand,
  logoutCommand,
  modelsCommand,
  type SubcommandContext,
} from "../src/core/cli-commands.ts";
import type { AgentifyUi } from "../src/core/types.ts";

class CollectingWritable extends Writable {
  chunks: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    cb();
  }

  text(): string {
    return this.chunks.join("");
  }
}

class TestUi implements AgentifyUi {
  statuses: string[] = [];
  infos: string[] = [];
  errors: string[] = [];
  selectAnswers: string[] = [];
  secretAnswers: string[] = [];

  constructor(options: { selectAnswers?: string[]; secretAnswers?: string[] } = {}) {
    if (options.selectAnswers) this.selectAnswers = [...options.selectAnswers];
    if (options.secretAnswers) this.secretAnswers = [...options.secretAnswers];
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
    if (this.selectAnswers.length === 0) {
      throw new Error(`promptSelect called with no answer queued (choices=${choices.length})`);
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

/**
 * Run `fn` with HOME pointed at a fresh temp dir so `defaultConfigDir()`
 * resolves there. Cleans up after.
 */
async function withTempHome<T>(fn: (configDir: string) => Promise<T>): Promise<T> {
  const prevHome = process.env["HOME"];
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-cli-commands-home-"));
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

function makeCtx(ui: TestUi, opts: { stdinIsTTY?: boolean; cwd?: string; configDir: string }): {
  ctx: SubcommandContext;
  out: CollectingWritable;
  err: CollectingWritable;
} {
  const out = new CollectingWritable();
  const err = new CollectingWritable();
  const ctx: SubcommandContext = {
    cwd: opts.cwd ?? "/tmp",
    configDir: opts.configDir,
    ui,
    out,
    err,
    stdinIsTTY: opts.stdinIsTTY ?? false,
  };
  return { ctx, out, err };
}

function readAuth(configDir: string): Record<string, unknown> {
  const raw = fs.readFileSync(authPath(configDir), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

// ===========================================================================
// loginCommand
// ===========================================================================

async function loginPromptsForProviderAndKeyWhenNoFlags(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi({
      selectAnswers: ["openai"],
      secretAnswers: ["sk-test-1"],
    });
    const { ctx, out, err } = makeCtx(ui, { configDir });
    const code = await loginCommand([], ctx);
    assert.equal(code, 0);
    assert.equal(err.text(), "");
    const stored = readAuth(configDir);
    assert.deepEqual(stored, { openai: { type: "api_key", key: "sk-test-1" } });
    const config = loadAgentifyConfig(configDir);
    assert.equal(config.provider, "openai");
    assert.ok(out.text().includes("logged in openai"));
  });
}

async function loginWithProviderAndKeyFlagsSkipsPrompts(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi();
    const { ctx, out, err } = makeCtx(ui, { configDir });
    const code = await loginCommand(["--provider", "openai", "--key", "sk-flag"], ctx);
    assert.equal(code, 0);
    assert.equal(err.text(), "");
    const stored = readAuth(configDir);
    assert.deepEqual(stored, { openai: { type: "api_key", key: "sk-flag" } });
    assert.ok(out.text().includes("logged in openai"));
  });
}

async function loginForOAuthOnlyProviderPrintsInstructions(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi();
    const { ctx, out, err } = makeCtx(ui, { configDir });
    const code = await loginCommand(["--provider", "openai-codex"], ctx);
    assert.equal(code, 0);
    assert.equal(err.text(), "");
    assert.ok(!fs.existsSync(authPath(configDir)));
    assert.ok(out.text().includes("OpenAI Codex uses OAuth"));
    assert.ok(out.text().includes("pi auth login openai-codex"));
  });
}

async function loginWhenProviderHasEnvAuthWarnsAndSkips(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi();
    const { ctx, out, err } = makeCtx(ui, { configDir });
    const prev = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-env";
    try {
      const code = await loginCommand(["--provider", "openai"], ctx);
      assert.equal(code, 0);
      assert.equal(err.text(), "");
      assert.ok(!fs.existsSync(authPath(configDir)));
      assert.ok(out.text().includes("configured via environment"));
      assert.ok(out.text().includes("agentify logout --provider openai"));
    } finally {
      if (prev === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = prev;
    }
  });
}

async function loginRejectsUnknownProvider(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi();
    const { ctx, err } = makeCtx(ui, { configDir });
    const code = await loginCommand(["--provider", "not-a-provider"], ctx);
    assert.equal(code, 1);
    assert.ok(err.text().includes("unknown provider 'not-a-provider'"));
  });
}

async function loginAuthFileHas0600Permissions(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi();
    const { ctx } = makeCtx(ui, { configDir });
    await loginCommand(["--provider", "anthropic", "--key", "sk-test"], ctx);
    const mode = fs.statSync(authPath(configDir)).mode & 0o777;
    assert.equal(mode, 0o600, `auth.json mode should be 0o600 but is 0o${mode.toString(8)}`);
  });
}

// ===========================================================================
// logoutCommand
// ===========================================================================

async function logoutForProviderRemovesFromAuthAndClearsConfigProvider(): Promise<void> {
  await withTempHome(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    saveAgentifyConfig(configDir, {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "high",
    });
    AuthStorage.create(authPath(configDir)).set("openai", {
      type: "api_key",
      key: "sk-stored",
    });

    const ui = new TestUi();
    const { ctx, out } = makeCtx(ui, { configDir });
    const code = await logoutCommand(["--provider", "openai"], ctx);
    assert.equal(code, 0);
    assert.ok(out.text().includes("logged out openai"));

    const stored = readAuth(configDir);
    assert.deepEqual(stored, {}, "auth.json should be empty after logout");

    const config = loadAgentifyConfig(configDir);
    assert.equal(config.provider, undefined);
    assert.equal(config.model, undefined);
    assert.equal(config.thinkingLevel, "high", "thinkingLevel must be preserved");
  });
}

async function logoutAllWipesAuthAndConfigKeepsThinkingLevel(): Promise<void> {
  await withTempHome(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    saveAgentifyConfig(configDir, {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "high",
    });
    const auth = AuthStorage.create(authPath(configDir));
    auth.set("openai", { type: "api_key", key: "sk-a" });
    auth.set("anthropic", { type: "api_key", key: "sk-b" });

    const ui = new TestUi();
    const { ctx, out } = makeCtx(ui, { configDir, stdinIsTTY: true });
    const code = await logoutCommand(["--all", "--yes"], ctx);
    assert.equal(code, 0);
    assert.ok(out.text().includes("logged out all providers"));

    const stored = readAuth(configDir);
    assert.deepEqual(stored, {});
    const config = loadAgentifyConfig(configDir);
    assert.equal(config.provider, undefined);
    assert.equal(config.model, undefined);
    assert.equal(config.thinkingLevel, "high");
  });
}

async function logoutAllInNonTTYRefusesWithoutYes(): Promise<void> {
  await withTempHome(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    AuthStorage.create(authPath(configDir)).set("openai", { type: "api_key", key: "sk" });

    const ui = new TestUi();
    const { ctx, err } = makeCtx(ui, { configDir, stdinIsTTY: false });
    const code = await logoutCommand(["--all"], ctx);
    assert.equal(code, 1);
    assert.ok(err.text().includes("--all in a non-interactive shell requires --yes"));

    const stored = readAuth(configDir);
    assert.deepEqual(stored, { openai: { type: "api_key", key: "sk" } }, "must not wipe");
  });
}

async function logoutAllInTTYPromptsYesUnlessYes(): Promise<void> {
  await withTempHome(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const auth = AuthStorage.create(authPath(configDir));
    auth.set("openai", { type: "api_key", key: "sk" });
    auth.set("anthropic", { type: "api_key", key: "sk2" });

    // First sub-test: prompt "no" → keeps creds
    {
      const ui = new TestUi({ selectAnswers: ["no"] });
      const { ctx, out } = makeCtx(ui, { configDir, stdinIsTTY: true });
      const code = await logoutCommand(["--all"], ctx);
      assert.equal(code, 0);
      assert.ok(out.text().includes("cancelled"));
      const stored = readAuth(configDir);
      assert.equal(Object.keys(stored).length, 2, "creds must remain after cancel");
    }

    // Second sub-test: prompt "yes" → wipes
    {
      const ui = new TestUi({ selectAnswers: ["yes"] });
      const { ctx, out } = makeCtx(ui, { configDir, stdinIsTTY: true });
      const code = await logoutCommand(["--all"], ctx);
      assert.equal(code, 0);
      assert.ok(out.text().includes("logged out all providers"));
      const stored = readAuth(configDir);
      assert.deepEqual(stored, {});
    }
  });
}

async function logoutForUnknownProviderExits1(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi();
    const { ctx, err } = makeCtx(ui, { configDir });
    const code = await logoutCommand(["--provider", "fakeprovider"], ctx);
    assert.equal(code, 1);
    assert.ok(err.text().includes("unknown provider 'fakeprovider'"));
  });
}

// ===========================================================================
// modelsCommand
// ===========================================================================

async function modelsListPrintsAvailableForConfiguredProvider(): Promise<void> {
  await withTempHome(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    AuthStorage.create(authPath(configDir)).set("openai", {
      type: "api_key",
      key: "sk-test",
    });

    const ui = new TestUi();
    const { ctx, out, err } = makeCtx(ui, { configDir });
    const code = await modelsCommand(["list"], ctx);
    assert.equal(code, 0);
    assert.equal(err.text(), "");
    const text = out.text();
    assert.ok(text.includes("provider"), `expected header 'provider' in:\n${text}`);
    assert.ok(text.includes("openai"), `expected at least one openai row in:\n${text}`);
  });
}

async function modelsListWithProviderFlagFiltersResults(): Promise<void> {
  await withTempHome(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const auth = AuthStorage.create(authPath(configDir));
    auth.set("openai", { type: "api_key", key: "sk-test" });
    auth.set("anthropic", { type: "api_key", key: "sk-test-2" });

    const ui = new TestUi();
    const { ctx, out } = makeCtx(ui, { configDir });
    const code = await modelsCommand(["list", "--provider", "openai"], ctx);
    assert.equal(code, 0);
    const lines = out.text().split("\n").filter((l) => l.trim().length > 0);
    const dataLines = lines.slice(1); // skip header
    for (const line of dataLines) {
      assert.ok(
        line.startsWith("openai"),
        `expected only openai rows when filtered, got: ${line}`,
      );
    }
    assert.ok(dataLines.length > 0, "expected at least one openai row");
  });
}

async function modelsListEmptyAuthPrintsHint(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi();
    const { ctx, out } = makeCtx(ui, { configDir });
    const code = await modelsCommand(["list"], ctx);
    assert.equal(code, 0);
    assert.ok(out.text().includes("no auth configured"));
    assert.ok(out.text().includes("agentify login"));
  });
}

async function modelsShowPrintsCurrentConfigAndAvailableCount(): Promise<void> {
  await withTempHome(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    saveAgentifyConfig(configDir, {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "high",
    });
    AuthStorage.create(authPath(configDir)).set("openai", {
      type: "api_key",
      key: "sk-test",
    });

    const ui = new TestUi();
    const { ctx, out } = makeCtx(ui, { configDir });
    const code = await modelsCommand(["show"], ctx);
    assert.equal(code, 0);
    const text = out.text();
    assert.ok(text.includes("provider:    openai"));
    assert.ok(text.includes("model:       gpt-4o"));
    assert.ok(text.includes("thinking:    high"));
    assert.ok(/available models: \d+/.test(text));
  });
}

async function modelsSetParsesProviderModelSlashFormat(): Promise<void> {
  await withTempHome(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    AuthStorage.create(authPath(configDir)).set("openai", {
      type: "api_key",
      key: "sk-test",
    });

    const ui = new TestUi();
    const { ctx, out, err } = makeCtx(ui, { configDir });
    // Try multiple known openai ids; first one that exists wins.
    const candidates = ["gpt-4o", "gpt-4-turbo", "gpt-4", "o3"];
    let code = 1;
    let set = false;
    for (const id of candidates) {
      code = await modelsCommand(["set", `openai/${id}`], ctx);
      if (code === 0) {
        set = true;
        assert.ok(out.text().includes(`set model to openai/${id}`));
        break;
      }
      // Reset out between attempts.
      out.chunks.length = 0;
      err.chunks.length = 0;
    }
    assert.ok(set, `expected at least one openai model id to succeed; got errors:\n${err.text()}`);
    const config = loadAgentifyConfig(configDir);
    assert.equal(config.provider, "openai");
    assert.ok(typeof config.model === "string" && config.model.length > 0);
  });
}

async function modelsSetRejectsUnknownModel(): Promise<void> {
  await withTempHome(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    AuthStorage.create(authPath(configDir)).set("openai", {
      type: "api_key",
      key: "sk-test",
    });

    const ui = new TestUi();
    const { ctx, err } = makeCtx(ui, { configDir });
    const code = await modelsCommand(["set", "openai/totally-fake-model-xyz"], ctx);
    assert.equal(code, 1);
    assert.ok(err.text().includes("not found for provider 'openai'"));
    assert.ok(err.text().includes("models list --provider openai"));
  });
}

async function modelsSetRejectsNoAuthForProvider(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi();
    const { ctx, err } = makeCtx(ui, { configDir });
    const code = await modelsCommand(["set", "openai/gpt-4o"], ctx);
    assert.equal(code, 1);
    assert.ok(
      err.text().includes("known to OpenAI") || err.text().includes("not found"),
      `unexpected error message: ${err.text()}`,
    );
  });
}

async function modelsSetRejectsMalformedFormat(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi();

    const r1 = makeCtx(ui, { configDir });
    const code1 = await modelsCommand(["set", "openai"], r1.ctx);
    assert.equal(code1, 1);
    assert.ok(r1.err.text().includes("must be in <provider>/<model> form"));

    const r2 = makeCtx(ui, { configDir });
    const code2 = await modelsCommand(["set", "a/b/c"], r2.ctx);
    assert.equal(code2, 1);
    assert.ok(r2.err.text().includes("must contain exactly one '/'"));
  });
}

async function modelsUnsetClearsProviderModelPreservesThinking(): Promise<void> {
  await withTempHome(async (configDir) => {
    saveAgentifyConfig(configDir, {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "xhigh",
    });

    const ui = new TestUi();
    const { ctx, out } = makeCtx(ui, { configDir });
    const code = await modelsCommand(["unset"], ctx);
    assert.equal(code, 0);
    assert.ok(out.text().includes("cleared provider and model"));

    const config = loadAgentifyConfig(configDir);
    assert.equal(config.provider, undefined);
    assert.equal(config.model, undefined);
    assert.equal(config.thinkingLevel, "xhigh");
  });
}

async function dispatchReturnsTrueForKnownSubcommand(): Promise<void> {
  await withTempHome(async (configDir) => {
    const ui = new TestUi();
    const { ctx } = makeCtx(ui, { configDir });
    const handled = await dispatchSubcommand(["models", "show"], ctx);
    assert.equal(handled, true);
  });
}

// ===========================================================================
// Test runner
// ===========================================================================

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "loginPromptsForProviderAndKeyWhenNoFlags", fn: loginPromptsForProviderAndKeyWhenNoFlags },
  { name: "loginWithProviderAndKeyFlagsSkipsPrompts", fn: loginWithProviderAndKeyFlagsSkipsPrompts },
  { name: "loginForOAuthOnlyProviderPrintsInstructions", fn: loginForOAuthOnlyProviderPrintsInstructions },
  { name: "loginWhenProviderHasEnvAuthWarnsAndSkips", fn: loginWhenProviderHasEnvAuthWarnsAndSkips },
  { name: "loginRejectsUnknownProvider", fn: loginRejectsUnknownProvider },
  { name: "loginAuthFileHas0600Permissions", fn: loginAuthFileHas0600Permissions },
  { name: "logoutForProviderRemovesFromAuthAndClearsConfigProvider", fn: logoutForProviderRemovesFromAuthAndClearsConfigProvider },
  { name: "logoutAllWipesAuthAndConfigKeepsThinkingLevel", fn: logoutAllWipesAuthAndConfigKeepsThinkingLevel },
  { name: "logoutAllInNonTTYRefusesWithoutYes", fn: logoutAllInNonTTYRefusesWithoutYes },
  { name: "logoutAllInTTYPromptsYesUnlessYes", fn: logoutAllInTTYPromptsYesUnlessYes },
  { name: "logoutForUnknownProviderExits1", fn: logoutForUnknownProviderExits1 },
  { name: "modelsListPrintsAvailableForConfiguredProvider", fn: modelsListPrintsAvailableForConfiguredProvider },
  { name: "modelsListWithProviderFlagFiltersResults", fn: modelsListWithProviderFlagFiltersResults },
  { name: "modelsListEmptyAuthPrintsHint", fn: modelsListEmptyAuthPrintsHint },
  { name: "modelsShowPrintsCurrentConfigAndAvailableCount", fn: modelsShowPrintsCurrentConfigAndAvailableCount },
  { name: "modelsSetParsesProviderModelSlashFormat", fn: modelsSetParsesProviderModelSlashFormat },
  { name: "modelsSetRejectsUnknownModel", fn: modelsSetRejectsUnknownModel },
  { name: "modelsSetRejectsNoAuthForProvider", fn: modelsSetRejectsNoAuthForProvider },
  { name: "modelsSetRejectsMalformedFormat", fn: modelsSetRejectsMalformedFormat },
  { name: "modelsUnsetClearsProviderModelPreservesThinking", fn: modelsUnsetClearsProviderModelPreservesThinking },
  { name: "dispatchReturnsTrueForKnownSubcommand", fn: dispatchReturnsTrueForKnownSubcommand },
];

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
  }
}
if (failed > 0) {
  console.error(`cli-commands tests FAILED (${passed} passed, ${failed} failed).`);
  process.exit(1);
}
console.log(`cli-commands tests passed (${passed}/${tests.length}).`);