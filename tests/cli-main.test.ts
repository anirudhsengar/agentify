import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { authPath, defaultConfigDir, saveAgentifyConfig } from "../src/core/agentify-config.ts";
import { writeProjectState } from "../src/core/project-state.ts";
import { runAgentifyApp } from "../src/core/agentify-app.ts";
import { AGENTIFY_MANAGED_MARKERS } from "../src/core/artifact-exporters.ts";
import { manifestFileFromContent, writeManifest } from "../src/core/manifest.ts";
import { makeValidCodebaseMap } from "./fixtures/codebase-map.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
  AgentifyUi,
  GitHubReadiness,
} from "../src/core/types.ts";

class TestUi implements AgentifyUi {
  statuses: string[] = [];
  infos: string[] = [];
  errors: string[] = [];

  status(message: string): void {
    this.statuses.push(message);
  }

  info(message: string): void {
    this.infos.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  async promptSelect(): Promise<string> {
    throw new Error("promptSelect should not be called in this test");
  }

  async promptSecret(): Promise<string> {
    throw new Error("promptSecret should not be called in this test");
  }
}

class BrownfieldFakeRuntime implements AgentRuntime {
  sessionCalls = 0;

  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    this.sessionCalls += 1;
    fs.mkdirSync(path.join(options.cwd, "specs"), { recursive: true });
    fs.mkdirSync(path.join(options.cwd, "ai_docs"), { recursive: true });
    fs.mkdirSync(path.join(options.cwd, ".pi", "agents"), { recursive: true });
    fs.mkdirSync(path.join(options.cwd, ".pi", "agentify"), { recursive: true });
    fs.writeFileSync(
      path.join(options.cwd, ".pi", "agentify", "codebase_map.json"),
      JSON.stringify(makeValidCodebaseMap(), null, 2),
    );
    fs.writeFileSync(path.join(options.cwd, "AGENTS.md"), "# Agentified\n");
    fs.writeFileSync(path.join(options.cwd, "specs", "README.md"), "# Specs\n");
    fs.writeFileSync(path.join(options.cwd, "ai_docs", "README.md"), "# AI Docs\n");
    fs.writeFileSync(
      path.join(options.cwd, ".pi", "agents", "payments.md"),
      "---\nname: payments\ndescription: Payments specialist\n---\n\nUse payment domain knowledge.\n",
    );
    return { turns: 1, costUsd: null, aborted: false };
  }

  async runGreenfield(): Promise<AgentRuntimeResult> {
    throw new Error("greenfield mode should not run in this test");
  }
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hashCwd(cwd: string): string {
  return crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 6);
}

function seedReadyRepo(cwd: string, configDir: string): void {
  const files = [
    "AGENTS.md",
    "specs/README.md",
    "ai_docs/README.md",
    ".pi/agentify/codebase_map.json",
    "SETUP.md",
    ".github/workflows/agent-implement.yml",
    ".github/actions/run-pi/action.yml",
    ".github/scripts/setup-agentify.sh",
    ".pi/agents/payments.md",
    ".pi/workflows/payments-plan-build-review-fix.json",
    ".pi/prompts/experts/payments/expertise.yaml",
    ".pi/skills/billing/SKILL.md",
  ].map((relativePath) => {
    const filePath = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const marker = relativePath.endsWith(".json")
      ? ""
      : relativePath.endsWith(".md")
        ? `${AGENTIFY_MANAGED_MARKERS.markdown}\n`
        : `${AGENTIFY_MANAGED_MARKERS.toml}\n`;
    const content = `${marker}x\n`;
    fs.writeFileSync(filePath, content);
    return manifestFileFromContent({ relativePath, content, source: "test" });
  });
  writeManifest(cwd, {
    schema_version: "1",
    agentify_version: "test",
    generated_at: "2026-07-05T00:00:00.000Z",
    mode: "brownfield",
    files,
  });
  const logDir = path.join(configDir, "logs", "agentify");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `2026-07-05T00-00-00-000Z-${hashCwd(cwd)}-00.jsonl`);
  fs.writeFileSync(logPath, "{}\n");
  writeProjectState(configDir, {
    cwd,
    lastRunAt: "2026-07-05T00:00:00Z",
    projectKind: "brownfield",
    runStatus: "success",
    repoMode: "brownfield",
    repoStatus: "ready",
    featureAgentCount: 1,
    latestLogPath: logPath,
    github: {
      hasGitDirectory: true,
      hasGitHubRemote: true,
      ghCliAvailable: true,
      originUrl: "git@github.com:owner/repo.git",
    },
  });
}

const READY_GITHUB: GitHubReadiness = {
  hasGitDirectory: true,
  hasGitHubRemote: true,
  originUrl: "git@github.com:owner/repo.git",
  ghCliAvailable: true,
  guidance: [
    "GitHub bootstrap looks ready. Review SETUP.md, run `bash .github/scripts/setup-agentify.sh`, then use GitHub issues/comments as the async inbox.",
  ],
};

/**
 * Run `fn` with HOME pointed at a fresh temp dir so `defaultConfigDir()`
 * (the only remaining way to find the agentify state dir) resolves
 * there. Returns the temp configDir the function observed.
 */
async function withTempHome<T>(fn: (configDir: string) => Promise<T>): Promise<T> {
  const prevHome = process.env["HOME"];
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-cli-main-home-"));
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

async function testRejectsLegacySubcommands(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-cli-main-subcommands-");
    try {
      await assert.rejects(
        () => runAgentifyApp({
          args: ["webhook", "status"],
          cwd,
          ui: new TestUi(),
          runtime: new BrownfieldFakeRuntime(),
        }),
        /does not accept 'webhook'/,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testRunsThroughSingleEntrypoint(): Promise<void> {
  await withTempHome(async (configDir) => {
    const cwd = tempDir("agentify-cli-main-run-");
    try {
      fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
      saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
      fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));

      const ui = new TestUi();
      const runtime = new BrownfieldFakeRuntime();
      await runAgentifyApp({
        args: [],
        cwd,
        ui,
        runtime,
        mode: "brownfield",
        githubReadinessOverride: READY_GITHUB,
      });

      assert.equal(runtime.sessionCalls, 1);
      assert.ok(fs.existsSync(path.join(cwd, "AGENTS.md")));
      assert.ok(fs.existsSync(path.join(cwd, ".codex", "agents", "payments.toml")));
      assert.ok(fs.existsSync(path.join(cwd, ".claude", "agents", "payments.md")));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testAttachesToInitializedRepoWithoutRerun(): Promise<void> {
  await withTempHome(async (configDir) => {
    const cwd = tempDir("agentify-cli-main-attach-");
    try {
      seedReadyRepo(cwd, configDir);
      const ui = new TestUi();
      const runtime = new BrownfieldFakeRuntime();

      await runAgentifyApp({
        args: [],
        cwd,
        ui,
        runtime,
        githubReadinessOverride: READY_GITHUB,
      });

      assert.equal(runtime.sessionCalls, 0);
      assert.ok(ui.statuses.some((message) => message.includes("attached to initialized brownfield repo")));
      assert.ok(ui.infos.some((message) => message.includes("feature_agents=1, workflows=1, experts=1, skills=1")));
      assert.ok(ui.infos.some((message) => message.includes("last_run=2026-07-05T00:00:00Z")));
      assert.ok(ui.infos.some((message) => message.includes("latest log")));
      assert.ok(ui.infos.some((message) => message.includes("GitHub bootstrap is ready")));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testRecoversPartialRepo(): Promise<void> {
  await withTempHome(async (configDir) => {
    const cwd = tempDir("agentify-cli-main-recover-");
    try {
      fs.writeFileSync(
        path.join(cwd, "AGENTS.md"),
        `${AGENTIFY_MANAGED_MARKERS.markdown}\n# partial\n`,
      );
      writeProjectState(configDir, {
        cwd,
        lastRunAt: "2026-07-04T12:00:00Z",
        projectKind: "brownfield",
        runStatus: "partial",
        repoMode: "brownfield",
        repoStatus: "partial",
        featureAgentCount: 0,
        latestLogPath: null,
        github: {
          hasGitDirectory: true,
          hasGitHubRemote: true,
          ghCliAvailable: true,
          originUrl: "git@github.com:owner/repo.git",
        },
      });
      saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
      fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));

      const ui = new TestUi();
      const runtime = new BrownfieldFakeRuntime();
      await runAgentifyApp({
        args: [],
        cwd,
        ui,
        runtime,
        mode: "brownfield",
        githubReadinessOverride: READY_GITHUB,
      });

      assert.equal(runtime.sessionCalls, 1);
      assert.ok(ui.statuses.some((message) => message.includes("detected incomplete setup; recovering")));
      assert.ok(ui.infos.some((message) => message.includes("previous run ended with partial at 2026-07-04T12:00:00Z")));
      assert.ok(ui.infos.some((message) => message.includes("missing specs/README.md")));
      assert.ok(fs.existsSync(path.join(cwd, "specs", "README.md")));
      assert.ok(fs.existsSync(path.join(cwd, "SETUP.md")));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testBinPrintsConciseErrors(): Promise<void> {
  // `--mode bogus` triggers a thrown error in src/cli.ts that the bin
  // wrapper turns into a one-line `agentify: <msg>` on stderr with no
  // stack trace leak.
  const result = spawnSync(process.execPath, ["bin/agentify.js", "--mode", "bogus"], {
    cwd: path.resolve("."),
    encoding: "utf-8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^agentify: /);
  assert.doesNotMatch(result.stderr, /Error:|at .*\.ts|at .*\.js/);
}

async function testBinDispatchesLoginAndExitsZero(): Promise<void> {
  await withTempHome(async () => {
    // openai-codex is OAuth-only; `login --provider openai-codex` should
    // print instructions and exit 0 without writing or prompting.
    const result = spawnSync(
      process.execPath,
      ["bin/agentify.js", "login", "--provider", "openai-codex"],
      { cwd: path.resolve("."), encoding: "utf-8" },
    );
    assert.equal(result.status, 0, `expected exit 0; stderr=${result.stderr}`);
    assert.match(result.stdout, /OpenAI Codex uses OAuth/);
    assert.match(result.stdout, /pi auth login openai-codex/);
  });
}

async function testBinDispatchesLoginWithBadProviderExitsNonzero(): Promise<void> {
  const result = spawnSync(
    process.execPath,
    ["bin/agentify.js", "login", "--provider", "fake"],
    { cwd: path.resolve("."), encoding: "utf-8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^agentify: login: unknown provider 'fake'/);
}

async function testBinUnknownSubcommandReturnsValidList(): Promise<void> {
  const result = spawnSync(process.execPath, ["bin/agentify.js", "foo"], {
    cwd: path.resolve("."),
    encoding: "utf-8",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Known subcommands: login, logout, models/,
  );
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "rejectsLegacySubcommands", fn: testRejectsLegacySubcommands },
  { name: "runsThroughSingleEntrypoint", fn: testRunsThroughSingleEntrypoint },
  { name: "attachesToInitializedRepoWithoutRerun", fn: testAttachesToInitializedRepoWithoutRerun },
  { name: "recoversPartialRepo", fn: testRecoversPartialRepo },
  { name: "binPrintsConciseErrors", fn: testBinPrintsConciseErrors },
  { name: "binDispatchesLoginAndExitsZero", fn: testBinDispatchesLoginAndExitsZero },
  { name: "binDispatchesLoginWithBadProviderExitsNonzero", fn: testBinDispatchesLoginWithBadProviderExitsNonzero },
  { name: "binUnknownSubcommandReturnsValidList", fn: testBinUnknownSubcommandReturnsValidList },
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
console.log(`cli-main tests passed (${passed}/${tests.length}).`);
