import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfigDir } from "../../src/core/agentify-config.ts";
import {
  getOrCreateSessionId,
  isAgentifySessionActive,
} from "../../src/core/audit/state.ts";
import { writeGreenfieldFormation } from "../../src/core/greenfield-artifacts.ts";
import { readProjectState } from "../../src/core/project-state.ts";
import { runAgentify } from "../../src/core/run-agentify.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
  AgentifyUi,
  GitHubReadiness,
} from "../../src/core/types.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";
import { makeGreenfieldFormation } from "../fixtures/greenfield-formation.ts";

const READY_GITHUB: GitHubReadiness = {
  hasGitDirectory: true,
  hasGitHubRemote: true,
  originUrl: "git@github.com:owner/repo.git",
  ghCliAvailable: true,
  guidance: ["GitHub bootstrap is ready."],
};

class EventUi implements AgentifyUi {
  readonly events: string[] = [];

  status(message: string): void {
    this.events.push(`status:${message}`);
  }

  info(message: string): void {
    this.events.push(`info:${message}`);
  }

  error(message: string): void {
    this.events.push(`error:${message}`);
  }

  async promptSelect(): Promise<string> {
    throw new Error("unexpected promptSelect");
  }

  async promptMultiSelect(): Promise<ReadonlyArray<string>> {
    throw new Error("unexpected promptMultiSelect");
  }

  async promptSecret(): Promise<string> {
    throw new Error("unexpected promptSecret");
  }
}

class ObservedBrownfieldRuntime implements AgentRuntime {
  observed: AgentRuntimeSessionOptions | null = null;

  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    this.observed = options;
    const legacyStateDir = path.join(options.cwd, ".pi", "agentify");
    fs.mkdirSync(legacyStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyStateDir, "codebase_map.json"),
      `${JSON.stringify(makeValidCodebaseMap(), null, 2)}\n`,
    );
    return { turns: 3, costUsd: 0.0123, aborted: false };
  }

  async runGreenfield(): Promise<AgentRuntimeResult> {
    throw new Error("greenfield runtime must not run");
  }
}

class ObservedGreenfieldRuntime implements AgentRuntime {
  observed: { cwd: string; configDir: string; signal?: AbortSignal } | null = null;

  async runSession(): Promise<AgentRuntimeResult> {
    throw new Error("brownfield runtime must not run");
  }

  async runGreenfield(options: {
    cwd: string;
    configDir: string;
    signal?: AbortSignal;
  }): Promise<AgentRuntimeResult> {
    this.observed = options;
    writeGreenfieldFormation(options.cwd, makeGreenfieldFormation());
    return { turns: 4, costUsd: 0.0456, aborted: false };
  }
}

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

async function withTempHome<T>(fn: (configDir: string) => Promise<T>): Promise<T> {
  const previousHome = process.env["HOME"];
  const home = tempDir("run-orchestration-home");
  process.env["HOME"] = home;
  try {
    return await fn(defaultConfigDir());
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function assertOrdered(events: readonly string[], prefixes: readonly string[]): void {
  let previous = -1;
  for (const prefix of prefixes) {
    const index = events.findIndex((event, candidate) => candidate > previous && event.startsWith(prefix));
    assert.notEqual(index, -1, `missing event after index ${previous}: ${prefix}\n${events.join("\n")}`);
    previous = index;
  }
}

async function testBrownfieldLifecycleContract(): Promise<void> {
  await withTempHome(async (configDir) => {
    const cwd = tempDir("run-orchestration-brownfield");
    const ui = new EventUi();
    const runtime = new ObservedBrownfieldRuntime();
    const controller = new AbortController();
    try {
      fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
      await runAgentify({
        cwd,
        ui,
        runtime,
        targets: ["codex", "claude", "pi"],
        additionalAgents: ["cursor"],
        mode: "brownfield",
        signal: controller.signal,
        configOverride: { provider: "openai", model: "fixture", thinkingLevel: "high" },
        githubReadinessOverride: READY_GITHUB,
      });

      const observed = runtime.observed;
      assert.ok(observed);
      assert.equal(observed.cwd, cwd);
      assert.equal(observed.configDir, configDir);
      assert.equal(observed.signal, controller.signal);
      assert.equal(observed.spawnExplorerStateDir, ".claude/agentify");
      assert.deepEqual(observed.tools, [
        "read",
        "grep",
        "find",
        "ls",
        "write_map",
        "write_map_delta",
        "spawn_explorer",
      ]);
      assert.deepEqual(observed.executionPolicy.allowedTools, ["read", "grep", "find", "ls"]);
      assert.equal(observed.executionPolicy.mode, "audit-readonly");
      assert.equal(observed.executionPolicy.commandPolicy, "deny");
      assert.equal(observed.executionPolicy.network, "deny");
      assert.deepEqual(observed.customTools?.map((tool) => tool.name), ["write_map", "write_map_delta"]);
      assert.match(observed.userPrompt, /codex, claude, pi, cursor/);

      assertOrdered(ui.events, [
        "status:agentify: auditing existing codebase",
        "info:agentify: staging generated bundle at ",
        "info:agentify: audit complete.",
        "info:agentify: GitHub bootstrap is ready.",
        "info:agentify: cleaned staging bundle at ",
        "info:agentify: log written to ",
      ]);
      const projectState = readProjectState(configDir, cwd);
      assert.equal(projectState?.projectKind, "brownfield");
      assert.equal(projectState?.repoMode, "brownfield");
      assert.ok(projectState?.runStatus === "success" || projectState?.runStatus === "partial");
      assert.equal(isAgentifySessionActive(getOrCreateSessionId()), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testGreenfieldLifecycleContract(): Promise<void> {
  await withTempHome(async (configDir) => {
    const cwd = tempDir("run-orchestration-greenfield");
    const ui = new EventUi();
    const runtime = new ObservedGreenfieldRuntime();
    const controller = new AbortController();
    try {
      await runAgentify({
        cwd,
        ui,
        runtime,
        targets: ["codex"],
        mode: "greenfield",
        signal: controller.signal,
        configOverride: { provider: "openai", model: "fixture", thinkingLevel: "medium" },
        githubReadinessOverride: READY_GITHUB,
      });

      assert.deepEqual(runtime.observed, {
        cwd,
        configDir,
        signal: controller.signal,
      });
      assertOrdered(ui.events, [
        "status:agentify: starting greenfield chat",
        "info:agentify: staging greenfield bundle at ",
        "info:agentify: cleaned greenfield staging bundle at ",
        "info:agentify: greenfield session complete (4 turn(s), $0.0456",
        "info:agentify: GitHub bootstrap is ready.",
      ]);
      const projectState = readProjectState(configDir, cwd);
      assert.equal(projectState?.projectKind, "greenfield");
      assert.equal(projectState?.repoMode, "greenfield");
      assert.equal(projectState?.runStatus, "success");
      assert.equal(isAgentifySessionActive(getOrCreateSessionId()), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

await testBrownfieldLifecycleContract();
await testGreenfieldLifecycleContract();
console.log("run orchestration characterization tests passed.");
