// Tests for the code-enforced coverage gate: audit completion must depend on
// the validated codebase map, not on unrelated generated-file existence.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assessAuditCompletion,
  assessCoverageClosure,
  COVERAGE_DIMENSIONS,
  specialistEvidenceRecorded,
} from "../../src/core/audit/schema.ts";
import { createWriteMapTools, loadCanonicalMapAt } from "../../src/core/audit/write-map-tool.ts";
import { runAgentifyApp } from "../../src/core/agentify-app.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
  AgentifyUi,
} from "../../src/core/types.ts";
import { attestCodebaseMap, makeValidCodebaseMap } from "../fixtures/codebase-map.ts";
import { concernEvidencePaths } from "../../src/core/audit/specialist-completion.ts";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

class SilentUi implements AgentifyUi {
  infos: string[] = [];
  errors: string[] = [];
  status(): void {}
  info(m: string): void { this.infos.push(m); }
  error(m: string): void { this.errors.push(m); }
  async promptSelect(): Promise<string> { throw new Error("no prompt"); }
  async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("no prompt"); }
  async promptCheckboxList(): Promise<ReadonlyArray<string>> { throw new Error("no prompt"); }
  async promptSecret(): Promise<string> { throw new Error("no prompt"); }
  async promptText(): Promise<string> { throw new Error("no prompt"); }
}

/**
 * `runAgentifyApp` now issues a cheap tool-free reachability probe before
 * the real audit session. Test doubles below only model the real audit
 * call's contract (spawnExplorerStateDir, recoveryPromptIfToolNotCalled,
 * etc.), so they short-circuit the probe with a trivial success.
 */
function isProbeCall(options: AgentRuntimeSessionOptions): boolean {
  return options.tools.length === 0;
}

async function testEveryModelRequestBelongsToTheAuditBudget(): Promise<void> {
  const cwd = tempDir("gate-accounted-model-entry");
  let calls = 0;
  try {
    const runtime: AgentRuntime = {
      async runSession(options) {
        calls += 1;
        assert.ok(options.auditResourceBudget, "normal installation must not make an unaccounted connectivity request");
        assert.ok(options.onProviderRequest);
        options.onProviderRequest();
        options.onEvent?.({ type: "message_end", message: {
          role: "assistant", stopReason: "stop", usage: { input: 8, output: 2, cost: { total: 0.01 } },
        } } as never);
        return new CoverageClosureRuntime().runSession(options);
      },
    };
    await runWithRuntime(cwd, runtime);
    assert.equal(calls, 1, "the first real audit request also establishes provider reachability");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function writeMap(cwd: string, stateDir: string, map: unknown): void {
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "Test fixture evidence citation.");
  fs.mkdirSync(path.join(cwd, stateDir), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, stateDir, "codebase_map.json"),
    JSON.stringify(map, null, 2),
  );
}

function emitExplorerReceipts(
  options: AgentRuntimeSessionOptions,
  map: NonNullable<ReturnType<typeof loadCanonicalMapAt>>,
): void {
  options.onEvent?.({
    type: "tool_execution_end",
    toolName: "spawn_explorer",
    resultText: "Sub-agent (mode=concern_scout) explored . in 1ms.\n\n## Report\n",
    details: {
      mode: "concern_scout",
      target_path: ".",
      focus: null,
      report_concern: null,
    },
  } as never);
  for (const concern of map.concern_evidence?.concerns ?? []) {
    options.onEvent?.({
      type: "tool_execution_end",
      toolName: "spawn_explorer",
      resultText: `Sub-agent (mode=concern_tracer) explored . in 1ms.\n\n## Report\nconcern: ${concern.concern}\n`,
      details: {
        mode: "concern_tracer",
        target_path: ".",
        focus: concern.concern,
        report_concern: concern.concern,
        observed_paths: concernEvidencePaths(concern),
      },
    } as never);
  }
}

class ScriptedRuntime implements AgentRuntime {
  constructor(private readonly write: (cwd: string, stateDir: string) => void) {}
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    if (isProbeCall(options)) return { turns: 1, costUsd: null, aborted: false };
    assert.ok(options.spawnExplorerStateDir);
    this.write(options.cwd, options.spawnExplorerStateDir);
    const map = loadCanonicalMapAt(options.cwd, options.spawnExplorerStateDir);
    if (map !== null) emitExplorerReceipts(options, map);
    return { turns: 1, costUsd: null, aborted: false };
  }
}

class CoverageClosureRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    if (isProbeCall(options)) return { turns: 1, costUsd: null, aborted: false };
    const map = makeValidCodebaseMap();
    writeMap(
      options.cwd,
      options.spawnExplorerStateDir ?? ".agentify/runtime/audit",
      map,
    );
    emitExplorerReceipts(options, map);
    options.onEvent?.({ type: "message_end" } as never);
    return { turns: 1, costUsd: null, aborted: true };
  }
}

async function run(
  cwd: string,
  write: (cwd: string, stateDir: string) => void,
): Promise<SilentUi> {
  return runWithRuntime(cwd, new ScriptedRuntime(write));
}

function ensureGitRepository(cwd: string): string {
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    fs.mkdirSync(cwd, { recursive: true });
    if (!fs.existsSync(path.join(cwd, "README.md"))) {
      fs.writeFileSync(path.join(cwd, "README.md"), "Test fixture evidence citation.\n");
    }
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Agentify Test"],
      ["config", "user.email", "agentify@example.invalid"],
      ["add", "."],
      ["commit", "-qm", "coverage gate fixture"],
    ]) {
      const execution = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
    }
  }
  const head = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  return head.stdout.trim();
}

async function runWithRuntime(
  cwd: string,
  runtime: AgentRuntime,
  auditBudgets?: { maxSessionDurationMs: number },
): Promise<SilentUi> {
  ensureGitRepository(cwd);
  const previousHome = process.env["HOME"];
  const tempHome = tempDir("gate-run-home");
  process.env["HOME"] = tempHome;
  try {
    const ui = new SilentUi();
    await runAgentifyApp({
      args: [],
      cwd,
      ui,
      runtime,
      configOverride: {
        schemaVersion: 1,
        provider: "openai",
        thinkingLevel: "high",
        models: {},
        ...(auditBudgets ? { auditBudgets } : {}),
      },
    });
    return ui;
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

class RecoveryRuntime implements AgentRuntime {
  calls = 0;

  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    if (isProbeCall(options)) return { turns: 1, costUsd: null, aborted: false };
    this.calls += 1;
    assert.ok(options.recoveryPromptIfToolNotCalled);
    assert.equal(options.recoveryPromptIfToolNotCalled.requiredToolName, "write_map_delta");
    assert.equal(options.recoveryPromptIfToolNotCalled.maxAttempts, 2);
    assert.equal(options.recoveryPromptIfToolNotCalled.shouldRecover?.(), true);
    assert.ok(options.spawnExplorerStateDir);
    const map = makeValidCodebaseMap();
    writeMap(options.cwd, options.spawnExplorerStateDir, map);
    emitExplorerReceipts(options, map);
    return { turns: 1, costUsd: null, aborted: false };
  }
}

class BootstrapRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    if (isProbeCall(options)) return { turns: 1, costUsd: null, aborted: false };
    const stateDir = options.spawnExplorerStateDir;
    assert.ok(stateDir);
    const draft = JSON.parse(fs.readFileSync(path.join(options.cwd, stateDir, "codebase_map.json"), "utf-8")) as {
      coverage?: Record<string, { status?: string }>;
    };
    assert.equal(Object.keys(draft.coverage ?? {}).length, COVERAGE_DIMENSIONS.length);
    assert.ok(Object.values(draft.coverage ?? {}).every((entry) => entry.status === "gap"));
    assert.match(options.userPrompt, /write_map_delta/);
    assert.equal(options.recoveryPromptIfToolNotCalled?.requiredToolName, "write_map_delta");
    const map = makeValidCodebaseMap();
    writeMap(options.cwd, stateDir, map);
    emitExplorerReceipts(options, map);
    return { turns: 1, costUsd: null, aborted: false };
  }
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

function testClosureRejectsMissingEvidenceCitations(): void {
  const map = makeValidCodebaseMap();
  map.coverage.D4_conventions = {
    status: "covered",
    confidence: "high",
    evidence_summary: "Valid summary.",
    evidence: [],
  };
  const result = assessCoverageClosure(map);
  assert.ok(result.unresolved.includes("D4_conventions"));
  assert.match(result.reasons.D4_conventions ?? "", /no evidence citations were provided/);
}

function testClosureRejectsNonExistentPositiveEvidence(): void {
  const cwd = tempDir("evidence-positive-missing");
  try {
    const map = makeValidCodebaseMap();
    map.coverage.D1_topography = {
      status: "covered",
      confidence: "high",
      evidence_summary: "Topography documented.",
      evidence: [{ path: "nonexistent-file.ts", excerpt: "excerpt", kind: "positive" }],
    };
    const result = assessCoverageClosure(map, { cwd });
    assert.ok(result.unresolved.includes("D1_topography"));
    assert.match(result.reasons.D1_topography ?? "", /positive evidence path does not exist/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testClosureRejectsExistingAbsenceEvidence(): void {
  const cwd = tempDir("evidence-absence-exists");
  try {
    fs.writeFileSync(path.join(cwd, "existing.ts"), "content");
    const map = makeValidCodebaseMap();
    map.coverage.D9_process = {
      status: "covered",
      confidence: "high",
      evidence_summary: "No process documented.",
      evidence: [{ path: "existing.ts", excerpt: "Absence note", kind: "absence" }],
    };
    const result = assessCoverageClosure(map, { cwd });
    assert.ok(result.unresolved.includes("D9_process"));
    assert.match(result.reasons.D9_process ?? "", /absence evidence path exists/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testClosureUsesImmutableTrackedEvidence(): void {
  const cwd = tempDir("evidence-tracked-head");
  try {
    ensureGitRepository(cwd);
    fs.mkdirSync(path.join(cwd, ".agentify", "agents"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".agentify", "manifest.json"), "{}\n");
    fs.writeFileSync(path.join(cwd, ".env"), "dirty working-tree secret\n");
    const map = makeValidCodebaseMap();
    map.coverage.D9_process = {
      status: "covered",
      confidence: "high",
      evidence_summary: "Generated Agentify state describes the process.",
      evidence: [{
        path: ".agentify/manifest.json",
        excerpt: "agentify_team_memory",
        kind: "positive",
      }],
    };
    map.coverage.D8_security = {
      status: "covered",
      confidence: "high",
      evidence_summary: "No environment file is tracked at HEAD.",
      evidence: [{ path: ".env", excerpt: "No tracked .env file.", kind: "absence" }],
    };
    const result = assessCoverageClosure(map, { cwd });
    assert.ok(result.unresolved.includes("D9_process"));
    assert.match(result.reasons.D9_process ?? "", /Agentify-generated evidence path/i);
    assert.ok(!result.unresolved.includes("D8_security"), result.reasons.D8_security);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testClosureRejectsEscapingEvidenceCitation(): void {
  const cwd = tempDir("evidence-escaping");
  try {
    const map = makeValidCodebaseMap();
    map.coverage.D1_topography = {
      status: "covered",
      confidence: "high",
      evidence_summary: "Topography documented.",
      evidence: [{ path: "../../etc/passwd", excerpt: "root:x:0:0", kind: "positive" }],
    };
    const result = assessCoverageClosure(map, { cwd });
    assert.ok(result.unresolved.includes("D1_topography"));
    assert.match(result.reasons.D1_topography ?? "", /escapes repository root/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
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
    {
      dim: "D1_topography",
      mutate: (map) => { map.skeleton.entry_points = []; },
      reason: /entry point/i,
    },
    {
      dim: "D2_module_boundaries",
      mutate: (map) => {
        map.module_graph.edges = [];
        map.module_graph.parallelizable_subtrees = [];
        map.module_graph.shared_abstractions = [];
      },
      reason: /module/i,
    },
    {
      dim: "D3_type_contract",
      mutate: (map) => {
        map.type_contract_surface.idks = [];
        map.type_contract_surface.typescript_interfaces = [];
        map.type_contract_surface.pydantic_models = [];
        map.type_contract_surface.db_models = [];
        map.type_contract_surface.stable_types = [];
        map.type_contract_surface.one_type_trace = null;
      },
      reason: /type|contract/i,
    },
    {
      dim: "D4_conventions",
      mutate: (map) => { map.conventions.naming.files = ""; },
      reason: /convention|naming/i,
    },
    {
      dim: "D5_pitfalls",
      mutate: (map) => { map.pitfalls = []; },
      reason: /pitfall/i,
    },
    {
      dim: "D6_validation",
      mutate: (map) => {
        map.validation_surface.test_command = "";
        map.validation_surface.per_change_type.chore.mandatory = [];
        map.validation_surface.per_change_type.bug.mandatory = [];
        map.validation_surface.per_change_type.feature.mandatory = [];
      },
      reason: /validation|test/i,
    },
    {
      dim: "D7_operational",
      mutate: (map) => { map.operational_surface.run.command = ""; },
      reason: /run|operational/i,
    },
    {
      dim: "D8_security",
      mutate: (map) => {
        map.security_surface.paths.zero_access = [];
        map.security_surface.bash_blocked_patterns = [];
        map.security_surface.damage_control_rules = [];
      },
      reason: /security|zero-access/i,
    },
    {
      dim: "D9_process",
      mutate: (map) => { map.meta.lifecycle.issue_types = []; },
      reason: /process|issue/i,
    },
    {
      dim: "D10_documentation",
      mutate: (map) => {
        map.meta.documentation.agents_md = null;
        map.meta.documentation.has_ai_docs = false;
        map.meta.documentation.has_app_docs = false;
        map.meta.documentation.has_specs = false;
        map.meta.documentation.readme_metrics = { present: false, line_count: 0, section_count: 0 };
      },
      reason: /doc/i,
    },
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
  fs.writeFileSync(path.join(cwd, "README.md"), "Test fixture evidence citation.");
  const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  const map = makeValidCodebaseMap();
  map.validation_surface.test_command = "";
  const result = await writeMapTool.execute(
    "test-write-map",
    { map } as never,
    undefined,
    undefined,
    { cwd } as never,
  );

  const text =
    result.content?.[0]?.type === "text"
      ? (result.content[0] as { type: "text"; text: string }).text
      : "";
  const details = result.details as
    | {
        coverage_closure?: {
          unresolved?: string[];
          reasons?: Record<string, string>;
        };
      }
    | undefined;

  assert.match(text, /coverage dimensions closed/i);
  assert.ok(details?.coverage_closure?.unresolved?.includes("D6_validation"));
  assert.match(details?.coverage_closure?.reasons?.D6_validation ?? "", /validation command/i);
}

// --- explicit canonical map loading ----------------------------------------

function testLoadCanonicalMapAtRejectsGarbage(): void {
  const cwd = tempDir("loadmap");
  fs.mkdirSync(path.join(cwd, ".agentify", "runtime", "audit"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json"), "{ not json");
  assert.equal(loadCanonicalMapAt(cwd, ".agentify/runtime/audit"), null);
  fs.writeFileSync(path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json"), JSON.stringify({ meta: {} }));
  assert.equal(loadCanonicalMapAt(cwd, ".agentify/runtime/audit"), null);
  fs.writeFileSync(
    path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json"),
    JSON.stringify(makeValidCodebaseMap()),
  );
  assert.ok(loadCanonicalMapAt(cwd, ".agentify/runtime/audit") !== null);
}

// --- end-to-end gate through runAgentifyApp --------------------------------

async function testNoMapMeansPartialNoExport(): Promise<void> {
  const cwd = tempDir("gate-nomap");
  await assert.rejects(
    run(cwd, () => { /* runtime returns without a structured map update */ }),
    /did not reach structured closure/,
  );
  assert.ok(!fs.existsSync(path.join(cwd, ".codex")), "must not export without a map");
  assert.ok(fs.existsSync(path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json")));
}

async function testMissingWriteMapGetsOneRecoveryPass(): Promise<void> {
  const cwd = tempDir("gate-recovery");
  const runtime = new RecoveryRuntime();
  await runWithRuntime(cwd, runtime);
  assert.equal(runtime.calls, 1, "recovery must remain within the original session");
  assert.ok(fs.existsSync(path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json")));
}

async function testAuditBootstrapsGapDraftForIncrementalMapWrites(): Promise<void> {
  const cwd = tempDir("gate-bootstrap");
  await runWithRuntime(cwd, new BootstrapRuntime());
  assert.ok(fs.existsSync(path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json")));
}

async function testGapMapMeansPartialNoExport(): Promise<void> {
  const cwd = tempDir("gate-gap");
  const gapMap = makeValidCodebaseMap();
  gapMap.coverage.D6_validation = { status: "gap", confidence: "low", evidence_summary: "todo" };
  await assert.rejects(
    run(cwd, (c, stateDir) => writeMap(c, stateDir, gapMap)),
    /D6_validation/,
  );
  assert.ok(!fs.existsSync(path.join(cwd, ".codex")), "gap map must not export");
}

async function testFullyCoveredMeansSuccessAndPersistsMap(): Promise<void> {
  const cwd = tempDir("gate-ok");
  const ui = await run(cwd, (c, stateDir) => {
    writeMap(c, stateDir, makeValidCodebaseMap());
  });
  assert.ok(!fs.existsSync(path.join(cwd, ".codex")), "focused audit must not export harness state");
  assert.ok(
    fs.existsSync(path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json")),
    "vendor-neutral operational map must be preserved after the run",
  );
  assert.ok(ui.infos.some((m) => m.includes("validated codebase map")));
}

async function testIntentionalCoverageClosureIsNotReportedAsAbort(): Promise<void> {
  const cwd = tempDir("gate-coverage-stop");
  const ui = await runWithRuntime(cwd, new CoverageClosureRuntime());
  assert.ok(ui.infos.some((m) => m.includes("validated codebase map")));
}

// --- specialist evidence completion gate ------------------------------------

function testSpecialistEvidenceRequiredForCompletion(): void {
  const complete = makeValidCodebaseMap();
  const completion = assessAuditCompletion(complete);
  assert.equal(completion.complete, true, JSON.stringify(completion.coverage.reasons));
  assert.equal(completion.specialistEvidenceRecorded, true);

  const legacy = makeValidCodebaseMap();
  delete legacy.expert_evidence;
  const legacyCompletion = assessAuditCompletion(legacy);
  assert.equal(legacyCompletion.coverage.unresolved.length, 0, "coverage alone still closes");
  assert.equal(legacyCompletion.specialistEvidenceRecorded, false);
  assert.equal(legacyCompletion.complete, false, "completion must require recorded specialist evidence");

  const honestEmpty = makeValidCodebaseMap();
  honestEmpty.expert_evidence = { expert_domains: [] };
  assert.equal(specialistEvidenceRecorded(honestEmpty), true, "an honest empty list counts as recorded");
}

async function testWriteMapGuidesSpecialistEvidence(): Promise<void> {
  const cwd = tempDir("write-map-specialist-guidance");
  try {
    fs.writeFileSync(path.join(cwd, "README.md"), "Test fixture evidence citation.");
    const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });

    const withoutEvidence = makeValidCodebaseMap();
    delete withoutEvidence.expert_evidence;
    delete withoutEvidence.concern_evidence;
    const first = await writeMapTool.execute(
      "write-no-evidence",
      { map: withoutEvidence } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    const firstText = first.content?.[0]?.type === "text"
      ? (first.content[0] as { type: "text"; text: string }).text
      : "";
    const firstDetails = first.details as { specialist_evidence_recorded?: boolean } | undefined;
    assert.match(firstText, /All 10 coverage dimensions closed/);
    assert.match(firstText, /Concern evidence is not recorded yet/);
    assert.equal(firstDetails?.specialist_evidence_recorded, false);

    const second = await writeMapTool.execute(
      "write-with-evidence",
      { map: makeValidCodebaseMap() } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    const secondText = second.content?.[0]?.type === "text"
      ? (second.content[0] as { type: "text"; text: string }).text
      : "";
    const secondDetails = second.details as { specialist_evidence_recorded?: boolean } | undefined;
    assert.equal(secondDetails?.specialist_evidence_recorded, true);
    assert.ok(!secondText.includes("Concern evidence is not recorded yet"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

class TopUpRuntime implements AgentRuntime {
  auditCalls = 0;
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    if (isProbeCall(options)) return { turns: 1, costUsd: null, aborted: false };
    this.auditCalls += 1;
    assert.match(options.userPrompt, /concern_evidence/, "top-up audit prompt must request concern evidence");
    assert.match(options.userPrompt, /concern_scout/, "top-up audit prompt must dispatch concern discovery");
    assert.equal(options.recoveryPromptIfToolNotCalled?.requiredToolName, "write_map_delta");
    const map = makeValidCodebaseMap();
    writeMap(options.cwd, options.spawnExplorerStateDir ?? ".agentify/runtime/audit", map);
    emitExplorerReceipts(options, map);
    return { turns: 1, costUsd: null, aborted: false };
  }
}

class FailIfAuditRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    if (isProbeCall(options)) return { turns: 1, costUsd: null, aborted: false };
    throw new Error("audit session must not run when the existing map is complete with specialist evidence");
  }
}

class NoSpecialistEvidenceRuntime implements AgentRuntime {
  calls = 0;
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    if (isProbeCall(options)) return { turns: 1, costUsd: null, aborted: false };
    this.calls += 1;
    const map = makeValidCodebaseMap();
    delete map.expert_evidence;
    writeMap(options.cwd, options.spawnExplorerStateDir ?? ".agentify/runtime/audit", map);
    return { turns: 1, costUsd: null, aborted: false };
  }
}

class ReceiptCheckpointRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    if (isProbeCall(options)) return { turns: 1, costUsd: null, aborted: false };
    options.onEvent?.({
      type: "tool_execution_end",
      toolName: "spawn_explorer",
      resultText: "Sub-agent (mode=concern_scout) explored . in 1ms.\n\n## Report\nconcerns:\n - concern: Request extraction\n",
      details: {
        mode: "concern_scout",
        target_path: ".",
        focus: null,
        report_concern: null,
      },
    } as never);
    return { turns: 1, costUsd: null, aborted: true };
  }
}

class DeadlineRuntime implements AgentRuntime {
  abortedBySignal = false;
  calls = 0;
  constructor(private readonly recover = false) {}

  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    if (isProbeCall(options)) return { turns: 1, costUsd: null, aborted: false };
    this.calls += 1;
    if (this.recover && this.calls === 2) return new CoverageClosureRuntime().runSession(options);
    const partial = makeValidCodebaseMap();
    partial.coverage.D1_topography.status = "gap";
    writeMap(options.cwd, options.spawnExplorerStateDir ?? ".agentify/runtime/audit", partial);
    return new Promise((resolve) => {
      const fallback = setTimeout(
        () => resolve({ turns: 0, costUsd: null, aborted: false }),
        250,
      );
      options.signal?.addEventListener("abort", () => {
        this.abortedBySignal = true;
        clearTimeout(fallback);
        resolve({ turns: 0, costUsd: null, aborted: true });
      }, { once: true });
    });
  }
}

async function testParentAuditSessionHasApplicationOwnedDeadline(): Promise<void> {
  const cwd = tempDir("gate-parent-deadline");
  try {
    const runtime = new DeadlineRuntime();
    await assert.rejects(
      runWithRuntime(cwd, runtime, { maxSessionDurationMs: 25 }),
      /session elapsed time.*25ms|structured closure/i,
    );
    assert.equal(runtime.abortedBySignal, true, "application deadline must abort the hung runtime");
    assert.equal(runtime.calls, 2, "one bounded recovery may use remaining aggregate time, then stop");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testDeadlineRecoveryCanCloseAudit(): Promise<void> {
  const cwd = tempDir("gate-deadline-recovery");
  try {
    const runtime = new DeadlineRuntime(true);
    await runWithRuntime(cwd, runtime, { maxSessionDurationMs: 100 });
    assert.equal(runtime.calls, 2);
    assert.equal(runtime.abortedBySignal, true);
    const map = loadCanonicalMapAt(cwd, ".agentify/runtime/audit");
    assert.ok(map);
    assert.equal(assessCoverageClosure(map).unresolved.length, 0,
      "bounded recovery must pass the ordinary closure gate");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testFailedAuditRetainsApplicationAttestedExplorerCheckpoint(): Promise<void> {
  const cwd = tempDir("gate-receipt-checkpoint");
  try {
    await assert.rejects(runWithRuntime(cwd, new ReceiptCheckpointRuntime()), /structured closure/i);
    const map = loadCanonicalMapAt(cwd, ".agentify/runtime/audit");
    assert.ok(map?.explorer_receipts, "failed audit must retain its diagnostic receipt checkpoint");
    assert.ok(map.explorer_receipts.receipts.some((receipt) =>
      receipt.mode === "concern_scout"
      && receipt.proposed_concerns?.includes("Request extraction")
      && typeof receipt.source_run_id === "string"
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testAttachSkipsAuditOnlyWhenSpecialistEvidenceRecorded(): Promise<void> {
  const attachedCwd = tempDir("gate-attach-complete");
  try {
    const head = ensureGitRepository(attachedCwd);
    writeMap(
      attachedCwd,
      ".agentify/runtime/audit",
      attestCodebaseMap(makeValidCodebaseMap(), head),
    );
    const attachedUi = await runWithRuntime(attachedCwd, new FailIfAuditRuntime());
    assert.ok(attachedUi.infos.some((m) => m.includes("no model audit was rerun")));
  } finally {
    fs.rmSync(attachedCwd, { recursive: true, force: true });
  }

  const legacyCwd = tempDir("gate-attach-legacy");
  try {
    const legacyMap = makeValidCodebaseMap();
    delete legacyMap.expert_evidence;
    writeMap(legacyCwd, ".agentify/runtime/audit", legacyMap);
    const topUpRuntime = new TopUpRuntime();
    const legacyUi = await runWithRuntime(legacyCwd, topUpRuntime);
    assert.equal(topUpRuntime.auditCalls, 1, "a legacy map without specialist evidence must rerun a bounded audit");
    assert.ok(legacyUi.infos.some((m) => m.includes("predates specialist evidence")));
    assert.ok(legacyUi.infos.some((m) => m.includes("validated codebase map")));
  } finally {
    fs.rmSync(legacyCwd, { recursive: true, force: true });
  }
}

async function testAttachNormalizesRecordedSpecialistEvidenceBeforeAudit(): Promise<void> {
  const cwd = tempDir("gate-attach-normalizable");
  try {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src/index.ts"), "export { run } from './lib.js';\n");
    fs.writeFileSync(path.join(cwd, "src/lib.ts"), "export const run = () => true;\n");
    const head = ensureGitRepository(cwd);
    const map = makeValidCodebaseMap();
    delete map.expert_evidence;
    map.concern_evidence = {
      concerns: [{
        concern: "Request execution",
        one_line: "Owns request dispatch into the repository runtime.",
        covers: "Request dispatch and execution through the tracked runtime entry point.",
        excludes: "Documentation and release procedure.",
        flows: [{
          name: "Dispatch request",
          description: "A request enters the public dispatcher and reaches runtime execution.",
          steps: [
            { path: "src/index.ts", what_happens: "Accepts and forwards the request." },
            { path: "src/lib.ts", what_happens: "Executes the requested operation." },
          ],
        }],
        touchpoints: [
          { path: "src/index.ts", symbol: "run", role: "Public dispatch entry.", line_range: null, centrality: "core" },
          { path: "src/lib.ts", symbol: "run", role: "Runtime implementation.", line_range: null, centrality: "core" },
        ],
        invariants: [{ rule: "Dispatch reaches runtime execution.", why: "Requests must not be dropped.", reference: "src/index.ts" }],
        pitfalls: [],
        entry_questions: ["Does this change alter request execution?"],
        validation: [],
        spans_subtrees: ["src"],
        stability: "high",
        recurrence: "high",
        confidence: "high",
        last_updated: "2026-08-30T00:00:00.000Z",
      }],
      not_concerns: [{
        candidate: "Request execution as a generic runtime helper",
        why_rejected: "Not rejected: retained because request dispatch is an accepted repository behavior.",
      }],
    };
    writeMap(
      cwd,
      ".agentify/runtime/audit",
      attestCodebaseMap(map, head),
    );

    const ui = await runWithRuntime(cwd, new FailIfAuditRuntime());
    assert.ok(ui.infos.some((message) => message.includes("no model audit was rerun")));
    const normalized = loadCanonicalMapAt(cwd, ".agentify/runtime/audit");
    assert.deepEqual(normalized?.concern_evidence?.not_concerns, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testAuditFailsWhenSpecialistEvidenceNeverRecorded(): Promise<void> {
  const cwd = tempDir("gate-specialist-missing");
  try {
    const runtime = new NoSpecialistEvidenceRuntime();
    await assert.rejects(runWithRuntime(cwd, runtime), /specialist evidence/i);
    assert.ok(runtime.calls <= 3, `expected at most 1 initial + 2 recovery sessions, got ${runtime.calls}`);
    assert.ok(runtime.calls >= 2, "recovery passes must retry the missing specialist evidence");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [
  { name: "closureAllCovered", fn: testClosureAllCovered },
  { name: "closureRejectsEmptyEvidence", fn: testClosureRejectsEmptyEvidence },
  { name: "closureRejectsMissingEvidenceCitations", fn: testClosureRejectsMissingEvidenceCitations },
  { name: "closureRejectsNonExistentPositiveEvidence", fn: testClosureRejectsNonExistentPositiveEvidence },
  { name: "closureRejectsExistingAbsenceEvidence", fn: testClosureRejectsExistingAbsenceEvidence },
  { name: "closureUsesImmutableTrackedEvidence", fn: testClosureUsesImmutableTrackedEvidence },
  { name: "closureRejectsEscapingEvidenceCitation", fn: testClosureRejectsEscapingEvidenceCitation },
  { name: "closureRejectsPitfallsWithoutSubstance", fn: testClosureRejectsPitfallsWithoutSubstance },
  { name: "closureRejectsGapStatus", fn: testClosureRejectsGapStatus },
  { name: "closureRejectsWeakDimensionEvidence", fn: testClosureRejectsWeakDimensionEvidence },
  { name: "writeMapReturnsClosureReasons", fn: testWriteMapReturnsClosureReasons },
  { name: "loadCanonicalMapRejectsGarbage", fn: testLoadCanonicalMapAtRejectsGarbage },
  { name: "noMapMeansPartialNoExport", fn: testNoMapMeansPartialNoExport },
  { name: "missingWriteMapGetsOneRecoveryPass", fn: testMissingWriteMapGetsOneRecoveryPass },
  { name: "auditBootstrapsGapDraftForIncrementalMapWrites", fn: testAuditBootstrapsGapDraftForIncrementalMapWrites },
  { name: "gapMapMeansPartialNoExport", fn: testGapMapMeansPartialNoExport },
  { name: "fullyCoveredMeansSuccessAndPersistsMap", fn: testFullyCoveredMeansSuccessAndPersistsMap },
  { name: "intentionalCoverageClosureIsNotReportedAsAbort", fn: testIntentionalCoverageClosureIsNotReportedAsAbort },
  { name: "specialistEvidenceRequiredForCompletion", fn: testSpecialistEvidenceRequiredForCompletion },
  { name: "writeMapGuidesSpecialistEvidence", fn: testWriteMapGuidesSpecialistEvidence },
  { name: "attachSkipsAuditOnlyWhenSpecialistEvidenceRecorded", fn: testAttachSkipsAuditOnlyWhenSpecialistEvidenceRecorded },
  { name: "attachNormalizesRecordedSpecialistEvidenceBeforeAudit", fn: testAttachNormalizesRecordedSpecialistEvidenceBeforeAudit },
  { name: "auditFailsWhenSpecialistEvidenceNeverRecorded", fn: testAuditFailsWhenSpecialistEvidenceNeverRecorded },
  { name: "failedAuditRetainsApplicationAttestedExplorerCheckpoint", fn: testFailedAuditRetainsApplicationAttestedExplorerCheckpoint },
  { name: "parentAuditSessionHasApplicationOwnedDeadline", fn: testParentAuditSessionHasApplicationOwnedDeadline },
  { name: "deadlineRecoveryCanCloseAudit", fn: testDeadlineRecoveryCanCloseAudit },
  { name: "everyModelRequestBelongsToTheAuditBudget", fn: testEveryModelRequestBelongsToTheAuditBudget },
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
