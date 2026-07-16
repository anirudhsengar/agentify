import assert from "node:assert/strict";
import {
  promptTargets,
  resolveSkillsDirsToAgents,
} from "../src/core/target-picker.ts";
import type { AgentifyUi } from "../src/core/types.ts";

interface Choice {
  label: string;
  value: string;
  hint?: string;
}

interface CheckboxOptions {
  initialValues?: ReadonlyArray<string>;
  cursorAt?: string;
}

class QueueingUi implements AgentifyUi {
  statuses: string[] = [];
  infos: string[] = [];
  errors: string[] = [];
  selectCalls: { message: string; choiceCount: number }[] = [];
  multiSelectCalls: { message: string; choiceCount: number }[] = [];
  checkboxCalls: {
    message: string;
    choices: ReadonlyArray<Choice>;
    options?: CheckboxOptions;
  }[] = [];
  secretCalls: { message: string }[] = [];

  constructor(
    checkboxAnswers: ReadonlyArray<ReadonlyArray<string>> = [],
  ) {
    this._mutableAnswers = [...checkboxAnswers];
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
    choices: ReadonlyArray<Choice>,
  ): Promise<ReadonlyArray<string>> {
    this.multiSelectCalls.push({ message, choiceCount: choices.length });
    throw new Error(
      "promptMultiSelect should not be called by the target picker",
    );
  }

  async promptCheckboxList(
    message: string,
    choices: ReadonlyArray<Choice>,
    options?: CheckboxOptions,
  ): Promise<ReadonlyArray<string>> {
    this.checkboxCalls.push({ message, choices, options });
    const next = (this._mutableAnswers as ReadonlyArray<string>[]).shift();
    if (!next) {
      throw new Error("No promptCheckboxList answer queued");
    }
    return next;
  }

  async promptSecret(message: string): Promise<string> {
    this.secretCalls.push({ message });
    throw new Error("promptSecret should not be called by the target picker");
  }
}

async function testReturnsUserSelection(): Promise<void> {
  const ui = new QueueingUi([[".claude/skills", ".agents/skills"]]);
  const result = await promptTargets(ui);
  assert.deepEqual(result, [".claude/skills", ".agents/skills"]);
  assert.equal(ui.checkboxCalls.length, 1);
  assert.ok(ui.checkboxCalls[0].message.includes("skills directories"));
}

async function testEmptySelectionFallsBackToDefaults(): Promise<void> {
  const ui = new QueueingUi([[]]);
  const result = await promptTargets(ui);
  assert.deepEqual(result, [".claude/skills", ".agents/skills", ".pi/skills"]);
  assert.ok(
    ui.infos.some((line) => line.includes("falling back to defaults")),
    `expected a 'falling back to defaults' info message; got: ${ui.infos.join(" | ")}`,
  );
}

async function testPickerCollapsesUniversalAgentsToSingleOption(): Promise<void> {
  let capturedChoices: ReadonlyArray<Choice> = [];
  class SpyUi implements AgentifyUi {
    statuses: string[] = [];
    infos: string[] = [];
    errors: string[] = [];
    status(): void {}
    info(): void {}
    error(): void {}
    async promptSelect(): Promise<string> { throw new Error("nope"); }
    async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("nope"); }
    async promptSecret(): Promise<string> { throw new Error("nope"); }
    async promptCheckboxList(
      _message: string,
      choices: ReadonlyArray<Choice>,
    ): Promise<ReadonlyArray<string>> {
      capturedChoices = choices;
      return [".claude/skills"];
    }
  }
  await promptTargets(new SpyUi());
  const agentsSkillsDirCount = capturedChoices.filter(
    (c) => c.value === ".agents/skills",
  ).length;
  assert.equal(
    agentsSkillsDirCount,
    1,
    `expected exactly one .agents/skills entry; got ${agentsSkillsDirCount}`,
  );
}

async function testPickerCollapsesAgentDuplicatesPerDirectory(): Promise<void> {
  let capturedChoices: ReadonlyArray<Choice> = [];
  class SpyUi implements AgentifyUi {
    statuses: string[] = [];
    infos: string[] = [];
    errors: string[] = [];
    status(): void {}
    info(): void {}
    error(): void {}
    async promptSelect(): Promise<string> { throw new Error("nope"); }
    async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("nope"); }
    async promptSecret(): Promise<string> { throw new Error("nope"); }
    async promptCheckboxList(
      _message: string,
      choices: ReadonlyArray<Choice>,
    ): Promise<ReadonlyArray<string>> {
      capturedChoices = choices;
      return [];
    }
  }
  await promptTargets(new SpyUi());
  const qoderCount = capturedChoices.filter((c) => c.value === ".qoder/skills").length;
  const traeCount = capturedChoices.filter((c) => c.value === ".trae/skills").length;
  const zencoderCount = capturedChoices.filter((c) => c.value === ".zencoder/skills").length;
  assert.equal(qoderCount, 1, "expected one .qoder/skills entry (serves Qoder + Qoder CN)");
  assert.equal(traeCount, 1, "expected one .trae/skills entry (serves Trae + Trae CN)");
  assert.equal(zencoderCount, 1, "expected one .zencoder/skills entry (serves Zencoder + Zenflow)");
}

async function testPickerExposesAllUniqueSkillsDirs(): Promise<void> {
  let capturedChoices: ReadonlyArray<Choice> = [];
  class SpyUi implements AgentifyUi {
    statuses: string[] = [];
    infos: string[] = [];
    errors: string[] = [];
    status(): void {}
    info(): void {}
    error(): void {}
    async promptSelect(): Promise<string> { throw new Error("nope"); }
    async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("nope"); }
    async promptSecret(): Promise<string> { throw new Error("nope"); }
    async promptCheckboxList(
      _message: string,
      choices: ReadonlyArray<Choice>,
    ): Promise<ReadonlyArray<string>> {
      capturedChoices = choices;
      return [];
    }
  }
  await promptTargets(new SpyUi());
  // 71 agent entries → 51 unique directories. Allow some slack.
  assert.ok(
    capturedChoices.length >= 45 && capturedChoices.length <= 60,
    `expected ~51 unique directories; got ${capturedChoices.length}`,
  );
  for (const required of [".claude/skills", ".agents/skills", ".pi/skills"]) {
    assert.ok(
      capturedChoices.some((c) => c.value === required),
      `expected picker to include ${required}`,
    );
  }
}

async function testPickerSortsByPopularityDescending(): Promise<void> {
  // .agents/skills serves 18 agents (Codex + 17 universal). It should
  // appear at the top of the picker (or near the top — depends on
  // initialValues pre-selection, but in the choices array the most-
  // popular dir comes first).
  let capturedChoices: ReadonlyArray<Choice> = [];
  class SpyUi implements AgentifyUi {
    statuses: string[] = [];
    infos: string[] = [];
    errors: string[] = [];
    status(): void {}
    info(): void {}
    error(): void {}
    async promptSelect(): Promise<string> { throw new Error("nope"); }
    async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("nope"); }
    async promptSecret(): Promise<string> { throw new Error("nope"); }
    async promptCheckboxList(
      _message: string,
      choices: ReadonlyArray<Choice>,
    ): Promise<ReadonlyArray<string>> {
      capturedChoices = choices;
      return [];
    }
  }
  await promptTargets(new SpyUi());
  const agentsSkillsIdx = capturedChoices.findIndex(
    (c) => c.value === ".agents/skills",
  );
  const adalIdx = capturedChoices.findIndex(
    (c) => c.value === ".adal/skills",
  );
  assert.ok(
    agentsSkillsIdx >= 0 && agentsSkillsIdx < 5,
    `expected .agents/skills near the top of the picker; got index ${agentsSkillsIdx}`,
  );
  assert.ok(
    adalIdx > agentsSkillsIdx,
    `expected .adal/skills (1 agent) to come after .agents/skills (18 agents); agents=${agentsSkillsIdx} adal=${adalIdx}`,
  );
}

async function testPickerPreSelectsPremiumDirs(): Promise<void> {
  let capturedOptions: CheckboxOptions | undefined;
  class SpyUi implements AgentifyUi {
    statuses: string[] = [];
    infos: string[] = [];
    errors: string[] = [];
    status(): void {}
    info(): void {}
    error(): void {}
    async promptSelect(): Promise<string> { throw new Error("nope"); }
    async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("nope"); }
    async promptSecret(): Promise<string> { throw new Error("nope"); }
    async promptCheckboxList(
      _message: string,
      _choices: ReadonlyArray<Choice>,
      options?: CheckboxOptions,
    ): Promise<ReadonlyArray<string>> {
      capturedOptions = options;
      return [];
    }
  }
  await promptTargets(new SpyUi());
  assert.ok(capturedOptions, "expected picker options to be passed");
  const initial = [...(capturedOptions!.initialValues ?? [])].sort();
  assert.deepEqual(
    initial,
    [".agents/skills", ".claude/skills", ".pi/skills"].sort(),
    `expected initialValues to be the three premium skills dirs; got ${JSON.stringify(capturedOptions!.initialValues)}`,
  );
  assert.equal(
    capturedOptions!.cursorAt,
    ".claude/skills",
    `expected cursorAt to be '.claude/skills'; got ${JSON.stringify(capturedOptions!.cursorAt)}`,
  );
}

async function testPickerUsesCheckboxListNotGrouped(): Promise<void> {
  // The custom checkbox picker is FLAT — no group headers. This
  // ensures the picker renders deterministically via our own
  // `list-picker.ts` primitive (clack's diff renderer was leaving
  // stacked frames on screen for the 51-entry list).
  const ui = new QueueingUi([[".claude/skills"]]);
  await promptTargets(ui);
  assert.equal(
    ui.checkboxCalls.length,
    1,
    "expected exactly one promptCheckboxList call",
  );
}

async function testPickerExposesViewportFriendlyShape(): Promise<void> {
  // The checkbox picker receives a flat (un-grouped) choices array,
  // which lets the picker render a viewport that scrolls through
  // the entries without pushing content into the terminal scroll
  // buffer.
  const ui = new QueueingUi([[".claude/skills"]]);
  await promptTargets(ui);
  const call = ui.checkboxCalls[0];
  assert.ok(call, "expected promptCheckboxList to be called");
  assert.ok(
    Array.isArray(call.choices),
    "expected promptCheckboxList.choices to be a flat array",
  );
  assert.equal(
    call.choices.length,
    ui.checkboxCalls[0].choices.length,
    "choices count should match",
  );
  // Verify each choice has a label (the directory) and a hint
  // (agent names) — that's what makes the picker self-explanatory
  // even at viewport height.
  for (const choice of call.choices) {
    assert.ok(
      typeof choice.label === "string" && choice.label.length > 0,
      `expected every choice to have a label; got ${JSON.stringify(choice)}`,
    );
    assert.ok(
      typeof choice.hint === "string" && choice.hint.length > 0,
      `expected every choice to have a hint naming the agents; got ${JSON.stringify(choice)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// resolveSkillsDirsToAgents conversion tests
// ---------------------------------------------------------------------------

async function testResolveMapsPremiumDirToPremiumTarget(): Promise<void> {
  const result = resolveSkillsDirsToAgents([".claude/skills"]);
  assert.deepEqual(result.targets, ["claude"]);
  assert.deepEqual(result.additionalAgents, []);
}

async function testResolveMapsAgentsSkillsDirToCodexOnly(): Promise<void> {
  const result = resolveSkillsDirsToAgents([".agents/skills"]);
  assert.deepEqual(result.targets, ["codex"]);
  assert.deepEqual(result.additionalAgents, []);
}

async function testResolveMapsPiSkillsDirToPi(): Promise<void> {
  const result = resolveSkillsDirsToAgents([".pi/skills"]);
  assert.deepEqual(result.targets, ["pi"]);
  assert.deepEqual(result.additionalAgents, []);
}

async function testResolveMapsAgentSpecificDirToFirstAgent(): Promise<void> {
  const result = resolveSkillsDirsToAgents([".adal/skills"]);
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.additionalAgents, ["adal"]);
}

async function testResolveCollapsesMultipleDirSelections(): Promise<void> {
  const result = resolveSkillsDirsToAgents([
    ".claude/skills",
    ".agents/skills",
    ".adal/skills",
  ]);
  assert.deepEqual([...result.targets].sort(), ["claude", "codex"]);
  assert.deepEqual(result.additionalAgents, ["adal"]);
}

async function testResolveIgnoresUnknownDir(): Promise<void> {
  const result = resolveSkillsDirsToAgents([
    ".claude/skills",
    "/totally/made/up",
  ]);
  assert.deepEqual(result.targets, ["claude"]);
  assert.deepEqual(result.additionalAgents, []);
}

async function main(): Promise<void> {
  await testReturnsUserSelection();
  await testEmptySelectionFallsBackToDefaults();
  await testPickerCollapsesUniversalAgentsToSingleOption();
  await testPickerCollapsesAgentDuplicatesPerDirectory();
  await testPickerExposesAllUniqueSkillsDirs();
  await testPickerSortsByPopularityDescending();
  await testPickerPreSelectsPremiumDirs();
  await testPickerUsesCheckboxListNotGrouped();
  await testPickerExposesViewportFriendlyShape();
  await testResolveMapsPremiumDirToPremiumTarget();
  await testResolveMapsAgentsSkillsDirToCodexOnly();
  await testResolveMapsPiSkillsDirToPi();
  await testResolveMapsAgentSpecificDirToFirstAgent();
  await testResolveCollapsesMultipleDirSelections();
  await testResolveIgnoresUnknownDir();
  // eslint-disable-next-line no-console
  console.log("target-picker.test.ts: all 16 checks passed");
}

await main();
