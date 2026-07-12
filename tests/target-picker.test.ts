import assert from "node:assert/strict";
import { promptTargets } from "../src/core/target-picker.ts";
import type { AgentifyUi } from "../src/core/types.ts";

class QueueingUi implements AgentifyUi {
  statuses: string[] = [];
  infos: string[] = [];
  errors: string[] = [];
  selectCalls: { message: string; choiceCount: number }[] = [];
  multiSelectCalls: { message: string; choiceCount: number }[] = [];
  secretCalls: { message: string }[] = [];

  constructor(
    multiSelectAnswers: ReadonlyArray<ReadonlyArray<string>> = [],
  ) {
    // shift() mutates, so we work through a mutable local array.
    this._mutableAnswers = [...multiSelectAnswers];
  }

  private _mutableAnswers: ReadonlyArray<string>[] = [];

  status(message: string): void {
    this.statuses.push(message);
  }

  info(message: string): void {
    this.infos.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  async promptSelect(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string }>,
  ): Promise<string> {
    this.selectCalls.push({ message, choiceCount: choices.length });
    throw new Error("promptSelect should not be called by the target picker");
  }

  async promptMultiSelect(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string; hint?: string }>,
  ): Promise<ReadonlyArray<string>> {
    this.multiSelectCalls.push({ message, choiceCount: choices.length });
    const next = (this._mutableAnswers as ReadonlyArray<string>[]).shift();
    if (!next) {
      throw new Error("No promptMultiSelect answer queued");
    }
    return next;
  }

  async promptSecret(message: string): Promise<string> {
    this.secretCalls.push({ message });
    throw new Error("promptSecret should not be called by the target picker");
  }
}

async function testReturnsUserSelection(): Promise<void> {
  const ui = new QueueingUi([["claude-code", "codex"]]);
  const result = await promptTargets(ui);
  assert.deepEqual(result, ["claude-code", "codex"]);
  assert.equal(ui.multiSelectCalls.length, 1);
  // The picker surfaces the full registry as choices.
  assert.ok(ui.multiSelectCalls[0].choiceCount >= 50);
  assert.ok(ui.multiSelectCalls[0].message.includes("Which coding agent"));
}

async function testEmptySelectionFallsBackToDefaults(): Promise<void> {
  const ui = new QueueingUi([[]]);
  const result = await promptTargets(ui);
  assert.deepEqual(result, ["claude-code", "codex", "pi"]);
  // The fallback should announce itself via ui.info.
  assert.ok(
    ui.infos.some((line) => line.includes("falling back to defaults")),
    `expected a 'falling back to defaults' info message; got: ${ui.infos.join(" | ")}`,
  );
}

async function testNonPremiumSelectionPassesThrough(): Promise<void> {
  // Cursor + OpenCode — both non-premium. Should pass through as AgentId[].
  const ui = new QueueingUi([["cursor", "opencode"]]);
  const result = await promptTargets(ui);
  assert.deepEqual(result, ["cursor", "opencode"]);
}

async function testSingleSelection(): Promise<void> {
  const ui = new QueueingUi([["claude-code"]]);
  const result = await promptTargets(ui);
  assert.deepEqual(result, ["claude-code"]);
}

async function testPickerNeverCallsPromptSelectOrPromptSecret(): Promise<void> {
  const ui = new QueueingUi([["codex"]]);
  await promptTargets(ui);
  assert.equal(ui.selectCalls.length, 0);
  assert.equal(ui.secretCalls.length, 0);
}

async function testPickerChoicesIncludeAllRegistryAgents(): Promise<void> {
  // Capture the prompt message + the choices count via a spy ui that
  // records the choices.
  let capturedChoiceCount = 0;
  class SpyUi implements AgentifyUi {
    statuses: string[] = [];
    infos: string[] = [];
    errors: string[] = [];
    status(): void {}
    info(): void {}
    error(): void {}
    async promptSelect(): Promise<string> { throw new Error("nope"); }
    async promptSecret(): Promise<string> { throw new Error("nope"); }
    async promptMultiSelect(
      _message: string,
      choices: ReadonlyArray<{ label: string; value: string; hint?: string }>,
    ): Promise<ReadonlyArray<string>> {
      capturedChoiceCount = choices.length;
      // Return the three premium IDs to short-circuit.
      return ["claude-code", "codex", "pi"];
    }
  }
  await promptTargets(new SpyUi());
  // The picker should expose every agent in the registry to the user.
  assert.ok(
    capturedChoiceCount >= 50,
    `expected picker to expose >= 50 agents; got ${capturedChoiceCount}`,
  );
}

async function testPickerMessageMentionsDefaults(): Promise<void> {
  let capturedMessage = "";
  class SpyUi implements AgentifyUi {
    statuses: string[] = [];
    infos: string[] = [];
    errors: string[] = [];
    status(): void {}
    info(): void {}
    error(): void {}
    async promptSelect(): Promise<string> { throw new Error("nope"); }
    async promptSecret(): Promise<string> { throw new Error("nope"); }
    async promptMultiSelect(message: string): Promise<ReadonlyArray<string>> {
      capturedMessage = message;
      return ["claude-code"];
    }
  }
  await promptTargets(new SpyUi());
  assert.ok(
    capturedMessage.includes("Defaults pre-selected"),
    `picker message should mention defaults; got: ${capturedMessage}`,
  );
}

async function main(): Promise<void> {
  await testReturnsUserSelection();
  await testEmptySelectionFallsBackToDefaults();
  await testNonPremiumSelectionPassesThrough();
  await testSingleSelection();
  await testPickerNeverCallsPromptSelectOrPromptSecret();
  await testPickerChoicesIncludeAllRegistryAgents();
  await testPickerMessageMentionsDefaults();
  // eslint-disable-next-line no-console
  console.log("target-picker.test.ts: all 7 checks passed");
}

await main();