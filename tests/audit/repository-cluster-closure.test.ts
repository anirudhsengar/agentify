import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  assessSpecialistEvidence,
  compileSpecialistEvidence,
  reconcileSpecialistEvidence,
  type CodebaseMap,
} from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

type Concern = NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, repositoryPath: string): void {
  const absolute = path.join(cwd, ...repositoryPath.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${repositoryPath}\n`);
}

function concern(name: string, implementationPath: string, testPath: string): Concern {
  return {
    concern: name,
    one_line: `Owns ${name}.`,
    covers: `End-to-end behavior for ${name}.`,
    excludes: "Adjacent contracts are recorded separately.",
    flows: [{
      name: `${name} behavior`,
      description: `Implementation and regression coverage for ${name}.`,
      steps: [
        { path: implementationPath, what_happens: "Implements the behavior." },
        { path: testPath, what_happens: "Verifies the behavior." },
      ],
    }],
    touchpoints: [
      {
        path: implementationPath,
        symbol: null,
        role: `Implementation for ${name}.`,
        line_range: null,
        centrality: "core",
      },
      {
        path: testPath,
        symbol: null,
        role: `Regression coverage for ${name}.`,
        line_range: null,
        centrality: "supporting",
      },
    ],
    invariants: [],
    pitfalls: [],
    entry_questions: [`Does this change alter ${name}?`],
    validation: [`pytest ${testPath}`],
    spans_subtrees: ["src", "tests"],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-26T00:00:00.000Z",
  };
}

function createRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-cluster-closure-"));
  for (const repositoryPath of [
    "README.md",
    "pyproject.toml",
    "src/click/command.py",
    "src/click/formatting.py",
    "src/click/shell_completion.py",
    "tests/test_command.py",
    "tests/test_formatting.py",
    "tests/test_shell_completion.py",
    // Documentation with a matching test-like basename must not be mistaken
    // for an implementation unit.
    "docs/testing.md",
    "tests/test_testing.py",
  ]) write(cwd, repositoryPath);
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "cluster fixture");
  return cwd;
}

function clickShapedMap(): CodebaseMap {
  const map = makeValidCodebaseMap();
  delete map.expert_evidence;
  map.meta.project_type = "typed Python CLI library";
  map.meta.languages = ["Python"];
  map.skeleton.entry_points = [{
    path: "src/click/command.py",
    role: "command entry point",
    language: "Python",
    run_command: "python -m pytest",
  }];
  map.skeleton.first_5_files_for_fresh_agent = [{
    path: "src/click/command.py",
    why: "command lifecycle",
  }];
  map.module_graph.edges = [];
  map.module_graph.parallelizable_subtrees = [];
  map.module_graph.shared_abstractions = [];
  map.module_graph.shared_state = [];
  map.pitfalls = [{
    module: "src/click/command.py",
    what: "Invocation ordering is observable.",
    consequence: "Public CLI behavior changes.",
    line_ref: 1,
  }];
  map.operational_surface.build.recipe_file = "pyproject.toml";
  map.open_questions = ["Initial draft: gather repository evidence before closing coverage."];
  map.concern_evidence = {
    concerns: [concern(
      "command invocation",
      "src/click/command.py",
      "tests/test_command.py",
    )],
    not_concerns: [],
  };
  return map;
}

test("repository-wide implementation/test mirrors prevent false specialist closure", () => {
  const cwd = createRepository();
  try {
    const map = clickShapedMap();
    const incomplete = assessSpecialistEvidence(map, { cwd });

    assert.equal(incomplete.complete, false);
    assert.deepEqual(
      incomplete.repository_clusters.map((cluster) => cluster.cluster_key),
      ["command", "formatting", "shell-completion"],
    );
    assert.deepEqual(
      incomplete.uncovered_clusters.map((cluster) => cluster.cluster_key),
      ["formatting", "shell-completion"],
    );
    assert.ok(incomplete.uncovered_paths.includes("src/click/shell_completion.py"));
    assert.ok(incomplete.uncovered_paths.includes("tests/test_shell_completion.py"));
    assert.ok(incomplete.reasons.some((reason) => /implementation\/test clusters/i.test(reason)));

    map.concern_evidence!.concerns.push(
      concern("help formatting", "src/click/formatting.py", "tests/test_formatting.py"),
      concern(
        "shell completion protocol",
        "src/click/shell_completion.py",
        "tests/test_shell_completion.py",
      ),
    );
    const complete = assessSpecialistEvidence(map, { cwd });
    assert.equal(complete.complete, true, complete.reasons.join("; "));
    assert.deepEqual(complete.uncovered_clusters, []);

    const reconciled = reconcileSpecialistEvidence(map, complete);
    assert.notStrictEqual(reconciled, map);
    assert.deepEqual(reconciled.open_questions, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalization keeps an explicitly excluded sibling behavior unresolved", () => {
  const cwd = createRepository();
  try {
    const map = clickShapedMap();
    const command = map.concern_evidence!.concerns[0]!;
    command.excludes = "Help formatting remains a separate specialist concern.";
    command.touchpoints[0]!.role += " Formatting is delegated to the adjacent formatter.";
    const compiled = compileSpecialistEvidence(map, { cwd });

    assert.equal(compiled.complete, false);
    assert.ok(compiled.reasons.some((reason) => reason.includes("src/click/formatting.py")));
    assert.ok(compiled.reasons.some((reason) => reason.includes("src/click/shell_completion.py")));
    const normalizedCommand = compiled.map.concern_evidence!.concerns.find((entry) =>
      entry.concern === "command invocation"
    );
    assert.ok(normalizedCommand);
    assert.equal(normalizedCommand.touchpoints.some((touchpoint) =>
      touchpoint.path === "src/click/formatting.py"
      || touchpoint.path === "src/click/shell_completion.py"
    ), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalization assigns a mirrored cluster to its unique complete claimant", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-cluster-owner-"));
  for (const repositoryPath of [
    "README.md",
    "package.json",
    "src/options.ts",
    "tests/options-core.test.ts",
    "src/error.ts",
    "tests/error.test.ts",
    "examples/options-required.js",
    "tests/options-required.test.js",
  ]) write(cwd, repositoryPath);
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "cluster owner fixture");
  try {
    const optionContract = concern(
      "option declaration and required-value contract",
      "src/options.ts",
      "tests/options-core.test.ts",
    );
    optionContract.covers += " Required options are demonstrated and regression-tested as a mirrored public behavior.";
    optionContract.touchpoints.push(
      {
        path: "examples/options-required.js",
        symbol: "requiredOption",
        role: "Public required-option implementation example.",
        line_range: null,
        centrality: "supporting",
      },
      {
        path: "tests/options-required.test.js",
        symbol: "required option cases",
        role: "Mirrored required-option regression contract.",
        line_range: null,
        centrality: "supporting",
      },
    );
    const errorContract = concern(
      "error and exit behavior",
      "src/error.ts",
      "tests/error.test.ts",
    );
    errorContract.touchpoints.push({
      path: "tests/options-required.test.js",
      symbol: "missing required value error",
      role: "Downstream error consumer for a required-option failure.",
      line_range: null,
      centrality: "supporting",
    });

    const map = clickShapedMap();
    map.meta.project_type = "TypeScript CLI library";
    map.meta.languages = ["TypeScript", "JavaScript"];
    map.skeleton.entry_points = ["src/options.ts", "src/error.ts"].map((repositoryPath) => ({
      path: repositoryPath,
      role: "fixture entry point",
      language: "TypeScript",
      run_command: "npm test",
    }));
    map.skeleton.first_5_files_for_fresh_agent = map.skeleton.entry_points.map((entry) => ({
      path: entry.path,
      why: entry.role,
    }));
    map.pitfalls = [];
    map.concern_evidence = { concerns: [optionContract, errorContract], not_concerns: [] };

    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.complete, true, compiled.reasons.join("; "));
    for (const repositoryPath of [
      "examples/options-required.js",
      "tests/options-required.test.js",
    ]) {
      const owners = compiled.map.concern_evidence!.concerns.filter((candidate) =>
        candidate.touchpoints.some((touchpoint) =>
          touchpoint.path === repositoryPath && touchpoint.centrality === "core"
        )
      );
      assert.deepEqual(owners.map((entry) => entry.concern), [optionContract.concern]);
    }
    const repeated = compileSpecialistEvidence(compiled.map, { cwd });
    assert.equal(repeated.complete, true, repeated.reasons.join("; "));
    assert.strictEqual(repeated.map, compiled.map);

    errorContract.touchpoints.push({
      path: "examples/options-required.js",
      symbol: "requiredOption",
      role: "Competing complete claim to the public required-option example.",
      line_range: null,
      centrality: "supporting",
    });
    const ambiguous = compileSpecialistEvidence(map, { cwd });
    assert.equal(ambiguous.complete, false);
    assert.ok(ambiguous.reasons.some((reason) => /options-required/i.test(reason)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
