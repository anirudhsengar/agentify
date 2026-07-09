import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { authPath, configPath, defaultConfigDir, saveAgentifyConfig } from "../src/core/agentify-config.ts";
import { readManifest } from "../src/core/manifest.ts";
import { makeValidCodebaseMap } from "./fixtures/codebase-map.ts";
import { runAgentify } from "../src/core/run-agentify.ts";
import { resolveCanonicalStateDir } from "../src/core/state-dir.ts";
import type { AgentifyUi, AgentRuntime, AgentRuntimeResult, GitHubReadiness } from "../src/core/types.ts";

class CollectingUi implements AgentifyUi {
  statuses: string[] = [];
  infos: string[] = [];
  errors: string[] = [];
  status(m: string) { this.statuses.push(m); }
  info(m: string) { this.infos.push(m); }
  error(m: string) { this.errors.push(m); }
  async promptSelect(_msg: string, _choices: ReadonlyArray<{ label: string; value: string }>): Promise<string> {
    throw new Error("no prompt");
  }
  async promptMultiSelect(_msg: string, _choices: ReadonlyArray<{ label: string; value: string; hint?: string }>): Promise<ReadonlyArray<string>> {
    throw new Error("no prompt");
  }
  async promptSecret(_msg: string): Promise<string> {
    throw new Error("no prompt");
  }
}

class FakeRuntime implements AgentRuntime {
  async runSession(options: { cwd: string }): Promise<AgentRuntimeResult> {
    fs.mkdirSync(path.join(options.cwd, "specs"), { recursive: true });
    fs.mkdirSync(path.join(options.cwd, "ai_docs"), { recursive: true });
    fs.mkdirSync(path.join(options.cwd, ".pi", "agents"), { recursive: true });
    fs.mkdirSync(path.join(options.cwd, ".pi", "agentify"), { recursive: true });
    fs.writeFileSync(
      path.join(options.cwd, ".pi", "agentify", "codebase_map.json"),
      JSON.stringify(makeValidCodebaseMap(), null, 2),
    );
    fs.writeFileSync(path.join(options.cwd, ".pi", "agents", "payments.md"),
      "---\nname: payments\ndescription: x\n---\n\nbody\n");
    return { turns: 1, costUsd: null, aborted: false };
  }
  async runGreenfield(): Promise<AgentRuntimeResult> {
    throw new Error("brownfield only");
  }
}

const READY_GITHUB: GitHubReadiness = {
  hasGitDirectory: true,
  hasGitHubRemote: true,
  originUrl: "git@github.com:owner/repo.git",
  ghCliAvailable: true,
  guidance: [],
};

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = tempDir("agentify-plan-home-");
  const previous = process.env.HOME;
  process.env.HOME = home;
  return fn(home).finally(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

async function testPlanDoesNotWriteManifest(): Promise<void> {
  await withTempHome(async (configDir) => {
    const cwd = tempDir("agentify-plan-");
    saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
    fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));
    try {
      const ui = new CollectingUi();
      await runAgentify({
        cwd, ui, runtime: new FakeRuntime(),
        targets: ["codex", "claude", "pi"], mode: "brownfield",
        configOverride: { provider: "openai", thinkingLevel: "high" },
        githubReadinessOverride: READY_GITHUB,
        dryRun: true,
      });
      const stateDir = resolveCanonicalStateDir(cwd, ["codex", "claude", "pi"]).relativeDir;
      const manifestPath = path.join(cwd, stateDir, "manifest.json");
      assert.ok(!fs.existsSync(manifestPath),
        "dry-run must not write the manifest to disk");
      // The plan was reported, though.
      assert.ok(
        ui.infos.some((m) => m.includes("dry-run complete")),
        "expected a 'dry-run complete' info line",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testPlanDoesNotWriteUserFiles(): Promise<void> {
  await withTempHome(async (configDir) => {
    const cwd = tempDir("agentify-plan-nowrite-");
    saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
    fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));
    try {
      // Pre-create a user file the audit would normally overwrite.
      fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# User-authored\n");
      const ui = new CollectingUi();
      await runAgentify({
        cwd, ui, runtime: new FakeRuntime(),
        targets: ["codex", "claude", "pi"], mode: "brownfield",
        configOverride: { provider: "openai", thinkingLevel: "high" },
        githubReadinessOverride: READY_GITHUB,
        dryRun: true,
      });
      // The user's AGENTS.md is unchanged.
      assert.equal(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf-8"), "# User-authored\n");
      // No alongside file was written either (dry-run, no apply).
      assert.ok(!fs.existsSync(path.join(cwd, "AGENTS.agentify.md")),
        "dry-run must not write the alongside file");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testPlanJsonShape(): Promise<void> {
  await withTempHome(async (configDir) => {
    const cwd = tempDir("agentify-plan-json-");
    saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
    fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));
    try {
      // Capture stdout.
      const originalWrite = process.stdout.write.bind(process.stdout);
      let captured = "";
      process.stdout.write = ((chunk: string | Buffer): boolean => {
        captured += typeof chunk === "string" ? chunk : chunk.toString();
        return true;
      }) as typeof process.stdout.write;
      const ui = new CollectingUi();
      try {
        await runAgentify({
          cwd, ui, runtime: new FakeRuntime(),
          targets: ["codex", "claude", "pi"], mode: "brownfield",
          configOverride: { provider: "openai", thinkingLevel: "high" },
          githubReadinessOverride: READY_GITHUB,
          dryRun: true,
          jsonOutput: true,
        });
      } finally {
        process.stdout.write = originalWrite;
      }
      assert.ok(captured.length > 0, "expected JSON output on stdout");
      const parsed = JSON.parse(captured) as {
        dry_run: boolean;
        summary: { created: number; kept_user: number; saved_alongside: number; conflicts: number };
        manifest: unknown;
        writes: Array<{ path: string; action: string }>;
      };
      assert.equal(parsed.dry_run, true);
      assert.equal(typeof parsed.summary.created, "number");
      assert.equal(typeof parsed.summary.saved_alongside, "number");
      assert.ok(parsed.manifest !== null);
      assert.ok(Array.isArray(parsed.writes));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "planDoesNotWriteManifest", fn: testPlanDoesNotWriteManifest },
  { name: "planDoesNotWriteUserFiles", fn: testPlanDoesNotWriteUserFiles },
  { name: "planJsonShape", fn: testPlanJsonShape },
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
console.log(`plan-flag tests passed (${passed}/${tests.length}).`);
