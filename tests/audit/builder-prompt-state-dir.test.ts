// tests/audit/builder-prompt-state-dir.test.ts
//
// Guards the state-dir invariant: the source `builder.md` prompt
// on disk must use the `<stateDir>` placeholder for every audit
// path reference rather than hardcoding the legacy
// `.pi/agentify/` literal. Production callers substitute the
// resolved state dir at runtime, so any leak of the literal
// in the source file would surface to the LLM as a hardcoded
// path reference that contradicts the dispatch rule.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { loadBuilderPrompt } from "../../src/core/audit/prompt.ts";

function readRawBuilderPrompt(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(here, "../../src/core/audit/prompts/builder.md");
  return fs.readFileSync(promptPath, "utf-8");
}

async function testSourcePromptHasStateDirPlaceholder(): Promise<void> {
  const raw = readRawBuilderPrompt();
  // The prompt must contain at least one `<stateDir>` placeholder so
  // substitution actually happens during audit runs. If a regression
  // removes all of them (someone hardcoded a state dir), this fails.
  assert.ok(
    raw.includes("<stateDir>"),
    "builder prompt has no <stateDir> placeholder; loadBuilderPrompt would be a no-op",
  );
}

async function testSourcePromptHasNoHardcodedAgentify(): Promise<void> {
  const raw = readRawBuilderPrompt();
  // Walk the prompt for hardcoded `.pi/agentify/...` paths that
  // would surface to the LLM verbatim. Allow `.pi/settings.json` and
  // `~/.pi/agent/settings.json` references (Pi-specific convention,
  // not state-dir related).
  const lines = raw.split("\n");
  for (const [i, line] of lines.entries()) {
    const withoutPiSettings = line.replace(/\.pi\/settings\.json/g, "").replace(/~\/\.pi\/agent\/settings\.json/g, "");
    if (withoutPiSettings.includes(".pi/agentify/")) {
      assert.fail(
        `builder.md:${i + 1} contains a hardcoded \\.pi/agentify/ path:\n  ${line}\n` +
          "Use the <stateDir> placeholder instead.",
      );
    }
  }
}

async function testLoadSubstitutesPlaceholder(): Promise<void> {
  const prompt = loadBuilderPrompt(".claude/agentify");
  // `<stateDir>` must not survive a successful substitution.
  assert.ok(!prompt.includes("<stateDir>"), "loadBuilderPrompt failed to substitute");
  // And the resolved state dir must be present.
  assert.ok(
    prompt.includes(".claude/agentify/"),
    "loadBuilderPrompt did not substitute the supplied stateDir",
  );
}

async function main(): Promise<void> {
  await testSourcePromptHasStateDirPlaceholder();
  await testSourcePromptHasNoHardcodedAgentify();
  await testLoadSubstitutesPlaceholder();
  // eslint-disable-next-line no-console
  console.log("builder-prompt-state-dir: all 3 checks passed");
}

await main();
