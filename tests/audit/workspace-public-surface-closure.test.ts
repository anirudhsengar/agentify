import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  assessSpecialistEvidence,
  compileSpecialistEvidence,
  type CodebaseMap,
} from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

type Concern = NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number];

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function write(cwd: string, repositoryPath: string, content: string): void {
  const absolute = path.join(cwd, ...repositoryPath.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function concern(input: {
  name: string;
  core: string;
  supporting?: string[];
}): Concern {
  const paths = [input.core, ...(input.supporting ?? [])];
  const steps = paths.length > 1
    ? paths.map((repositoryPath, index) => ({
        path: repositoryPath,
        what_happens: `Executes verified operation ${index + 1} for ${input.name}.`,
      }))
    : [
        { path: input.core, what_happens: `Declares the public ${input.name} API.` },
        { path: input.core, what_happens: `Expands and validates ${input.name} behavior.` },
      ];
  return {
    concern: input.name,
    one_line: `Owns ${input.name}.`,
    covers: `Public and inline-tested behavior for ${input.name}.`,
    excludes: "Other workspace package surfaces remain separate.",
    flows: [{
      name: `${input.name} flow`,
      description: `Observed ${input.name} behavior.`,
      steps,
    }],
    touchpoints: paths.map((repositoryPath, index) => ({
      path: repositoryPath,
      symbol: null,
      role: `${index === 0 ? "Core" : "Supporting"} ${input.name} surface.`,
      line_range: null,
      centrality: index === 0 ? "core" as const : "supporting" as const,
    })),
    invariants: [],
    pitfalls: [],
    entry_questions: [`Does this alter ${input.name}?`],
    validation: ["cargo test --workspace"],
    spans_subtrees: [...new Set(paths.map((repositoryPath) => repositoryPath.split("/")[0]!))],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-27T00:00:00.000Z",
  };
}

function createWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-workspace-surfaces-"));
  write(cwd, "README.md", "# fixture\n");
  write(cwd, "Cargo.toml", "[workspace]\nmembers = [\"axum\", \"axum-extra\", \"axum-macros\"]\n");
  write(cwd, "axum/Cargo.toml", "[package]\nname = \"axum\"\nversion = \"0.1.0\"\n");
  write(cwd, "axum/src/lib.rs", "pub mod routing;\n");
  write(cwd, "axum/src/routing.rs", "pub fn route() {}\n#[cfg(test)] mod tests { #[test] fn route_works() {} }\n");
  write(cwd, "axum-extra/Cargo.toml", "[package]\nname = \"axum-extra\"\nversion = \"0.1.0\"\n");
  write(cwd, "axum-extra/src/lib.rs", "pub mod response;\n");
  write(cwd, "axum-extra/src/response/mod.rs", "pub fn respond() {}\n#[cfg(test)] mod tests { #[test] fn response_works() {} }\n");
  write(cwd, "axum-macros/Cargo.toml", "[package]\nname = \"axum-macros\"\nversion = \"0.1.0\"\n");
  write(cwd, "axum-macros/src/lib.rs", "#[proc_macro_attribute] pub fn debug_handler() {}\n#[cfg(test)] mod tests { #[test] fn expands() {} }\n");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "workspace fixture");
  return cwd;
}

function workspaceMap(): CodebaseMap {
  const map = makeValidCodebaseMap();
  delete map.expert_evidence;
  map.meta.project_type = "Rust workspace";
  map.meta.languages = ["Rust"];
  map.skeleton.entry_points = [{
    path: "axum/src/lib.rs",
    role: "primary crate API",
    language: "Rust",
    run_command: "cargo test --workspace",
  }];
  map.skeleton.first_5_files_for_fresh_agent = [{
    path: "axum/src/lib.rs",
    why: "primary public API",
  }];
  map.module_graph.edges = [];
  map.module_graph.parallelizable_subtrees = [];
  map.module_graph.shared_abstractions = [];
  map.module_graph.shared_state = [];
  map.type_contract_surface.type_definitions = [];
  map.type_contract_surface.typescript_interfaces = [];
  map.type_contract_surface.pydantic_models = [];
  map.type_contract_surface.db_models = [];
  map.type_contract_surface.api_contracts = [];
  map.type_contract_surface.one_type_trace = null;
  map.pitfalls = [];
  map.operational_surface.build.recipe_file = "Cargo.toml";
  map.open_questions = [];
  map.concern_evidence = {
    concerns: [concern({
      name: "routing",
      core: "axum/src/lib.rs",
      supporting: ["axum/src/routing.rs"],
    })],
    not_concerns: [],
  };
  return map;
}

test("workspace public surfaces and inline-tested modules remain semantic obligations", () => {
  const cwd = createWorkspace();
  try {
    const map = workspaceMap();
    const incomplete = assessSpecialistEvidence(map, { cwd });
    assert.equal(incomplete.complete, false);
    for (const repositoryPath of [
      "axum-extra/src/lib.rs",
      "axum-extra/src/response/mod.rs",
      "axum-macros/src/lib.rs",
    ]) {
      assert.ok(incomplete.uncovered_paths.includes(repositoryPath), repositoryPath);
    }
    assert.ok(incomplete.repository_clusters.some((cluster) =>
      cluster.kind === "workspace-public-surface"
      && cluster.implementation_paths.includes("axum-macros/src/lib.rs")
    ));
    assert.ok(incomplete.repository_clusters.some((cluster) =>
      cluster.implementation_paths.includes("axum-extra/src/response/mod.rs")
      && cluster.test_paths.includes("axum-extra/src/response/mod.rs")
    ));

    map.concern_evidence!.concerns.push(
      concern({
        name: "response extensions",
        core: "axum-extra/src/lib.rs",
        supporting: ["axum-extra/src/response/mod.rs"],
      }),
      concern({
        name: "procedural macro derives and diagnostics",
        core: "axum-macros/src/lib.rs",
      }),
    );
    const complete = assessSpecialistEvidence(map, { cwd });
    assert.equal(complete.complete, true, complete.reasons.join("; "));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an observed public type trace inherits one unambiguous runtime core owner", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-public-type-trace-"));
  try {
    write(cwd, "lib/command.js", "export class Command {}\n");
    write(cwd, "lib/option.js", "export class Option {}\n");
    write(cwd, "typings/index.d.ts", "export class Command {}\n");
    write(cwd, "tests/command.test.js", "// command behavior\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "type trace fixture");

    const map = workspaceMap();
    map.meta.project_type = "JavaScript CLI library";
    map.meta.languages = ["JavaScript", "TypeScript"];
    map.skeleton.entry_points = [{
      path: "lib/command.js",
      role: "runtime command API",
      language: "JavaScript",
      run_command: "npm test",
    }];
    map.skeleton.first_5_files_for_fresh_agent = [{ path: "lib/command.js", why: "runtime API" }];
    map.operational_surface.build.recipe_file = "lib/command.js";
    map.concern_evidence = { concerns: [concern({
      name: "command routing",
      core: "lib/command.js",
      supporting: ["tests/command.test.js"],
    })], not_concerns: [] };
    map.type_contract_surface.typescript_interfaces = [{
      path: "typings/index.d.ts",
      name: "Command",
      fields: ["commands"],
    }];
    map.type_contract_surface.one_type_trace = {
      name: "Command",
      flow: ["typings/index.d.ts: declaration", "lib/command.js: runtime implementation"],
    };

    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.complete, true, compiled.reasons.join("; "));
    assert.equal(
      compiled.map.concern_evidence?.concerns[0]?.touchpoints
        .find((touchpoint) => touchpoint.path === "typings/index.d.ts")?.centrality,
      "core",
    );

    map.concern_evidence.concerns.push(concern({ name: "option values", core: "lib/option.js" }));
    map.type_contract_surface.one_type_trace!.flow.push("lib/option.js: adjacent runtime implementation");
    const ambiguous = compileSpecialistEvidence(map, { cwd });
    assert.equal(ambiguous.complete, false);
    assert.ok(ambiguous.reasons.some((reason) => /typings\/index\.d\.ts/i.test(reason)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
