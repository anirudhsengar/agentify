import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { authPath, defaultConfigDir, saveAgentifyConfig } from "../../src/core/agentify-config.ts";
import { writeGreenfieldFormationAt } from "../../src/core/greenfield-artifacts.ts";
import { runAgentify } from "../../src/core/run-agentify.ts";
import { makeGreenfieldFormation } from "../fixtures/greenfield-formation.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentifyUi,
} from "../../src/core/types.ts";

class RecordingUi implements AgentifyUi {
  readonly statuses: string[] = [];
  readonly infos: string[] = [];
  readonly errors: string[] = [];
  readonly prompts: string[] = [];
  private readonly selectAnswers: string[];

  constructor(selectAnswers: string[] = []) {
    this.selectAnswers = [...selectAnswers];
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

  async promptSelect(message: string): Promise<string> {
    this.prompts.push(message);
    const next = this.selectAnswers.shift();
    if (!next) throw new Error(`No promptSelect answer queued for: ${message}`);
    return next;
  }

  async promptMultiSelect(): Promise<ReadonlyArray<string>> {
    throw new Error("promptMultiSelect should not be called");
  }

  async promptCheckboxList(): Promise<ReadonlyArray<string>> {
    throw new Error("promptCheckboxList should not be called");
  }

  async promptSecret(): Promise<string> {
    throw new Error("promptSecret should not be called");
  }
}

class NoopRuntime implements AgentRuntime {
  async runSession(): Promise<AgentRuntimeResult> {
    throw new Error("runSession should not be called");
  }

  async runGreenfield(): Promise<AgentRuntimeResult> {
    throw new Error("runGreenfield should not be called");
  }
}

class ObservedGreenfieldRuntime implements AgentRuntime {
  observed: {
    cwd: string;
    configDir: string;
    config: { provider?: string; model?: string; thinkingLevel?: string };
    stateDir: string;
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
  } | null = null;

  async runSession(): Promise<AgentRuntimeResult> {
    throw new Error("runSession should not be called");
  }

  async runGreenfield(options: {
    cwd: string;
    configDir: string;
    config: { provider?: string; model?: string; thinkingLevel?: string };
    stateDir: string;
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
  }): Promise<AgentRuntimeResult> {
    this.observed = options;
    writeGreenfieldFormationAt(options.cwd, makeGreenfieldFormation(), options.stateDir);
    options.onEvent?.({ type: "agent_end", willRetry: false } as AgentSessionEvent);
    return { turns: 4, costUsd: 0.125, aborted: false };
  }
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withConfigHome<T>(run: (configDir: string) => Promise<T>): Promise<T> {
  const previousHome = process.env["HOME"];
  const home = tempDir("agentify-run-orchestration-home-");
  process.env["HOME"] = home;
  const configDir = defaultConfigDir();
  return run(configDir).finally(() => {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

function seedAuth(configDir: string): void {
  saveAgentifyConfig(configDir, {
    provider: "openai",
    model: "fixture",
    thinkingLevel: "medium",
  });
  fs.writeFileSync(
    authPath(configDir),
    JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
  );
}

async function testAmbiguousPromptWithoutOverride(): Promise<void> {
  await withConfigHome(async (configDir) => {
    seedAuth(configDir);
    const cwd = tempDir("agentify-run-orchestration-ambiguous-");
    try {
      fs.writeFileSync(path.join(cwd, "notes.txt"), "not enough signals\n");
      const ui = new RecordingUi();
      await assert.rejects(
        () => runAgentify({
          cwd,
          ui,
          runtime: new NoopRuntime(),
          targets: ["codex"],
        }),
        /No promptSelect answer queued.*This repository is ambiguous/i,
      );
      assert.equal(ui.prompts.length, 1);
      assert.match(ui.prompts[0] ?? "", /This repository is ambiguous/);
      assert.deepEqual(ui.statuses, []);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testTypedModeOverrideDelegatesDirectly(): Promise<void> {
  await withConfigHome(async (configDir) => {
    seedAuth(configDir);
    const cwd = tempDir("agentify-run-orchestration-invalid-mode-");
    try {
      await assert.rejects(
        () => runAgentify({
          cwd,
          ui: new RecordingUi(),
          runtime: new NoopRuntime(),
          targets: ["codex"],
          mode: "invalid" as "brownfield",
        }),
        /runSession should not be called/i,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testGreenfieldDelegationCharacterization(): Promise<void> {
  await withConfigHome(async (configDir) => {
    seedAuth(configDir);
    const cwd = tempDir("agentify-run-orchestration-greenfield-");
    const ui = new RecordingUi();
    const runtime = new ObservedGreenfieldRuntime();
    const controller = new AbortController();
    try {
      await runAgentify({
        cwd,
        ui,
        runtime,
        targets: ["codex"],
        additionalAgents: ["cursor"],
        mode: "greenfield",
        signal: controller.signal,
      });

      assert.deepEqual(runtime.observed, {
        cwd,
        configDir,
        config: {
          provider: "openai",
          model: "fixture",
          thinkingLevel: "medium",
          modelsByRole: undefined,
          targets: undefined,
        },
        stateDir: ".agents/agentify",
        signal: controller.signal,
      });
      assert.deepEqual(ui.statuses, ["agentify: starting greenfield chat"]);
      assert.ok(ui.infos.some((message) => message.includes("greenfield session complete (4 turn(s), $0.1250")));
      assert.equal(ui.errors.length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

await testAmbiguousPromptWithoutOverride();
await testTypedModeOverrideDelegatesDirectly();
await testGreenfieldDelegationCharacterization();

console.log("run orchestration characterization tests passed");
