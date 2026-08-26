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
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

type Concern = NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, relativePath: string): void {
  const destination = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${relativePath}\n`);
}

function concern(name: string, implementation: string, tests: string): Concern {
  return {
    concern: name,
    one_line: `Owns ${name}.`,
    covers: `End-to-end behavior for ${name}.`,
    excludes: "Adjacent subsystems are separate concerns.",
    flows: [{
      name: `${name} implementation to regression suite`,
      description: `Trace ${name} from implementation to tests.`,
      steps: [
        { path: implementation, what_happens: `${name} is implemented.` },
        { path: tests, what_happens: `${name} is regression-tested.` },
      ],
    }],
    touchpoints: [
      {
        path: implementation,
        symbol: null,
        role: `${name} implementation.`,
        line_range: null,
        centrality: "core",
      },
      {
        path: tests,
        symbol: null,
        role: `${name} regression suite.`,
        line_range: null,
        centrality: "supporting",
      },
    ],
    invariants: [],
    pitfalls: [],
    entry_questions: [`Does this change alter ${name}?`],
    validation: [`pytest ${tests}`],
    spans_subtrees: [implementation.split("/")[0]!, tests.split("/")[0]!],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-26T00:00:00.000Z",
  };
}

test("tracked source-test mirrors prevent omitted subsystems from closing", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-mirror-closure-"));
  try {
    for (const relativePath of [
      "src/click/core.py",
      "tests/test_core.py",
      "src/click/shell_completion.py",
      "tests/test_shell_completion.py",
      "src/click/formatting.py",
      "tests/test_formatting.py",
    ]) write(cwd, relativePath);
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");

    const map = makeValidCodebaseMap();
    delete map.expert_evidence;
    map.meta.project_type = "typed Python CLI library";
    map.meta.languages = ["python"];
    map.meta.lifecycle.agent_definitions = { count: 0, paths: [] };
    map.skeleton.top_level_tree = ["src/", "tests/"];
    map.skeleton.entry_points = [{
      path: "src/click/core.py",
      role: "command execution",
      language: "python",
      run_command: "python -m pytest",
    }];
    map.skeleton.first_5_files_for_fresh_agent = [{
      path: "src/click/core.py",
      why: "command execution",
    }];
    map.module_graph.edges = [{
      from: "src/click/core.py",
      to: "tests/test_core.py",
      kind: "behavioral regression",
    }];
    map.module_graph.parallelizable_subtrees = [];
    map.module_graph.shared_abstractions = [];
    map.module_graph.shared_state = [];
    map.type_contract_surface.type_definitions = [];
    map.type_contract_surface.typescript_interfaces = [];
    map.type_contract_surface.pydantic_models = [];
    map.type_contract_surface.db_models = [];
    map.type_contract_surface.api_contracts = [];
    map.type_contract_surface.one_type_trace = null;
    map.pitfalls = [{
      module: "src/click/core.py",
      what: "Command lifecycle changes require regression coverage.",
      consequence: "CLI behavior changes unexpectedly.",
      line_ref: 1,
    }];
    map.operational_surface.build.recipe_file = "src/click/core.py";
    map.open_questions = [
      "Initial draft: gather repository evidence before closing coverage.",
      "Does help formatting intentionally share terminal-width state with command rendering?",
    ];
    map.concern_evidence = {
      concerns: [concern(
        "Command execution",
        "src/click/core.py",
        "tests/test_core.py",
      )],
      not_concerns: [],
    };

    const incomplete = assessSpecialistEvidence(map, { cwd });
    assert.equal(incomplete.complete, false);
    assert.deepEqual(incomplete.uncovered_paths, [
      "src/click/formatting.py",
      "src/click/shell_completion.py",
      "tests/test_formatting.py",
      "tests/test_shell_completion.py",
    ]);
    assert.ok(incomplete.reasons.some((reason) =>
      /implementation\/test subsystem mirrors/.test(reason)
    ));

    map.concern_evidence.concerns.push(
      concern(
        "Shell completion",
        "src/click/shell_completion.py",
        "tests/test_shell_completion.py",
      ),
      concern(
        "Help formatting",
        "src/click/formatting.py",
        "tests/test_formatting.py",
      ),
    );
    const complete = assessSpecialistEvidence(map, { cwd });
    assert.equal(complete.complete, true, complete.reasons.join("; "));
    const reconciled = reconcileSpecialistEvidence(map, complete);
    assert.deepEqual(reconciled.open_questions, [
      "Does help formatting intentionally share terminal-width state with command rendering?",
    ]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
