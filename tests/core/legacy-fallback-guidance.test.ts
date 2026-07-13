import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgentifyApp } from "../../src/core/agentify-app.ts";
import { inspectAgentifyRepoState } from "../../src/core/repo-status.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentifyUi,
} from "../../src/core/types.ts";

class TestUi implements AgentifyUi {
  readonly statuses: string[] = [];
  readonly infos: string[] = [];
  readonly errors: string[] = [];

  status(message: string): void { this.statuses.push(message); }
  info(message: string): void { this.infos.push(message); }
  error(message: string): void { this.errors.push(message); }
  async promptSelect(): Promise<string> { throw new Error("unexpected prompt"); }
  async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("unexpected prompt"); }
  async promptSecret(): Promise<string> { throw new Error("unexpected prompt"); }
}

class NoRunRuntime implements AgentRuntime {
  sessionCalls = 0;
  greenfieldCalls = 0;

  async runSession(): Promise<AgentRuntimeResult> {
    this.sessionCalls += 1;
    return { turns: 0, costUsd: null, aborted: true };
  }

  async runGreenfield(): Promise<AgentRuntimeResult> {
    this.greenfieldCalls += 1;
    return { turns: 0, costUsd: null, aborted: true };
  }
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedLegacyManifest(cwd: string, files: unknown[] = []): void {
  const stateDir = path.join(cwd, ".pi/agentify");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "manifest.json"),
    `${JSON.stringify({
      schema_version: "1",
      agentify_version: "0.1.0",
      generated_at: "2026-01-01T00:00:00.000Z",
      mode: "brownfield",
      files,
    }, null, 2)}\n`,
  );
}

async function testNonPiFallbackWarnsOnceAndAttachesAtLegacyPath(): Promise<void> {
  const cwd = tempDir("agentify-fallback-guidance-");
  try {
    seedLegacyManifest(cwd);
    const ui = new TestUi();
    const runtime = new NoRunRuntime();
    await runAgentifyApp({
      args: [],
      cwd,
      ui,
      runtime,
      targets: ["claude"],
    });

    assert.equal(runtime.sessionCalls, 0);
    const fallbackMessages = ui.infos.filter((message) => message.includes("legacy state detected"));
    assert.equal(fallbackMessages.length, 1);
    assert.match(fallbackMessages[0]!, /\.pi\/agentify/);
    assert.match(fallbackMessages[0]!, /\.claude\/agentify/);
    assert.match(fallbackMessages[0]!, /no state was moved or deleted/);
    assert.equal(
      ui.infos.filter((message) => message === "agentify: inspecting state at .pi/agentify").length,
      1,
    );
    assert.ok(!fs.existsSync(path.join(cwd, ".claude/agentify")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testPiOnlyStateIsNotLabeledLegacy(): Promise<void> {
  const cwd = tempDir("agentify-pi-canonical-guidance-");
  try {
    seedLegacyManifest(cwd);
    const ui = new TestUi();
    const runtime = new NoRunRuntime();
    await runAgentifyApp({
      args: [],
      cwd,
      ui,
      runtime,
      targets: ["pi"],
    });

    assert.equal(runtime.sessionCalls, 0);
    assert.equal(ui.infos.some((message) => message.includes("legacy state detected")), false);
    assert.ok(ui.infos.includes("agentify: inspecting state at .pi/agentify"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRepoStatusNamesExactLegacyStateDirectory(): void {
  const cwd = tempDir("agentify-fallback-status-");
  const configDir = tempDir("agentify-fallback-status-config-");
  try {
    seedLegacyManifest(cwd, [{
      path: "AGENTS.md",
      kind: "audit",
      required: true,
      marker: "<!-- agentify:managed -->",
      sha256: "missing",
      source: "old-version",
    }]);
    const state = inspectAgentifyRepoState(cwd, configDir, ".pi/agentify");
    assert.equal(state.stateDir, ".pi/agentify");
    assert.equal(state.status, "partial");
    assert.deepEqual(state.missing, ["AGENTS.md"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

await testNonPiFallbackWarnsOnceAndAttachesAtLegacyPath();
await testPiOnlyStateIsNotLabeledLegacy();
testRepoStatusNamesExactLegacyStateDirectory();
console.log("legacy fallback guidance tests passed");
