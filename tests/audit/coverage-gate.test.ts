// Tests for the code-enforced coverage gate (ADR 0014): success and
// export must depend on the validated codebase map, not on file
// existence alone.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENTS_MD_MAX_LINES,
  assessCoverageClosure,
  COVERAGE_DIMENSIONS,
} from "../../src/core/audit/schema.ts";
import { loadCanonicalMap } from "../../src/core/audit/write-map-tool.ts";
import { runAgentify } from "../../src/core/run-agentify.ts";
import { saveAgentifyConfig, authPath } from "../../src/core/agentify-config.ts";
import { readProjectState } from "../../src/core/project-state.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
  AgentifyUi,
  GitHubReadiness,
} from "../../src/core/types.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

const READY_GITHUB: GitHubReadiness = {
  hasGitDirectory: true,
  hasGitHubRemote: true,
  originUrl: "git@github.com:owner/repo.git",
  ghCliAvailable: true,
  guidance: ["ready"],
};

class SilentUi implements AgentifyUi {
  infos: string[] = [];
  errors: string[] = [];
  status(): void {}
  info(m: string): void { this.infos.push(m); }
  error(m: string): void { this.errors.push(m); }
  async promptSelect(): Promise<string> { throw new Error("no prompt"); }
  async promptSecret(): Promise<string> { throw new Error("no prompt"); }
}

function writeArtifacts(cwd: string, opts: { map?: unknown; agentsMdLines?: number } = {}): void {
  fs.mkdirSync(path.join(cwd, "specs"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "ai_docs"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi", "agentify"), { recursive: true });
  const lines = opts.agentsMdLines ?? 5;
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n");
  fs.writeFileSync(path.join(cwd, "specs", "README.md"), "# Specs\n");
  fs.writeFileSync(path.join(cwd, "ai_docs", "README.md"), "# AI Docs\n");
  if (opts.map !== undefined) {
    fs.writeFileSync(
      path.join(cwd, ".pi", "agentify", "codebase_map.json"),
      JSON.stringify(opts.map, null, 2),
    );
  }
}

function makeConfiguredConfigDir(): string {
  const configDir = tempDir("gate-config");
  saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
  fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));
  return configDir;
}

class ScriptedRuntime implements AgentRuntime {
  constructor(private readonly write: (cwd: string) => void) {}
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    this.write(options.cwd);
    return { turns: 1, costUsd: null, aborted: false };
  }
  async runGreenfield(): Promise<AgentRuntimeResult> {
    throw new Error("greenfield not used here");
  }
}

async function run(cwd: string, write: (cwd: string) => void): Promise<SilentUi> {
  const configDir = makeConfiguredConfigDir();
  const ui = new SilentUi();
  await runAgentify({
    cwd,
    configDir,
    ui,
    runtime: new ScriptedRuntime(write),
    targets: ["codex"],
    assumeProjectKind: "brownfield",
    githubReadinessOverride: READY_GITHUB,
  });
  return ui;
}

async function runWithState(cwd: string, write: (cwd: string) => void): Promise<{ ui: SilentUi; configDir: string }> {
  const configDir = makeConfiguredConfigDir();
  const ui = new SilentUi();
  await runAgentify({
    cwd,
    configDir,
    ui,
    runtime: new ScriptedRuntime(write),
    targets: ["codex", "claude", "pi"],
    assumeProjectKind: "brownfield",
    githubReadinessOverride: READY_GITHUB,
  });
  return { ui, configDir };
}

// --- assessCoverageClosure -------------------------------------------------

function testClosureAllCovered(): void {
  const result = assessCoverageClosure(makeValidCodebaseMap());
  assert.equal(result.unresolved.length, 0, JSON.stringify(result.reasons));
  assert.equal(result.closed.length, COVERAGE_DIMENSIONS.length);
}

function testClosureRejectsEmptyEvidence(): void {
  const map = makeValidCodebaseMap();
  map.coverage.D4_conventions = { status: "covered", confidence: "high", evidence_summary: "  " };
  const result = assessCoverageClosure(map);
  assert.ok(result.unresolved.includes("D4_conventions"));
  assert.match(result.reasons.D4_conventions ?? "", /evidence_summary/);
}

function testClosureRejectsPitfallsWithoutSubstance(): void {
  const map = makeValidCodebaseMap();
  map.pitfalls = [];
  const result = assessCoverageClosure(map);
  assert.ok(result.unresolved.includes("D5_pitfalls"));
}

function testClosureRejectsGapStatus(): void {
  const map = makeValidCodebaseMap();
  map.coverage.D8_security = { status: "gap", confidence: "low", evidence_summary: "unknown" };
  const result = assessCoverageClosure(map);
  assert.ok(result.unresolved.includes("D8_security"));
}

// --- loadCanonicalMap ------------------------------------------------------

function testLoadCanonicalMapRejectsGarbage(): void {
  const cwd = tempDir("loadmap");
  fs.mkdirSync(path.join(cwd, ".pi", "agentify"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "agentify", "codebase_map.json"), "{ not json");
  assert.equal(loadCanonicalMap(cwd), null);
  fs.writeFileSync(path.join(cwd, ".pi", "agentify", "codebase_map.json"), JSON.stringify({ meta: {} }));
  assert.equal(loadCanonicalMap(cwd), null);
  fs.writeFileSync(
    path.join(cwd, ".pi", "agentify", "codebase_map.json"),
    JSON.stringify(makeValidCodebaseMap()),
  );
  assert.ok(loadCanonicalMap(cwd) !== null);
}

// --- end-to-end gate through runAgentify -----------------------------------

async function testNoMapMeansPartialNoExport(): Promise<void> {
  const cwd = tempDir("gate-nomap");
  const ui = await run(cwd, (c) => writeArtifacts(c, { /* no map */ }));
  assert.ok(!fs.existsSync(path.join(cwd, ".codex")), "must not export without a map");
  assert.ok(!fs.existsSync(path.join(cwd, "AGENTS.md")), "partial audit must roll back AGENTS.md");
  assert.ok(!fs.existsSync(path.join(cwd, "specs", "README.md")), "partial audit must roll back specs README");
  assert.ok(!fs.existsSync(path.join(cwd, "ai_docs", "README.md")), "partial audit must roll back ai_docs README");
  assert.ok(ui.errors.some((m) => m.includes("did not complete")));
}

async function testGapMapMeansPartialNoExport(): Promise<void> {
  const cwd = tempDir("gate-gap");
  const gapMap = makeValidCodebaseMap();
  gapMap.coverage.D6_validation = { status: "gap", confidence: "low", evidence_summary: "todo" };
  const ui = await run(cwd, (c) => writeArtifacts(c, { map: gapMap }));
  assert.ok(!fs.existsSync(path.join(cwd, ".codex")), "gap map must not export");
  assert.ok(ui.errors.some((m) => m.includes("D6_validation")));
}

async function testOversizedAgentsMdMeansPartial(): Promise<void> {
  const cwd = tempDir("gate-oversize");
  const ui = await run(cwd, (c) =>
    writeArtifacts(c, { map: makeValidCodebaseMap(), agentsMdLines: AGENTS_MD_MAX_LINES + 5 }),
  );
  assert.ok(!fs.existsSync(path.join(cwd, ".codex")), "oversized AGENTS.md must not export");
  assert.ok(ui.errors.some((m) => m.includes("line cap")));
}

async function testFullyCoveredMeansSuccessAndPersistsMap(): Promise<void> {
  const cwd = tempDir("gate-ok");
  const ui = await run(cwd, (c) => {
    writeArtifacts(c, { map: makeValidCodebaseMap() });
    fs.writeFileSync(
      path.join(c, ".pi", "agents", "payments.md"),
      "---\nname: payments\ndescription: x\n---\n\nUse.\n",
    );
  });
  assert.ok(fs.existsSync(path.join(cwd, ".codex")), "covered map must export");
  assert.ok(
    fs.existsSync(path.join(cwd, ".pi", "agentify", "codebase_map.json")),
    "canonical map must be preserved after the run",
  );
  assert.ok(ui.infos.some((m) => m.includes("audit complete")));
}

async function testUserOwnedAgentsMdBlocksClaudeExport(): Promise<void> {
  const cwd = tempDir("gate-user-agents");
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# User owned\n");
  const { ui, configDir } = await runWithState(cwd, (c) => {
    writeArtifacts(c, { map: makeValidCodebaseMap() });
  });
  assert.equal(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf-8"), "# User owned\n");
  assert.ok(!fs.existsSync(path.join(cwd, "CLAUDE.md")), "must not copy user-owned AGENTS.md to CLAUDE.md");
  assert.ok(ui.errors.some((m) => m.includes("required generated file conflict")));
  assert.equal(readProjectState(configDir, cwd)?.repoStatus, "partial");
}

async function testUserOwnedWorkflowConflictPersistsPartial(): Promise<void> {
  const cwd = tempDir("gate-workflow-conflict");
  const workflow = path.join(cwd, ".github", "workflows", "agent-implement.yml");
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  fs.writeFileSync(workflow, "name: user-owned\n");
  const { configDir } = await runWithState(cwd, (c) => {
    writeArtifacts(c, { map: makeValidCodebaseMap() });
  });
  assert.equal(readProjectState(configDir, cwd)?.repoStatus, "partial");
  assert.equal(readProjectState(configDir, cwd)?.runStatus, "partial");
  assert.equal(fs.readFileSync(workflow, "utf-8"), "name: user-owned\n");
}

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [
  { name: "closureAllCovered", fn: testClosureAllCovered },
  { name: "closureRejectsEmptyEvidence", fn: testClosureRejectsEmptyEvidence },
  { name: "closureRejectsPitfallsWithoutSubstance", fn: testClosureRejectsPitfallsWithoutSubstance },
  { name: "closureRejectsGapStatus", fn: testClosureRejectsGapStatus },
  { name: "loadCanonicalMapRejectsGarbage", fn: testLoadCanonicalMapRejectsGarbage },
  { name: "noMapMeansPartialNoExport", fn: testNoMapMeansPartialNoExport },
  { name: "gapMapMeansPartialNoExport", fn: testGapMapMeansPartialNoExport },
  { name: "oversizedAgentsMdMeansPartial", fn: testOversizedAgentsMdMeansPartial },
  { name: "fullyCoveredMeansSuccessAndPersistsMap", fn: testFullyCoveredMeansSuccessAndPersistsMap },
  { name: "userOwnedAgentsMdBlocksClaudeExport", fn: testUserOwnedAgentsMdBlocksClaudeExport },
  { name: "userOwnedWorkflowConflictPersistsPartial", fn: testUserOwnedWorkflowConflictPersistsPartial },
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
console.log(`coverage-gate tests passed (${passed}/${tests.length}).`);
