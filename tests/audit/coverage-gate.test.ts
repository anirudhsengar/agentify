// Tests for the code-enforced coverage gate: success and export
// must depend on the validated codebase map, not on file existence
// alone.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENTS_MD_MAX_LINES,
  assessCoverageClosure,
  COVERAGE_DIMENSIONS,
} from "../../src/core/audit/schema.ts";
import { createWriteMapTools, loadCanonicalMapAt } from "../../src/core/audit/write-map-tool.ts";
import { runAgentify } from "../../src/core/run-agentify.ts";
import { authPath, defaultConfigDir, saveAgentifyConfig } from "../../src/core/agentify-config.ts";
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
  async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("no prompt"); }
  async promptSecret(): Promise<string> { throw new Error("no prompt"); }
}

function writeArtifacts(
  cwd: string,
  stateDir: string,
  opts: { map?: unknown; agentsMdLines?: number } = {},
): void {
  fs.mkdirSync(path.join(cwd, "specs"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "ai_docs"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(path.join(cwd, stateDir), { recursive: true });
  const lines = opts.agentsMdLines ?? 5;
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n");
  fs.writeFileSync(path.join(cwd, "specs", "README.md"), "# Specs\n");
  fs.writeFileSync(path.join(cwd, "ai_docs", "README.md"), "# AI Docs\n");
  if (opts.map !== undefined) {
    fs.writeFileSync(
      path.join(cwd, stateDir, "codebase_map.json"),
      JSON.stringify(opts.map, null, 2),
    );
  }
}

class ScriptedRuntime implements AgentRuntime {
  constructor(private readonly write: (cwd: string, stateDir: string) => void) {}
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    assert.ok(options.spawnExplorerStateDir);
    this.write(options.cwd, options.spawnExplorerStateDir);
    return { turns: 1, costUsd: null, aborted: false };
  }
  async runGreenfield(): Promise<AgentRuntimeResult> {
    throw new Error("greenfield not used here");
  }
}

async function run(
  cwd: string,
  write: (cwd: string, stateDir: string) => void,
): Promise<SilentUi> {
  const prevHome = process.env["HOME"];
  const tempHome = tempDir("gate-run-home");
  process.env["HOME"] = tempHome;
  try {
    saveAgentifyConfig(defaultConfigDir(), { provider: "openai", thinkingLevel: "high" });
    fs.writeFileSync(authPath(defaultConfigDir()), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));
    const ui = new SilentUi();
    await runAgentify({
      cwd,
      ui,
      runtime: new ScriptedRuntime(write),
      targets: ["codex"],
      mode: "brownfield",
      githubReadinessOverride: READY_GITHUB,
    });
    return ui;
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
  }
}

async function runWithState(
  cwd: string,
  write: (cwd: string, stateDir: string) => void,
): Promise<{ ui: SilentUi; configDir: string }> {
  const prevHome = process.env["HOME"];
  const tempHome = tempDir("gate-state-home");
  process.env["HOME"] = tempHome;
  try {
    const configDir = defaultConfigDir();
    saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
    fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));
    const ui = new SilentUi();
    await runAgentify({
      cwd,
      ui,
      runtime: new ScriptedRuntime(write),
      targets: ["codex", "claude", "pi"],
      mode: "brownfield",
      githubReadinessOverride: READY_GITHUB,
    });
    return { ui, configDir };
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
  }
}

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

function testClosureRejectsWeakDimensionEvidence(): void {
  const cases: Array<{
    dim: (typeof COVERAGE_DIMENSIONS)[number];
    mutate: (map: ReturnType<typeof makeValidCodebaseMap>) => void;
    reason: RegExp;
  }> = [
    { dim: "D1_topography", mutate: (map) => { map.skeleton.entry_points = []; }, reason: /entry point/i },
    { dim: "D2_module_boundaries", mutate: (map) => { map.module_graph.edges = []; map.module_graph.parallelizable_subtrees = []; map.module_graph.shared_abstractions = []; }, reason: /module/i },
    { dim: "D3_type_contract", mutate: (map) => { map.type_contract_surface.idks = []; map.type_contract_surface.typescript_interfaces = []; map.type_contract_surface.pydantic_models = []; map.type_contract_surface.db_models = []; map.type_contract_surface.stable_types = []; map.type_contract_surface.one_type_trace = null; }, reason: /type|contract/i },
    { dim: "D4_conventions", mutate: (map) => { map.conventions.naming.files = ""; }, reason: /convention|naming/i },
    { dim: "D5_pitfalls", mutate: (map) => { map.pitfalls = []; }, reason: /pitfall/i },
    { dim: "D6_validation", mutate: (map) => { map.validation_surface.test_command = ""; map.validation_surface.per_change_type.chore.mandatory = []; map.validation_surface.per_change_type.bug.mandatory = []; map.validation_surface.per_change_type.feature.mandatory = []; }, reason: /validation|test/i },
    { dim: "D7_operational", mutate: (map) => { map.operational_surface.run.command = ""; }, reason: /run|operational/i },
    { dim: "D8_security", mutate: (map) => { map.security_surface.paths.zero_access = []; map.security_surface.bash_blocked_patterns = []; map.security_surface.damage_control_rules = []; }, reason: /security|zero-access/i },
    { dim: "D9_process", mutate: (map) => { map.meta.lifecycle.issue_types = []; }, reason: /process|issue/i },
    { dim: "D10_documentation", mutate: (map) => { map.meta.documentation.agents_md = null; map.meta.documentation.has_ai_docs = false; map.meta.documentation.has_app_docs = false; map.meta.documentation.has_specs = false; map.meta.documentation.readme_metrics = { present: false, line_count: 0, section_count: 0 }; }, reason: /doc/i },
  ];

  for (const testCase of cases) {
    const map = makeValidCodebaseMap();
    testCase.mutate(map);
    const result = assessCoverageClosure(map);
    assert.ok(result.unresolved.includes(testCase.dim), `${testCase.dim} should be unresolved`);
    assert.match(result.reasons[testCase.dim] ?? "", testCase.reason);
  }
}

async function testWriteMapReturnsClosureReasons(): Promise<void> {
  const cwd = tempDir("write-map-feedback");
  const map = makeValidCodebaseMap();
  map.validation_surface.test_command = "";
  const { writeMapTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  const result = await writeMapTool.execute("test-write-map", { map } as never, undefined, undefined, { cwd } as never);
  const text = result.content?.[0]?.type === "text" ? (result.content[0] as { type: "text"; text: string }).text : "";
  const details = result.details as { coverage_closure?: { unresolved?: string[]; reasons?: Record<string, string> } } | undefined;
  assert.match(text, /coverage dimensions closed/i);
  assert.ok(details?.coverage_closure?.unresolved?.includes("D6_validation"));
  assert.match(details?.coverage_closure?.reasons?.D6_validation ?? "", /validation command/i);
}

function testLoadCanonicalMapAtRejectsGarbage(): void {
  const cwd = tempDir("loadmap");
  fs.mkdirSync(path.join(cwd, ".pi", "agentify"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "agentify", "codebase_map.json"), "{ not json");
  assert.equal(loadCanonicalMapAt(cwd, ".pi/agentify"), null);
  fs.writeFileSync(path.join(cwd, ".pi", "agentify", "codebase_map.json"), JSON.stringify({ meta: {} }));
  assert.equal(loadCanonicalMapAt(cwd, ".pi/agentify"), null);
  fs.writeFileSync(path.join(cwd, ".pi", "agentify", "codebase_map.json"), JSON.stringify(makeValidCodebaseMap()));
  assert.ok(loadCanonicalMapAt(cwd, ".pi/agentify") !== null);
}

async function testNoMapMeansPartialNoExport(): Promise<void> {
  const cwd = tempDir("gate-nomap");
  const ui = await run(cwd, (c, stateDir) => writeArtifacts(c, stateDir, {}));
  assert.ok(!fs.existsSync(path.join(cwd, ".codex")));
  assert.ok(!fs.existsSync(path.join(cwd, "AGENTS.md")));
  assert.ok(!fs.existsSync(path.join(cwd, "specs", "README.md")));
  assert.ok(!fs.existsSync(path.join(cwd, "ai_docs", "README.md")));
  assert.ok(ui.errors.some((m) => m.includes("did not complete")));
}

async function testGapMapMeansPartialNoExport(): Promise<void> {
  const cwd = tempDir("gate-gap");
  const gapMap = makeValidCodebaseMap();
  gapMap.coverage.D6_validation = { status: "gap", confidence: "low", evidence_summary: "todo" };
  const ui = await run(cwd, (c, stateDir) => writeArtifacts(c, stateDir, { map: gapMap }));
  assert.ok(!fs.existsSync(path.join(cwd, ".codex")));
  assert.ok(ui.errors.some((m) => m.includes("D6_validation")));
}

async function testOversizedAgentsMdMeansPartial(): Promise<void> {
  const cwd = tempDir("gate-oversize");
  const ui = await run(cwd, (c, stateDir) => writeArtifacts(c, stateDir, { map: makeValidCodebaseMap(), agentsMdLines: AGENTS_MD_MAX_LINES + 5 }));
  assert.ok(!fs.existsSync(path.join(cwd, ".codex")));
  assert.ok(ui.errors.some((m) => m.includes("line cap")));
}

async function testFullyCoveredMeansSuccessAndPersistsMap(): Promise<void> {
  const cwd = tempDir("gate-ok");
  const ui = await run(cwd, (c, stateDir) => {
    writeArtifacts(c, stateDir, { map: makeValidCodebaseMap() });
    fs.writeFileSync(path.join(c, ".pi", "agents", "payments.md"), "---\nname: payments\ndescription: x\n---\n\nUse.\n");
  });
  assert.ok(fs.existsSync(path.join(cwd, ".codex")));
  assert.ok(fs.existsSync(path.join(cwd, ".agents", "agentify", "codebase_map.json")));
  assert.ok(ui.infos.some((m) => m.includes("audit complete")));
}

async function testUserOwnedAgentsMdBlocksClaudeExport(): Promise<void> {
  const cwd = tempDir("gate-user-agents");
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# User owned\n");
  const { ui, configDir } = await runWithState(cwd, (c, stateDir) => writeArtifacts(c, stateDir, { map: makeValidCodebaseMap() }));
  assert.equal(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf-8"), "# User owned\n");
  assert.ok(!fs.existsSync(path.join(cwd, "CLAUDE.md")));
  assert.ok(ui.errors.some((m) => m.includes("required generated file conflict")));
  assert.equal(readProjectState(configDir, cwd)?.repoStatus, "partial");
}

async function testUserOwnedWorkflowConflictPersistsPartial(): Promise<void> {
  const cwd = tempDir("gate-workflow-conflict");
  const workflow = path.join(cwd, ".github", "workflows", "agent-implement.yml");
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  fs.writeFileSync(workflow, "name: user-owned\n");
  const { configDir } = await runWithState(cwd, (c, stateDir) => writeArtifacts(c, stateDir, { map: makeValidCodebaseMap() }));
  assert.equal(readProjectState(configDir, cwd)?.repoStatus, "partial");
  assert.equal(readProjectState(configDir, cwd)?.runStatus, "partial");
  assert.equal(fs.readFileSync(workflow, "utf-8"), "name: user-owned\n");
}

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [
  { name: "closureAllCovered", fn: testClosureAllCovered },
  { name: "closureRejectsEmptyEvidence", fn: testClosureRejectsEmptyEvidence },
  { name: "closureRejectsPitfallsWithoutSubstance", fn: testClosureRejectsPitfallsWithoutSubstance },
  { name: "closureRejectsGapStatus", fn: testClosureRejectsGapStatus },
  { name: "closureRejectsWeakDimensionEvidence", fn: testClosureRejectsWeakDimensionEvidence },
  { name: "writeMapReturnsClosureReasons", fn: testWriteMapReturnsClosureReasons },
  { name: "loadCanonicalMapRejectsGarbage", fn: testLoadCanonicalMapAtRejectsGarbage },
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
