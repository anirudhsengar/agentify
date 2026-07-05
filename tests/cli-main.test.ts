import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { authPath, saveAgentifyConfig } from "../src/core/agentify-config.ts";
import { writeProjectState } from "../src/core/project-state.ts";
import { runAgentifyApp } from "../src/core/agentify-app.ts";
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
  for (const relativePath of [
    "AGENTS.md",
    "specs/README.md",
    "ai_docs/README.md",
    "SETUP.md",
    ".github/workflows/agent-implement.yml",
    ".pi/agents/payments.md",
  ]) {
    const filePath = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "x\n");
  }
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

async function testRejectsLegacySubcommands(): Promise<void> {
  const cwd = tempDir("agentify-cli-main-subcommands-");
  const configDir = tempDir("agentify-cli-main-config-");
  try {
    await assert.rejects(
      () => runAgentifyApp({
        args: ["webhook", "status"],
        cwd,
        configDir,
        ui: new TestUi(),
        runtime: new BrownfieldFakeRuntime(),
      }),
      /no longer accepts subcommands/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testRunsThroughSingleEntrypoint(): Promise<void> {
  const cwd = tempDir("agentify-cli-main-run-");
  const configDir = tempDir("agentify-cli-main-run-config-");
  try {
    fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
    saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
    fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));

    const ui = new TestUi();
    const runtime = new BrownfieldFakeRuntime();
    await runAgentifyApp({
      args: [],
      cwd,
      configDir,
      ui,
      runtime,
      assumeProjectKind: "brownfield",
      githubReadinessOverride: READY_GITHUB,
    });

    assert.equal(runtime.sessionCalls, 1);
    assert.ok(fs.existsSync(path.join(cwd, "AGENTS.md")));
    assert.ok(fs.existsSync(path.join(cwd, ".codex", "agents", "payments.toml")));
    assert.ok(fs.existsSync(path.join(cwd, ".claude", "agents", "payments.md")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testAttachesToInitializedRepoWithoutRerun(): Promise<void> {
  const cwd = tempDir("agentify-cli-main-attach-");
  const configDir = tempDir("agentify-cli-main-attach-config-");
  try {
    seedReadyRepo(cwd, configDir);
    const ui = new TestUi();
    const runtime = new BrownfieldFakeRuntime();

    await runAgentifyApp({
      args: [],
      cwd,
      configDir,
      ui,
      runtime,
      githubReadinessOverride: READY_GITHUB,
    });

    assert.equal(runtime.sessionCalls, 0);
    assert.ok(ui.statuses.some((message) => message.includes("attached to initialized brownfield repo")));
    assert.ok(ui.infos.some((message) => message.includes("last_run=2026-07-05T00:00:00Z")));
    assert.ok(ui.infos.some((message) => message.includes("latest log")));
    assert.ok(ui.infos.some((message) => message.includes("GitHub bootstrap is ready")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testRecoversPartialRepo(): Promise<void> {
  const cwd = tempDir("agentify-cli-main-recover-");
  const configDir = tempDir("agentify-cli-main-recover-config-");
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# partial\n");
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
      configDir,
      ui,
      runtime,
      assumeProjectKind: "brownfield",
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
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "rejectsLegacySubcommands", fn: testRejectsLegacySubcommands },
  { name: "runsThroughSingleEntrypoint", fn: testRunsThroughSingleEntrypoint },
  { name: "attachesToInitializedRepoWithoutRerun", fn: testAttachesToInitializedRepoWithoutRerun },
  { name: "recoversPartialRepo", fn: testRecoversPartialRepo },
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
