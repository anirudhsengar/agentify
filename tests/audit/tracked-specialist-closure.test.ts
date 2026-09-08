import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  assessSpecialistEvidence,
  reconcileSpecialistEvidence,
  type CodebaseMap,
} from "../../src/core/audit/schema.ts";
import { runAgentifyApp } from "../../src/core/agentify-app.ts";
import { discoverSpecialistPortfolio } from "../../src/core/specialists/discovery.ts";
import { runRepositoryAudit } from "../../src/core/runs/repository-audit-run.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
  AgentifyConfig,
  AgentifyUi,
} from "../../src/core/types.ts";
import type { RepositoryInstallationPreflight } from "../../src/core/installer/contracts.ts";
import { attestCodebaseMap, makeValidCodebaseMap } from "../fixtures/codebase-map.ts";
import { runRepositoryAudit as runCoveragePhase } from "../../src/core/runs/repository-audit-run-core.ts";
import { compileSpecialistEvidence } from "../../src/core/audit/specialist-compiler.ts";
import { assessExplorerReceiptAttestation } from "../../src/core/audit/explorer-receipts.ts";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { concernEvidencePaths } from "../../src/core/audit/specialist-completion.ts";

type Concern = NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number];
type Centrality = Concern["touchpoints"][number]["centrality"];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, relativePath: string, content = `${relativePath}\n`): void {
  const absolute = path.join(cwd, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function makeConcern(input: {
  name: string;
  touchpoints: Array<{ path: string; centrality: Centrality }>;
  flows: Array<{ name: string; paths: string[] }>;
}): Concern {
  return {
    concern: input.name,
    one_line: `Owns ${input.name}.`,
    covers: `End-to-end behavior for ${input.name}.`,
    excludes: "Adjacent concerns are represented separately.",
    flows: input.flows.map((flow) => ({
      name: flow.name,
      description: `Observed ${flow.name}.`,
      steps: flow.paths.map((repositoryPath, index) => ({
        path: repositoryPath,
        what_happens: `Observed step ${index + 1} in ${repositoryPath}.`,
      })),
    })),
    touchpoints: input.touchpoints.map((touchpoint) => ({
      path: touchpoint.path,
      symbol: null,
      role: `Observed role for ${input.name}.`,
      line_range: null,
      centrality: touchpoint.centrality,
    })),
    invariants: [],
    pitfalls: [],
    entry_questions: [`Does this change alter ${input.name}?`],
    validation: ["bash compile.sh"],
    spans_subtrees: [...new Set(input.touchpoints.map(({ path: repositoryPath }) =>
      repositoryPath.includes("/") ? repositoryPath.split("/")[0]! : repositoryPath
    ))],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-25T00:00:00.000Z",
  };
}

function createRepository(): { cwd: string; head: string; tracked: string[] } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-tracked-specialists-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");

  for (const trackedPath of [
    "README.md",
    "NOTICE",
    "get.sh",
    "compile.sh",
    "buildenv/jenkins/JenkinsfileBase",
    "openjdk/playlist.xml",
    "openjdk/openjdk.mk",
    "external/external.sh",
    "scripts/disabled_tests/exclude_parser.py",
    ".github/workflows/disabledTestsLinter.yml",
  ]) {
    write(cwd, trackedPath);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");

  // These paths intentionally exist in the working tree but are not tracked.
  // They model fetched dependencies, generated outputs, and ignored build tools.
  for (const generatedPath of [
    "TKG/src/org/testKitGen/MainRunner.java",
    "TKG/examples/base/playlist.xml",
    "TKG/bin/TestKitGen.jar",
    "TKG/testEnv.mk",
    "openjdk/autoGen.mk",
  ]) {
    write(cwd, generatedPath);
  }

  return {
    cwd,
    head: git(cwd, "rev-parse", "HEAD"),
    tracked: git(cwd, "ls-files", "-z").split("\0").filter(Boolean),
  };
}

function aqaShapedMap(): CodebaseMap {
  const map = makeValidCodebaseMap();
  delete map.expert_evidence;
  map.meta.project_type = "Make, shell, Groovy, XML, Python, and Java test harness";
  map.meta.languages = ["Make", "Shell", "Groovy", "XML", "Python", "Java"];
  map.skeleton.top_level_tree = [
    ".github/",
    "buildenv/",
    "external/",
    "openjdk/",
    "scripts/",
    "TKG/",
    "compile.sh",
    "get.sh",
  ];
  map.skeleton.entry_points = [
    { path: "get.sh", role: "SDK acquisition", language: "Shell", run_command: "bash get.sh" },
    { path: "compile.sh", role: "tool bootstrap", language: "Shell", run_command: "bash compile.sh" },
  ];
  map.skeleton.first_5_files_for_fresh_agent = [
    { path: "README.md", why: "repository behavior" },
    { path: "NOTICE", why: "legal metadata considered and rejected as a specialty" },
    { path: "buildenv/jenkins/JenkinsfileBase", why: "CI orchestration" },
    { path: "TKG/examples/base/playlist.xml", why: "fetched example incorrectly proposed by the model" },
  ];
  map.module_graph.edges = [
    { from: "get.sh", to: "buildenv/jenkins/JenkinsfileBase", kind: "CI parameter flow" },
    { from: "buildenv/jenkins/JenkinsfileBase", to: "compile.sh", kind: "tool bootstrap" },
    { from: "openjdk/playlist.xml", to: "openjdk/openjdk.mk", kind: "test dispatch" },
    { from: "openjdk/playlist.xml", to: "jtreg.jar child Java process", kind: "runtime process" },
    { from: "openjdk/openjdk.mk", to: "openjdk/excludes/ProblemList_openjdk$(JDK_VERSION).txt", kind: "path template" },
    { from: "TKG/src/org/testKitGen/MainRunner.java", to: "TKG/bin/TestKitGen.jar", kind: "generated binary" },
  ];
  map.module_graph.parallelizable_subtrees = [["openjdk"], ["external"], ["TKG"]];
  map.module_graph.shared_abstractions = [
    "buildenv/jenkins/JenkinsfileBase",
    "TKG/testEnv.mk",
  ];
  map.module_graph.shared_state = ["openjdk/autoGen.mk"];
  map.module_graph.client_server_split = null;
  map.pitfalls = [{
    module: "scripts/disabled_tests/exclude_parser.py",
    what: "Disabled-test metadata must remain parseable.",
    consequence: "Tests are silently skipped or unexpectedly enabled.",
    line_ref: 1,
  }];
  map.operational_surface.build.recipe_file = "compile.sh";
  map.concern_evidence = {
    concerns: [
      makeConcern({
        name: "SDK/JDK acquisition and CI test-job integration",
        touchpoints: [
          { path: "get.sh", centrality: "core" },
          { path: "buildenv/jenkins/JenkinsfileBase", centrality: "core" },
          { path: "compile.sh", centrality: "supporting" },
        ],
        flows: [{
          name: "Jenkins parameters to test",
          paths: [
            "buildenv/jenkins/JenkinsfileBase",
            "compile.sh",
            "buildenv/jenkins/JenkinsfileBase",
          ],
        }],
      }),
      makeConcern({
        name: "OpenJDK jtreg execution",
        touchpoints: [
          { path: "openjdk/playlist.xml", centrality: "core" },
          { path: "openjdk/openjdk.mk", centrality: "core" },
        ],
        flows: [{
          name: "playlist to jtreg invocation",
          paths: ["openjdk/playlist.xml", "openjdk/openjdk.mk"],
        }],
      }),
      makeConcern({
        name: "Disabled-test metadata lifecycle",
        touchpoints: [
          { path: "scripts/disabled_tests/exclude_parser.py", centrality: "core" },
          { path: ".github/workflows/disabledTestsLinter.yml", centrality: "core" },
        ],
        flows: [{
          name: "metadata edit to CI validation",
          paths: [
            "scripts/disabled_tests/exclude_parser.py",
            ".github/workflows/disabledTestsLinter.yml",
          ],
        }],
      }),
      makeConcern({
        name: "External containerized test harness lifecycle",
        touchpoints: [
          { path: "external/external.sh", centrality: "core" },
          { path: "README.md", centrality: "supporting" },
        ],
        flows: [{
          name: "documented suite to container execution",
          paths: ["README.md", "external/external.sh"],
        }],
      }),
      makeConcern({
        name: "TKG playlist compilation and generated Make topology",
        touchpoints: [
          { path: "TKG/src/org/testKitGen/MainRunner.java", centrality: "core" },
          { path: "TKG/examples/base/playlist.xml", centrality: "supporting" },
          { path: "compile.sh", centrality: "supporting" },
        ],
        flows: [{
          name: "compile wrapper to fetched generator",
          paths: ["compile.sh", "TKG/src/org/testKitGen/MainRunner.java"],
        }],
      }),
    ],
    not_concerns: [
      {
        candidate: "NOTICE",
        why_rejected: "Legal metadata is repository plumbing, not a body of operational knowledge.",
      },
      {
        candidate: "openjdk/autoGen.mk",
        why_rejected: "Generated Make output is not source evidence.",
      },
      {
        candidate: "jtreg.jar child Java process",
        why_rejected: "A runtime process label is not a repository file.",
      },
      {
        candidate: "TKG/bin/TestKitGen.jar",
        why_rejected: "A generated binary is not tracked source evidence.",
      },
    ],
  };
  return map;
}

test("semantic closure binds to tracked blobs and keeps extensionless orchestration files", () => {
  const repository = createRepository();
  try {
    const map = aqaShapedMap();
    const assessment = assessSpecialistEvidence(map, { cwd: repository.cwd });

    assert.equal(assessment.complete, true, assessment.reasons.join("; "));
    assert.deepEqual(assessment.accepted_concerns, [
      "Disabled-test metadata lifecycle",
      "External containerized test harness lifecycle",
      "OpenJDK jtreg execution",
      "SDK/JDK acquisition and CI test-job integration",
    ]);
    assert.deepEqual(
      assessment.rejected_concerns.map((entry) => entry.concern),
      ["TKG playlist compilation and generated Make topology"],
    );
    assert.ok(assessment.high_signal_paths.includes("buildenv/jenkins/JenkinsfileBase"));
    assert.ok(assessment.exempted_paths.includes("NOTICE"));
    assert.deepEqual(assessment.uncovered_paths, []);

    for (const nonEvidence of [
      "jtreg.jar child Java process",
      "openjdk/autoGen.mk",
      "openjdk/excludes/ProblemList_openjdk$(JDK_VERSION).txt",
      "TKG/bin/TestKitGen.jar",
      "TKG/examples/base/playlist.xml",
      "TKG/src/org/testKitGen/MainRunner.java",
      "TKG/testEnv.mk",
    ]) {
      assert.ok(
        !assessment.high_signal_paths.includes(nonEvidence),
        `${nonEvidence} must not be treated as a tracked high-signal file`,
      );
    }

    const reconciled = reconcileSpecialistEvidence(map, assessment);
    assert.notStrictEqual(reconciled, map);
    assert.equal(map.concern_evidence?.concerns.length, 5, "assessment must not mutate model evidence");
    assert.equal(reconciled.concern_evidence?.concerns.length, 4);
    assert.ok(reconciled.concern_evidence?.not_concerns.some((entry) =>
      entry.candidate === "TKG playlist compilation and generated Make topology"
      && /trusted evidence binding/i.test(entry.why_rejected)
    ));

    const rawPortfolio = discoverSpecialistPortfolio(map, repository.head, repository.tracked);
    assert.ok(
      !rawPortfolio.specialists.some((specialist) => specialist.concern.startsWith("TKG ")),
      "defense-in-depth discovery must reject a concern with no tracked core and no tracked flow",
    );
    assert.ok(rawPortfolio.warnings.some((warning) =>
      /TKG playlist compilation.*no core touchpoint/i.test(warning)
    ));

    const portfolio = discoverSpecialistPortfolio(reconciled, repository.head, repository.tracked);
    const sdk = portfolio.specialists.find((specialist) =>
      specialist.concern === "SDK/JDK acquisition and CI test-job integration"
    );
    assert.ok(sdk, "SDK/JDK concern must become a specialist");
    assert.ok(sdk.context_paths.includes("buildenv/jenkins/JenkinsfileBase"));
    assert.deepEqual(
      sdk.flows.find((flow) => flow.name === "Jenkins parameters to test")?.steps
        .map((step) => step.path),
      [
        "buildenv/jenkins/JenkinsfileBase",
        "compile.sh",
        "buildenv/jenkins/JenkinsfileBase",
      ],
      "ordered flow steps must survive even when an orchestration file is revisited",
    );
  } finally {
    fs.rmSync(repository.cwd, { recursive: true, force: true });
  }
});

class RepairUi implements AgentifyUi {
  readonly messages: string[] = [];
  status(message: string): void { this.messages.push(message); }
  info(message: string): void { this.messages.push(message); }
  error(message: string): void { this.messages.push(message); }
  async promptSelect(): Promise<string> { throw new Error("repair test must not prompt"); }
  async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("repair test must not prompt"); }
  async promptCheckboxList(): Promise<ReadonlyArray<string>> { throw new Error("repair test must not prompt"); }
  async promptSecret(): Promise<string> { throw new Error("repair test must not prompt"); }
  async promptText(): Promise<string> { throw new Error("repair test must not prompt"); }
}

class FailIfModelRuns implements AgentRuntime {
  calls = 0;

  async runSession(): Promise<AgentRuntimeResult> {
    this.calls += 1;
    throw new Error("a tracked-complete existing map must reconcile without a model call");
  }
}

test("an existing tracked-complete map reconciles without rerunning the model", async () => {
  const repository = createRepository();
  const previousHome = process.env["HOME"];
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-reconcile-home-"));
  process.env["HOME"] = temporaryHome;
  try {
    const mapPath = path.join(repository.cwd, ".agentify", "runtime", "audit", "codebase_map.json");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    const existing = attestCodebaseMap(aqaShapedMap(), repository.head);
    existing.meta.project_type = "unknown";
    existing.meta.languages = [];
    fs.writeFileSync(mapPath, `${JSON.stringify(existing, null, 2)}\n`);
    const repositoryPreflight: RepositoryInstallationPreflight = {
      disposition: "ready",
      analysis_allowed: true,
      identity: {
        repository_id: "fixture",
        full_name: "fixture/aqa-tests",
        default_branch: "main",
        current_commit: repository.head,
        current_branch: "main",
        origin_url: "https://github.com/fixture/aqa-tests.git",
        actor_login: "fixture",
        actor_permission: "write",
        default_branch_policy: "unknown",
      },
      commands: [],
      allowed_write_paths: [],
      protected_paths: [".git"],
      blockers: [],
    };

    const runtime = new FailIfModelRuns();
    const ui = new RepairUi();
    const result = await runAgentifyApp({
      args: [],
      cwd: repository.cwd,
      ui,
      runtime,
      configOverride: { schemaVersion: 1, provider: "openai", thinkingLevel: "high", models: {} },
      repositoryPreflight,
    });

    assert.equal(runtime.calls, 0);
    assert.equal(result.turns, 0);
    assert.ok(ui.messages.some((message) => /no model audit was rerun/i.test(message)));

    const persisted = JSON.parse(fs.readFileSync(mapPath, "utf8")) as CodebaseMap;
    assert.notEqual(persisted.meta.project_type.toLowerCase(), "unknown");
    assert.ok(persisted.meta.languages.length > 0);
    assert.equal(persisted.concern_evidence?.concerns.length, 4);
    assert.ok(persisted.concern_evidence?.not_concerns.some((entry) =>
      entry.candidate === "TKG playlist compilation and generated Make topology"
    ));
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
    fs.rmSync(repository.cwd, { recursive: true, force: true });
  }
});

class ProgressiveRepairRuntime implements AgentRuntime {
  baseCalls = 0;
  repairCalls = 0;
  repairToolSets: string[][] = [];
  repairPrompts: string[] = [];

  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    if (/trusted semantic-quality gate/i.test(options.userPrompt)) {
      this.repairCalls += 1;
      this.repairToolSets.push([...options.tools]);
      this.repairPrompts.push(options.userPrompt);
      assert.doesNotMatch(options.systemPrompt, /Use four bounded direct reads|### Direct scout/,
        "coverage-complete repair must not inherit the initial-audit scouting instructions");
      assert.match(options.systemPrompt, /coverage is already closed/i);
      assert.equal("spawnExplorerPurpose" in options ? options.spawnExplorerPurpose : undefined, "specialist-repair",
        "repair must restrict the actual explorer dispatcher, not rely only on its prompt");
      const budget = options.auditResourceBudget;
      assert.ok(budget, "semantic repair must share the audit budget");
      assert.ok(options.onProviderRequest);
      options.onProviderRequest({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
      assert.equal(budget.snapshot().unreserved_calls, 0,
        "repair must forward the provider reservation before dispatch");
      assert.equal(budget.snapshot().reserved_cost_usd, 0.01);
      options.onEvent?.({ type: "message_end", message: {
        role: "assistant", stopReason: "toolUse",
        usage: { input: 50, output: 10, cost: { total: 0.001 } },
      } } as never);
      assert.equal(budget.snapshot().reserved_cost_usd, 0,
        "completed repair usage replaces its reservation");
      if (this.repairCalls <= 3) {
        const destination = path.join(
          options.cwd,
          options.spawnExplorerStateDir ?? ".agentify/runtime/audit",
          "codebase_map.json",
        );
        const repaired = aqaShapedMap();
        if (this.repairCalls < 3) {
          repaired.concern_evidence!.concerns = repaired.concern_evidence!.concerns.slice(
            0,
            this.repairCalls,
          );
        }
        fs.writeFileSync(destination, `${JSON.stringify(attestCodebaseMap(repaired, git(options.cwd, "rev-parse", "HEAD")), null, 2)}
`);
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
        for (const concern of repaired.concern_evidence?.concerns ?? []) {
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
    } else {
      this.baseCalls += 1;
      const currentMapPath = path.join(
        options.cwd,
        options.spawnExplorerStateDir ?? ".agentify/runtime/audit",
        "codebase_map.json",
      );
      const current = JSON.parse(fs.readFileSync(currentMapPath, "utf8")) as CodebaseMap;
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
      for (const concern of current.concern_evidence?.concerns ?? []) {
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
    return { turns: 1, costUsd: 0, aborted: false };
  }
}

test("progressive semantic repair may exceed two passes while each pass closes tracked gaps", async () => {
  const repository = createRepository();
  const previousHome = process.env["HOME"];
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-repair-home-"));
  process.env["HOME"] = temporaryHome;
  try {
    const initial = aqaShapedMap();
    initial.concern_evidence = {
      concerns: [initial.concern_evidence!.concerns.at(-1)!],
      not_concerns: initial.concern_evidence!.not_concerns,
    };
    const mapPath = path.join(repository.cwd, ".agentify", "runtime", "audit", "codebase_map.json");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, `${JSON.stringify(initial, null, 2)}\n`);

    const runtime = new ProgressiveRepairRuntime();
    const ui = new RepairUi();
    const result = await runRepositoryAudit({
      cwd: repository.cwd,
      ui,
      runtime,
      config: { schemaVersion: 1, provider: "openai", thinkingLevel: "high", models: {} },
    });

    assert.equal(runtime.baseCalls, 1);
    assert.equal(runtime.repairCalls, 3);
    assert.ok(runtime.repairPrompts.every((prompt) =>
      /group the already-attested bodies/i.test(prompt)
      && /grouped_into set to one exact existing broader concern identity/i.test(prompt)
      && /unions their flows, touchpoints, invariants, pitfalls, questions, and validation/i.test(prompt)
      && /resolve every obligation in the current bounded cluster batch/i.test(prompt)
      && /batch exact not_concerns decisions into one write_map_delta/i.test(prompt)
      && /core_owner: \{path, concern\}/.test(prompt)
      && /if ownership is ambiguous, keep it unresolved/i.test(prompt)
      && !/resolve the earliest distinct behavior/i.test(prompt)
    ));
    assert.deepEqual(
      runtime.repairToolSets,
      Array.from({ length: 3 }, () => ["write_map_delta", "spawn_explorer"]),
      "repair parents must act on the supplied obligations instead of rereading broad repository state",
    );
    assert.equal(result.turns, 4);
    assert.ok(ui.messages.some((message) => /retained 4 tracked specialist concern/i.test(message)));

    const persisted = JSON.parse(fs.readFileSync(mapPath, "utf8")) as CodebaseMap;
    assert.deepEqual(
      persisted.concern_evidence?.concerns.map((entry) => entry.concern).sort(),
      [
        "Disabled-test metadata lifecycle",
        "External containerized test harness lifecycle",
        "OpenJDK jtreg execution",
        "SDK/JDK acquisition and CI test-job integration",
      ].sort(),
    );
    assert.ok(persisted.concern_evidence?.not_concerns.some((entry) =>
      entry.candidate === "TKG playlist compilation and generated Make topology"
    ));

    const logDirectory = path.join(temporaryHome, ".agentify", "logs", "agentify");
    const logFiles = fs.readdirSync(logDirectory).filter((name) => name.endsWith(".jsonl"));
    assert.equal(logFiles.length, 1);
    const events = fs.readFileSync(path.join(logDirectory, logFiles[0]!), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { event: string; payload: string });
    const runEnds = events.filter((event) => event.event === "agentify.run_end");
    assert.equal(runEnds.length, 1, "coverage and semantic repair must share one terminal outcome");
    assert.equal((JSON.parse(runEnds[0]!.payload) as { status: string }).status, "success");
    const budgetEvents = events.filter((event) => event.event === "agentify.audit_budget");
    assert.equal(budgetEvents.length, 1, "one aggregate budget result must accompany the terminal outcome");
    assert.equal((JSON.parse(budgetEvents[0]!.payload) as { status: string }).status, "within");
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
    fs.rmSync(repository.cwd, { recursive: true, force: true });
  }
});

test("configured semantic repair pass budgets fail closed with an obligation fingerprint", async () => {
  const repository = createRepository();
  const previousHome = process.env["HOME"];
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-repair-budget-home-"));
  process.env["HOME"] = temporaryHome;
  try {
    const initial = aqaShapedMap();
    initial.concern_evidence = {
      concerns: [initial.concern_evidence!.concerns.at(-1)!],
      not_concerns: initial.concern_evidence!.not_concerns,
    };
    const mapPath = path.join(repository.cwd, ".agentify", "runtime", "audit", "codebase_map.json");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, `${JSON.stringify(initial, null, 2)}\n`);

    const runtime = new ProgressiveRepairRuntime();
    const config = {
      schemaVersion: 1,
      provider: "openai",
      thinkingLevel: "high",
      models: {},
      auditBudgets: { maxSemanticRepairPasses: 2 },
    } as AgentifyConfig;
    await assert.rejects(
      runRepositoryAudit({ cwd: repository.cwd, ui: new RepairUi(), runtime, config }),
      /unresolved-obligation fingerprint [0-9a-f]{64}/i,
    );
    assert.equal(runtime.baseCalls, 1);
    assert.equal(runtime.repairCalls, 2, "configured semantic repair pass cap must be enforced");
    const logDirectory = path.join(temporaryHome, ".agentify", "logs", "agentify");
    const logFile = fs.readdirSync(logDirectory).find((name) => name.endsWith(".jsonl"));
    assert.ok(logFile);
    const events = fs.readFileSync(path.join(logDirectory, logFile), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { event: string; payload: string });
    assert.equal(events.filter((event) => event.event === "agentify.run_end").length, 1);
    const budgetEvents = events.filter((event) => event.event === "agentify.audit_budget");
    assert.equal(budgetEvents.length, 1);
    assert.equal((JSON.parse(budgetEvents[0]!.payload) as { status: string }).status, "exhausted");
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
    fs.rmSync(repository.cwd, { recursive: true, force: true });
  }
});

class InterruptedRepairRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    const mapPath = path.join(
      options.cwd,
      options.spawnExplorerStateDir ?? ".agentify/runtime/audit",
      "codebase_map.json",
    );
    const current = JSON.parse(fs.readFileSync(mapPath, "utf8")) as CodebaseMap;
    if (/trusted semantic-quality gate/i.test(options.userPrompt)) {
      const repaired = aqaShapedMap();
      repaired.explorer_receipts = current.explorer_receipts;
      fs.writeFileSync(mapPath, `${JSON.stringify(repaired, null, 2)}\n`);
      const concern = "External containerized test harness lifecycle";
      options.onEvent?.({
        type: "tool_execution_end",
        toolName: "spawn_explorer",
        resultText: `Sub-agent (mode=concern_tracer) explored external in 1ms.\n\n## Report\nconcern: ${concern}\n`,
        details: {
          mode: "concern_tracer",
          target_path: "external",
          focus: concern,
          report_concern: concern,
          observed_paths: concernEvidencePaths(repaired.concern_evidence!.concerns.find((candidate) => candidate.concern === concern)!),
        },
      } as never);
      throw new Error("simulated repair interruption");
    }

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
    for (const concern of current.concern_evidence?.concerns ?? []) {
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
    return { turns: 1, costUsd: 0, aborted: false };
  }
}

test("semantic repair checkpoints successful tracer receipts before an interrupted session exits", async () => {
  const repository = createRepository();
  const previousHome = process.env["HOME"];
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-repair-receipt-home-"));
  process.env["HOME"] = temporaryHome;
  try {
    const initial = aqaShapedMap();
    initial.concern_evidence = {
      concerns: [initial.concern_evidence!.concerns.at(-1)!],
      not_concerns: initial.concern_evidence!.not_concerns,
    };
    const mapPath = path.join(repository.cwd, ".agentify", "runtime", "audit", "codebase_map.json");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, `${JSON.stringify(initial, null, 2)}\n`);

    await assert.rejects(
      runRepositoryAudit({
        cwd: repository.cwd,
        ui: new RepairUi(),
        runtime: new InterruptedRepairRuntime(),
        config: { schemaVersion: 1, provider: "openai", thinkingLevel: "high", models: {} },
      }),
      /simulated repair interruption/i,
    );

    const persisted = JSON.parse(fs.readFileSync(mapPath, "utf8")) as CodebaseMap;
    assert.ok(
      persisted.explorer_receipts?.receipts.some((receipt) =>
        receipt.success
        && receipt.mode === "concern_tracer"
        && receipt.report_concern === "External containerized test harness lifecycle"
      ),
      "a successful tracer must remain attested even when the parent repair session is interrupted",
    );
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
    fs.rmSync(repository.cwd, { recursive: true, force: true });
  }
});

test("aggregate model-call exhaustion reports the unresolved semantic obligations", async () => {
  const repository = createRepository();
  const previousHome = process.env["HOME"];
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-call-budget-home-"));
  process.env["HOME"] = temporaryHome;
  try {
    const runtime: AgentRuntime = {
      async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
        for (let index = 0; index < 2; index += 1) {
          options.onEvent?.({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "toolUse",
              usage: { input: 1, output: 1, cost: { total: 0 } },
            },
          } as never);
        }
        return {
          turns: 2,
          costUsd: 0,
          aborted: true,
          diagnostics: { provider_requests: 2 },
        } as AgentRuntimeResult;
      },
    };
    const config = {
      schemaVersion: 1,
      provider: "openai",
      thinkingLevel: "high",
      models: {},
      auditBudgets: { maxModelCalls: 1 },
    } as AgentifyConfig;
    await assert.rejects(
      runRepositoryAudit({ cwd: repository.cwd, ui: new RepairUi(), runtime, config }),
      (error: unknown) => {
        assert.match(String(error), /model calls reached 1 while requesting continuation/i);
        assert.match(String(error), /unresolved-obligation fingerprint [0-9a-f]{64}/i);
        assert.match(String(error), /D2_module_boundaries/i);
        return true;
      },
    );
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
    fs.rmSync(repository.cwd, { recursive: true, force: true });
  }
});

test("same-HEAD audit continuation cannot reset an exhausted aggregate model-call budget", async () => {
  const repository = createRepository();
  const previousHome = process.env["HOME"];
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-continuation-budget-home-"));
  process.env["HOME"] = temporaryHome;
  try {
    const mapPath = path.join(repository.cwd, ".agentify", "runtime", "audit", "codebase_map.json");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, `${JSON.stringify(aqaShapedMap(), null, 2)}\n`);
    let sessions = 0;
    const runtime: AgentRuntime = {
      async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
        sessions += 1;
        options.onEvent?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            usage: { input: 1, output: 1, cost: { total: 0 } },
          },
        } as never);
        return {
          turns: 1,
          costUsd: 0,
          aborted: true,
          diagnostics: { provider_requests: 1 },
        } as AgentRuntimeResult;
      },
    };
    const config = {
      schemaVersion: 1,
      provider: "openai",
      thinkingLevel: "high",
      models: {},
      auditBudgets: { maxModelCalls: 1, maxTurns: 1 },
    } as AgentifyConfig;

    await assert.rejects(
      runRepositoryAudit({ cwd: repository.cwd, ui: new RepairUi(), runtime, config }),
      /resource budget exhausted.*model calls reached 1/i,
    );
    await assert.rejects(
      runRepositoryAudit({ cwd: repository.cwd, ui: new RepairUi(), runtime, config }),
      /resource budget exhausted.*model calls reached 1/i,
    );
    assert.equal(
      sessions,
      1,
      "a continuation at the same repository commit must consume the prior invocation's usage",
    );
    const persisted = JSON.parse(fs.readFileSync(mapPath, "utf8")) as CodebaseMap & {
      audit_budget_checkpoint?: { repository_commit?: string; usage?: { model_calls?: number } };
    };
    assert.equal(persisted.audit_budget_checkpoint?.repository_commit, repository.head);
    assert.equal(persisted.audit_budget_checkpoint?.usage?.model_calls, 1);
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
    fs.rmSync(repository.cwd, { recursive: true, force: true });
  }
});


for (const outcome of ["repaired", "unresolved", "missing-scout", "cancelled", "cancelled-repair", "standalone", "cancelled-before", "standalone-cancelled-before"] as const) {
  test(`receipt-only closure uses bounded specialist repair without waiving provenance: ${outcome}`, async () => {
    const { cwd } = createRepository();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-receipt-handoff-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const controller = new AbortController();
    const budget = new AuditResourceBudget();
    let calls = 0;
    let repairCalls = 0;
    const mapPath = path.join(cwd, ".agentify/runtime/audit/codebase_map.json");
    try {
      const compiled = compileSpecialistEvidence(aqaShapedMap(), { cwd });
      assert.equal(compiled.complete, true, "fixture requires a structurally complete portfolio");
      // Synthetic narrative approval isolates the orchestration boundary. It is
      // not live/model qualification; source receipts must be supplied separately.
      const map = attestCodebaseMap(compiled.map, git(cwd, "rev-parse", "HEAD"));
      delete map.explorer_receipts;
      const missing = map.concern_evidence!.concerns[0]!;
      const scout = (options: AgentRuntimeSessionOptions): void => options.onEvent?.({
        type: "tool_execution_end", toolName: "spawn_explorer", isError: false,
        resultText: "Sub-agent (mode=concern_scout) explored .\n\n## Report\n",
        details: { mode: "concern_scout", target_path: ".", report_concern: null },
      } as never);
      const trace = (options: AgentRuntimeSessionOptions, concern: Concern, failed: boolean): void => options.onEvent?.({
        type: "tool_execution_end", toolName: "spawn_explorer", isError: failed,
        resultText: failed ? "Error: fixture tracer timeout"
          : `Sub-agent (mode=concern_tracer) explored .\n\n## Report\nconcern: ${concern.concern}`,
        details: { mode: "concern_tracer", target_path: ".", expected_concern: concern.concern,
          report_concern: failed ? null : concern.concern, failure_kind: failed ? "timeout" : null,
          ...(failed ? {} : { observed_paths: concernEvidencePaths(concern) }),
        },
      } as never);
      const runtime: AgentRuntime = {
        async runSession(options): Promise<AgentRuntimeResult> {
          calls += 1;
          assert.equal(options.auditResourceBudget, budget, "all phases share one resource budget");
          if (calls === 1) {
            fs.mkdirSync(path.dirname(mapPath), { recursive: true });
            fs.writeFileSync(mapPath, JSON.stringify(map));
            if (outcome !== "missing-scout") scout(options);
            for (const concern of map.concern_evidence!.concerns) {
              trace(options, concern, outcome !== "missing-scout" && concern.concern === missing.concern);
            }
            if (outcome === "cancelled") controller.abort();
          } else if (outcome !== "standalone") {
            repairCalls += 1;
            assert.match(options.userPrompt, /trusted semantic-quality gate/i);
            assert.equal(budget.snapshot().coverage_recovery_passes, 0,
              "generic coverage recovery must not consume the specialist repair allowance");
            assert.ok(budget.snapshot().semantic_repair_passes > 0);
            assert.deepEqual((JSON.parse(fs.readFileSync(mapPath, "utf8")) as CodebaseMap).concern_evidence,
              map.concern_evidence, "a phase handoff cannot rewrite specialist claims");
            if (outcome === "missing-scout") {
              assert.match(options.userPrompt, /successful concern_scout receipt is missing/);
              assert.doesNotMatch(options.userPrompt, /Do not rerun a broad concern scout/);
              scout(options);
            } else {
              assert.ok(options.userPrompt.includes(missing.concern), "repair must name the missing trace");
              if (outcome === "repaired" || outcome === "cancelled-repair") trace(options, missing, false);
              if (outcome === "cancelled-repair") controller.abort();
            }
          }
          return { turns: 1, costUsd: 0, aborted: controller.signal.aborted };
        },
      };
      const context = { cwd, ui: new RepairUi(), runtime, auditResourceBudget: budget,
        signal: controller.signal,
        config: { schemaVersion: 1, thinkingLevel: "high", models: {} } as AgentifyConfig };
      const cancelledBefore = outcome === "cancelled-before" || outcome === "standalone-cancelled-before";
      if (cancelledBefore) controller.abort();
      const execution = outcome.startsWith("standalone") ? runCoveragePhase(context) : runRepositoryAudit(context);
      const repaired = outcome === "repaired" || outcome === "missing-scout";
      if (repaired) {
        await execution;
        assert.equal(repairCalls, 1);
        assert.equal(calls, 2);
      } else {
        await assert.rejects(execution, outcome === "standalone" ? /structured closure/
          : outcome === "unresolved" ? /unresolved-obligation fingerprint/ : /abort/i);
        if (outcome === "cancelled-repair") assert.equal(repairCalls, 1);
        if (outcome === "cancelled") assert.equal(calls, 1, "cancellation must prevent later review/repair dispatch");
        if (outcome === "unresolved") assert.ok(repairCalls > 0 && repairCalls <= budget.limits.maxSemanticRepairPasses);
        if (outcome === "standalone") assert.equal(budget.snapshot().semantic_repair_passes, 0);
        if (cancelledBefore) assert.equal(calls, 0, "pre-cancelled audits must not dispatch a model");
      }
      assert.equal(budget.snapshot().model_calls, calls, "cancellation must retain completed runtime accounting");
      const persisted = JSON.parse(fs.readFileSync(mapPath, "utf8")) as CodebaseMap;
      if (repaired) assert.equal(assessExplorerReceiptAttestation(persisted, cwd).complete, true);
      if (outcome !== "missing-scout" && !cancelledBefore) assert.ok(persisted.explorer_receipts?.receipts.some(receipt =>
        !receipt.success && receipt.expected_concern === missing.concern), "failed trace history must survive handoff");
      const logDirectory = path.join(home, ".agentify/logs/agentify");
      const events = fs.readdirSync(logDirectory).filter(name => name.endsWith(".jsonl")).flatMap(name =>
        fs.readFileSync(path.join(logDirectory, name), "utf8").trim().split("\n")
          .map(line => JSON.parse(line) as { event: string; payload: string }));
      const terminals = events.filter(event => event.event === "agentify.run_end");
      assert.equal(terminals.length, 1, "handoff must not emit an extra terminal outcome");
      assert.equal((JSON.parse(terminals[0]!.payload) as { status: string }).status === "success", repaired);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}


test("coverage recovery preserves specialist state after transport normalization", async () => {
  const { cwd, head } = createRepository();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-coverage-boundary-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const budget = new AuditResourceBudget();
  const mapPath = path.join(cwd, ".agentify/runtime/audit/codebase_map.json");
  let calls = 0;
  let testedProposals = 0;
  try {
    const compiled = compileSpecialistEvidence(aqaShapedMap(), { cwd });
    assert.equal(compiled.complete, true);
    const map = attestCodebaseMap(compiled.map, head);
    delete map.explorer_receipts;
    const lifecycle = structuredClone(map.meta.lifecycle);
    map.meta.lifecycle.sdlc_model = "";
    map.meta.lifecycle.issue_types = [];
    map.coverage.D9_process.status = "gap";
    const specialistSnapshot = JSON.stringify(map.concern_evidence);
    const runtime: AgentRuntime = { async runSession(options) {
      calls += 1;
      assert.equal(options.auditResourceBudget, budget);
      if (calls === 1) {
        fs.mkdirSync(path.dirname(mapPath), { recursive: true });
        fs.writeFileSync(mapPath, JSON.stringify(map));
        return { turns: 1, costUsd: 0, aborted: false };
      }
      if (calls === 2) {
        assert.equal(options.spawnExplorerPurpose, "coverage-recovery");
        assert.match(options.systemPrompt, /bounded coverage-recovery controller/);
        assert.ok(!options.tools.includes("write_map"));
        assert.ok(!options.customTools?.some(tool => tool.name === "write_map"));
        assert.ok(!options.userPrompt.includes("explorer_receipt"));
        const tool = options.customTools!.find(tool => tool.name === "write_map_delta")!;
        const before = fs.readFileSync(mapPath, "utf8");
        const evidence = { concerns: [], not_concerns: [] };
        const rawProposals = [
          { delta: { concern_evidence: evidence } },
          { delta: JSON.stringify({ concern_evidence: evidence }) },
          { delta: { "concern_evidence.concerns": [] } },
          { delta: JSON.stringify({ "concern_evidence.concerns": [] }) },
          { delta: { meta: { concern_evidence: evidence } } },
          { delta: JSON.stringify({ meta: { concern_evidence: evidence } }) },
          { delta: { meta: { lifecycle: { concerns: [map.concern_evidence!.concerns[0]] } } } },
          { delta: { meta: { lifecycle: { concern_evidence: { concerns: [map.concern_evidence!.concerns[0]] } } } } },
          { delta: {}, core_owner: { path: "compile.sh", concern: map.concern_evidence!.concerns[0]!.concern } },
          { delta: {}, claim_correction: { concern: "fixture", digest: "0".repeat(64), claim: "one_line", statement: "Changed", rationale: "No authorization" } },
          ...["specialist_reviews", "explorer_receipts", "audit_budget_checkpoint", "expert_evidence"]
            .map(key => ({ delta: { [key]: {} } })),
        ];
        for (const raw of rawProposals) {
          for (const sdkPrepared of [false, true]) {
            const input = structuredClone(raw);
            const proposal = sdkPrepared && tool.prepareArguments ? await tool.prepareArguments(input) : input;
            const result = await tool.execute("forbidden", proposal, undefined, undefined, { cwd } as never) as { isError?: boolean; details?: { coverage_recovery_refused?: boolean } };
            assert.equal(result.isError, true, JSON.stringify(raw));
            assert.equal(result.details?.coverage_recovery_refused, true, JSON.stringify(raw));
            assert.equal(fs.readFileSync(mapPath, "utf8"), before, "rejection cannot write a map or exploration checkpoint");
            assert.deepEqual(input, raw, "phase checking must not mutate caller arguments");
            testedProposals += 1;
          }
        }
        const result = await tool.execute("coverage", {
          delta: JSON.stringify({ meta: { lifecycle } }), merge_strategy: "deep_merge",
          dimension: "D9_process", confidence: "high", evidence_summary: "Fixture process metadata observed in README.",
          evidence: [{ path: "README.md", excerpt: "README.md", kind: "positive" }],
        }, undefined, undefined, { cwd } as never) as { isError?: boolean };
        assert.notEqual(result.isError, true);
        const persisted = JSON.parse(fs.readFileSync(mapPath, "utf8")) as CodebaseMap;
        assert.equal(persisted.coverage.D9_process.status, "covered");
        assert.equal(JSON.stringify(persisted.concern_evidence), specialistSnapshot);
        assert.ok(options.signal?.aborted, "metadata closure must hand off without another broad provider request");
        return { turns: 1, costUsd: 0, aborted: true };
      }
      assert.equal(calls, 3, "one recovery phase followed by one receipt-repair phase");
      assert.equal(options.spawnExplorerPurpose, "specialist-repair");
      assert.equal(budget.snapshot().coverage_recovery_passes, 1);
      assert.equal(budget.snapshot().semantic_repair_passes, 1);
      options.onEvent?.({ type: "tool_execution_end", toolName: "spawn_explorer", isError: false,
        resultText: "Sub-agent (mode=concern_scout) explored .\n\n## Report\n",
        details: { mode: "concern_scout", target_path: ".", report_concern: null } } as never);
      for (const concern of map.concern_evidence!.concerns) {
        options.onEvent?.({ type: "tool_execution_end", toolName: "spawn_explorer", isError: false,
          resultText: `Sub-agent (mode=concern_tracer) explored .\n\n## Report\nconcern: ${concern.concern}`,
          details: { mode: "concern_tracer", target_path: ".", expected_concern: concern.concern,
            report_concern: concern.concern, observed_paths: concernEvidencePaths(concern) } } as never);
      }
      return { turns: 1, costUsd: 0, aborted: false };
    } };
    await runRepositoryAudit({ cwd, ui: new RepairUi(), runtime, auditResourceBudget: budget,
      config: { schemaVersion: 1, thinkingLevel: "high", models: {} } });
    assert.equal(calls, 3);
    assert.equal(testedProposals, 28, "every inline, serialized and normalized alias must actually execute");
    assert.equal(assessExplorerReceiptAttestation(JSON.parse(fs.readFileSync(mapPath, "utf8")), cwd).complete, true);
    assert.equal(budget.snapshot().model_calls, 3);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});


for (const missingReceipt of [false, true]) {
test(`review execution failures do not start evidence repair without a source obligation: ${missingReceipt}`, async () => {
  const repository = createRepository();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-review-only-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const stateDir = ".agentify/runtime/audit";
  const mapPath = path.join(repository.cwd, stateDir, "codebase_map.json");
  try {
    const compiled = compileSpecialistEvidence(aqaShapedMap(), { cwd: repository.cwd });
    assert.equal(compiled.complete, true, compiled.reasons.join("; "));
    const map = attestCodebaseMap(compiled.map, repository.head);
    delete map.specialist_reviews;
    const missing = map.explorer_receipts!.receipts.find(receipt => receipt.mode === "concern_tracer")!;
    if (missingReceipt) missing.success = false;
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, JSON.stringify(map));
    const budget = new AuditResourceBudget();
    let reviews = 0;
    let repairs = 0;
    const runtime: AgentRuntime = { async runSession(options) {
      if (options.tools.includes("submit_specialist_review")) {
        reviews += 1;
        return { turns: 1, costUsd: 0, aborted: true };
      }
      if (options.spawnExplorerPurpose === "specialist-repair") {
        repairs += 1;
        assert.match(options.userPrompt, /Pending review execution, not rejected source/);
        assert.match(options.userPrompt, /do not rewrite or retrace them solely/i);
        const concern = map.concern_evidence!.concerns.find(item => item.concern === missing.report_concern)!;
        options.onEvent?.({ type: "tool_execution_end", toolName: "spawn_explorer", isError: false,
          resultText: `Sub-agent (mode=concern_tracer) explored .\n\n## Report\nconcern: ${concern.concern}`,
          details: { mode: "concern_tracer", target_path: ".", expected_concern: concern.concern,
            report_concern: concern.concern, observed_paths: concernEvidencePaths(concern) },
        } as never);
      }
      return { turns: 1, costUsd: 0, aborted: false };
    } };
    await assert.rejects(runRepositoryAudit({ cwd: repository.cwd, runtime, ui: new RepairUi(),
      auditResourceBudget: budget, config: { schemaVersion: 1, thinkingLevel: "high", models: {} } }),
    /specialist discovery did not reach semantic closure/);
    assert.equal(repairs, missingReceipt ? 1 : 0, "only independent missing source receipts can start repair");
    assert.equal(reviews, map.concern_evidence!.concerns.length,
      "each exact body keeps the existing single review attempt; no hidden same-run retry");
    assert.equal(budget.snapshot().semantic_repair_passes, missingReceipt ? 1 : 0);
    const persisted = JSON.parse(fs.readFileSync(mapPath, "utf8")) as CodebaseMap;
    assert.deepEqual(persisted.concern_evidence, map.concern_evidence);
    assert.equal(assessExplorerReceiptAttestation(persisted, repository.cwd).complete, true);
    assert.ok(persisted.specialist_reviews!.records.every(record => record.retryable === true && record.failure !== null));
    const logDir = path.join(home, ".agentify/logs/agentify");
    const terminals = fs.readdirSync(logDir).filter(name => name.endsWith(".jsonl")).flatMap(name =>
      fs.readFileSync(path.join(logDir, name), "utf8").trim().split("\n")
        .map(line => JSON.parse(line) as { event: string; payload: string }))
      .filter(row => row.event === "agentify.run_end");
    assert.equal(terminals.length, 1);
    assert.notEqual(JSON.parse(terminals[0]!.payload).status, "success");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repository.cwd, { recursive: true, force: true });
  }
});

}
