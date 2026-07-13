import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgentifyApp } from "../../src/core/agentify-app.ts";
import type { AgentRuntime, AgentRuntimeResult, AgentifyUi } from "../../src/core/types.ts";

class Ui implements AgentifyUi {
  infos: string[] = [];
  statuses: string[] = [];
  errors: string[] = [];
  info(message: string): void { this.infos.push(message); }
  status(message: string): void { this.statuses.push(message); }
  error(message: string): void { this.errors.push(message); }
  async promptSelect(): Promise<string> { throw new Error("unexpected prompt"); }
  async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("unexpected prompt"); }
  async promptSecret(): Promise<string> { throw new Error("unexpected prompt"); }
}

class NoRunRuntime implements AgentRuntime {
  calls = 0;
  async runSession(): Promise<AgentRuntimeResult> { this.calls += 1; return { turns: 0, costUsd: null, aborted: true }; }
  async runGreenfield(): Promise<AgentRuntimeResult> { this.calls += 1; return { turns: 0, costUsd: null, aborted: true }; }
}

function seedClaudeState(cwd: string): void {
  const stateDir = ".claude/agentify";
  fs.mkdirSync(path.join(cwd, stateDir), { recursive: true });
  fs.writeFileSync(path.join(cwd, stateDir, "codebase_map.json"), '{"marker":"claude"}\n');
  fs.writeFileSync(path.join(cwd, stateDir, "manifest.json"), JSON.stringify({
    schema_version: "2",
    agentify_version: "0.1.0",
    generated_at: "2026-07-13T00:00:00.000Z",
    mode: "brownfield",
    run_id: "claude-run",
    state_dir: stateDir,
    files: [],
  }, null, 2) + "\n");
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-provider-switch-"));
try {
  seedClaudeState(cwd);
  await assert.rejects(
    () => runAgentifyApp({
      args: [], cwd, ui: new Ui(), runtime: new NoRunRuntime(), targets: ["codex"],
    }),
    /existing provider state is present/,
  );
  assert.ok(!fs.existsSync(path.join(cwd, ".agents/agentify")));

  const ui = new Ui();
  const runtime = new NoRunRuntime();
  await runAgentifyApp({
    args: [], cwd, ui, runtime, targets: ["codex"], migrateState: true,
  });
  assert.equal(runtime.calls, 0);
  assert.ok(ui.infos.some((message) => message.includes("migrating retained provider state")));
  assert.ok(ui.statuses.some((message) => message.includes("attached to initialized brownfield repo")));
  assert.ok(fs.existsSync(path.join(cwd, ".claude/agentify/manifest.json")));
  const canonical = JSON.parse(fs.readFileSync(path.join(cwd, ".agents/agentify/manifest.json"), "utf-8")) as { state_dir?: string };
  assert.equal(canonical.state_dir, ".agents/agentify");
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}

console.log("provider-switch migration tests passed");
