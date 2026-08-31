// tests/audit/builder-prompt-state-dir.test.ts
//
// Guards the state-dir invariant: the source `builder.md` prompt
// on disk must use the `<stateDir>` placeholder for every audit
// path reference rather than hardcoding the
// `.agentify/runtime/audit/` literal. Production callers substitute the
// resolved state dir at runtime, so any leak of the literal
// in the source file would surface to the LLM as a hardcoded
// path reference that contradicts the dispatch rule.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { loadBuilderPrompt } from "../../src/core/audit/prompt.ts";
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from "../../src/core/audit/spawn-explorer-tool.ts";

const SMALL_NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function readRawBuilderPrompt(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(here, "../../src/core/audit/prompts/builder.md");
  return fs.readFileSync(promptPath, "utf-8").replaceAll("\r\n", "\n");
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
  // Walk the prompt for hardcoded `.agentify/runtime/audit/...` paths that
  // would surface to the LLM verbatim. Allow `.pi/settings.json` and
  // `~/.pi/agent/settings.json` references (Pi-specific convention,
  // not state-dir related).
  const lines = raw.split("\n");
  for (const [i, line] of lines.entries()) {
    const withoutPiSettings = line.replace(/\.pi\/settings\.json/g, "").replace(/~\/\.pi\/agent\/settings\.json/g, "");
    if (withoutPiSettings.includes(".agentify/runtime/audit/")) {
      assert.fail(
        `builder.md:${i + 1} contains a hardcoded \\.agentify/runtime/audit/ path:\n  ${line}\n` +
          "Use the <stateDir> placeholder instead.",
      );
    }
  }
}

async function testLoadSubstitutesPlaceholder(): Promise<void> {
  const prompt = loadBuilderPrompt(".agentify/runtime/audit-b");
  // `<stateDir>` must not survive a successful substitution.
  assert.ok(!prompt.includes("<stateDir>"), "loadBuilderPrompt failed to substitute");
  // And the resolved state dir must be present.
  assert.ok(
    prompt.includes(".agentify/runtime/audit-b/"),
    "loadBuilderPrompt did not substitute the supplied stateDir",
  );
}

async function testPromptRequiresInitialMapBeforeExplorers(): Promise<void> {
  const raw = readRawBuilderPrompt();
  assert.match(
    raw,
    /After the four direct scout reads,\n  call `write_map_delta` with direct D1 topography evidence: include a\n  non-empty `skeleton\.top_level_tree`.*before\n  calling `spawn_explorer`\./s,
    "builder prompt must require complete D1 topology before explorer dispatch",
  );
}

async function testPromptUsesConfiguredExplorerModelByDefault(): Promise<void> {
  const raw = readRawBuilderPrompt();
  assert.match(
    raw,
    /Every explorer uses the configured explorer model slot/,
    "builder prompt must keep explorer dispatches on the configured model slot by default",
  );
  assert.doesNotMatch(
    raw,
    /`model` = sonnet for most features, haiku for trivial/,
    "builder prompt must not hard-code Anthropic model literals",
  );
}

async function testPromptKeepsExplorerDispatchBounded(): Promise<void> {
  const raw = readRawBuilderPrompt();
  assert.ok(
    raw.indexOf("### Concern discovery") < raw.indexOf("### Cross-cutting evidence"),
    "required concern discovery must precede optional cross-cutting explorer work",
  );
  assert.match(
    raw,
    /dispatch one\nhigh-value feature explorer\. Read and merge its report before dispatching the\nnext one/,
    "builder prompt must gather and use evidence before dispatching more explorers",
  );
  // Concern discovery is the audit's reason for existing, so the prompt must
  // dispatch the scout once and one tracer per candidate rather than leaving
  // specialties to whatever the structural explorers happened to notice.
  assert.match(
    raw,
    /Run `concern_scout` against the repository root exactly once/,
    "builder prompt must dispatch the concern scout",
  );
  assert.match(
    raw,
    /run `concern_tracer` with the proposal's\n   exact name in `concern`/,
    "builder prompt must trace each candidate concern",
  );
  assert.match(
    raw,
    /After the scout.*write_map_delta.*Agentify rejects renamed reports, validates each complete report, and\n   checkpoints it directly; do not retranscribe it/s,
    "builder prompt must checkpoint scout decisions without retranscribing validated tracer bodies",
  );
  assert.match(
    raw,
    /subsumed.*public type surface.*release or contribution process/s,
    "builder prompt must screen overlapping, surface-only, and process-only candidates before tracing",
  );
  assert.match(
    raw,
    /A concern is a body of knowledge, not a folder/,
    "builder prompt must state that concerns are not directories",
  );
  const budget = raw.match(
    /at most 24 explorers per\n+audit, three independent explorers active at once, and ([a-z]+) minutes per explorer/,
  );
  assert.ok(budget, "builder prompt must disclose the finite explorer budget");
  const timeoutWord = budget[1]?.toLowerCase();
  assert.ok(timeoutWord, "builder prompt must name the explorer timeout");
  const promptTimeoutMinutes = SMALL_NUMBER_WORDS[timeoutWord];
  if (promptTimeoutMinutes === undefined) {
    assert.fail(`builder prompt uses an unrecognized timeout word: ${timeoutWord}`);
  }
  assert.equal(
    promptTimeoutMinutes * 60_000,
    DEFAULT_SUBAGENT_TIMEOUT_MS,
    "builder prompt timeout must match the spawn_explorer runtime default",
  );
  assert.doesNotMatch(
    raw,
    /There is no\nparallel cap and no hard action limit/,
    "builder prompt must not invite unbounded explorer dispatch",
  );
}

async function testPromptDoesNotRequestUnavailableInternalTemplate(): Promise<void> {
  const raw = readRawBuilderPrompt();
  assert.match(
    raw,
    /Do \*\*not\*\* try to read package-internal prompt templates or package-internal\npaths from the target repository/,
    "builder prompt must keep package-internal prompt assets outside the target-repository audit",
  );
  assert.doesNotMatch(
    raw,
    /_template\.md|GRADE2_DIR/,
    "builder prompt must not name removed or package-internal implementation assets",
  );
}

function readRawGapFillerPrompt(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(here, "../../src/core/audit/prompts/explorers/gap_filler.md");
  return fs.readFileSync(promptPath, "utf-8").replaceAll("\r\n", "\n");
}

function readExplorerPrompt(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(here, `../../src/core/audit/prompts/explorers/${name}.md`);
  return fs.readFileSync(promptPath, "utf-8").replaceAll("\r\n", "\n");
}

async function testConcernPromptsRespectFileLevelCoreOwnership(): Promise<void> {
  const builder = readRawBuilderPrompt();
  const scout = readExplorerPrompt("concern_scout");
  const tracer = readExplorerPrompt("concern_tracer");
  assert.doesNotMatch(tracer, /2–5 invariants|2–5 pitfalls|A concern with fifteen/,
    "field and core-path quotas cannot substitute for behavioral evidence");
  assert.match(tracer, /counterexample input or state/,
    "tracers must check the direction and preconditions of their claims");
  for (const [name, prompt] of [["builder", builder], ["scout", scout]] as const) {
    assert.match(
      prompt,
      /same sole tracked\s+implementation file[\s\S]*group[^.]*broader behavioral concern/i,
      `${name} prompt must group proposals that cannot have independent file-level core ownership`,
    );
  }
  assert.match(
    tracer,
    /exactly one specialist\s+may core-own a shared tracked file/i,
    "tracer prompt must treat core ownership as portfolio-wide and file-level",
  );
  assert.match(
    tracer,
    /independent tracked\s+implementation file[\s\S]*core/i,
    "tracer prompt must prefer concern-specific implementation ownership over shared orchestration",
  );
}

async function testPromptMatchesSubstanceGateForSmallRepositories(): Promise<void> {
  const raw = readRawBuilderPrompt();
  assert.match(
    raw,
    /\*\*D3_type_contract:\*\* one observed contract is sufficient[\s\S]*Never leave every contract field\n  empty merely because the repository has fewer than three types/,
    "builder prompt must accept one real contract and require it to be recorded",
  );
  assert.match(
    raw,
    /\*\*D8_security:\*\*[\s\S]*at\n  least one evidence-backed `bash_blocked_patterns` or `damage_control_rules`/,
    "builder prompt must require security damage-control substance",
  );
  assert.match(
    raw,
    /typed top-level\n  `observed_type_contract: \{ kind, path, name, fields \}` parameter/,
    "builder prompt must direct D3 repair through the structured contract input",
  );
  assert.doesNotMatch(
    raw,
    /Honest `null` is `covered`/,
    "builder prompt must not contradict the application-owned substance gate",
  );
}

async function testGapFillerMatchesSubstanceGateForSmallRepositories(): Promise<void> {
  const raw = readRawGapFillerPrompt();
  const securitySection = raw.match(/### D8_security([\s\S]*?)### D9_process/)?.[1] ?? "";
  assert.match(
    raw,
    /One real interface\/model\/schema is sufficient in a small\n  repository/,
    "gap filler must not impose a three-type threshold on small repositories",
  );
  assert.match(
    raw,
    /typed top-level `observed_type_contract: \{ kind, path, name, fields \}`\n  parameter/,
    "gap filler must expose the structured D3 repair path",
  );
  assert.match(
    securitySection,
    /at least one explicit\n evidence-backed blocked pattern or damage-control rule/,
    "gap filler must require the security substance enforced by the runtime",
  );
  assert.doesNotMatch(
    securitySection,
    /dimension is still `covered`/,
    "gap filler must not promote an empty security surface",
  );
}

async function main(): Promise<void> {
  await testSourcePromptHasStateDirPlaceholder();
  await testSourcePromptHasNoHardcodedAgentify();
  await testLoadSubstitutesPlaceholder();
  await testPromptRequiresInitialMapBeforeExplorers();
  await testPromptUsesConfiguredExplorerModelByDefault();
  await testPromptKeepsExplorerDispatchBounded();
  await testPromptDoesNotRequestUnavailableInternalTemplate();
  await testPromptMatchesSubstanceGateForSmallRepositories();
  await testGapFillerMatchesSubstanceGateForSmallRepositories();
  await testConcernPromptsRespectFileLevelCoreOwnership();
  // eslint-disable-next-line no-console
  console.log("builder-prompt-state-dir: all 10 checks passed");
}

await main();
