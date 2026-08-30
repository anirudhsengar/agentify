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

function repository(files: readonly string[]): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-semantic-ownership-"));
  for (const repositoryPath of ["README.md", "package.json", ...files]) {
    const absolute = path.join(cwd, ...repositoryPath.split("/"));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${repositoryPath}\n`);
  }
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "semantic ownership fixture");
  return cwd;
}

function concern(input: {
  name: string;
  covers: string;
  excludes: string;
  core: string;
  test: string;
  supporting?: readonly string[];
}): Concern {
  const supporting = [...(input.supporting ?? [])];
  return {
    concern: input.name,
    one_line: `Owns ${input.name}.`,
    covers: input.covers,
    excludes: input.excludes,
    flows: [{
      name: `${input.name} flow`,
      description: `Traces ${input.name} behavior.`,
      steps: [
        { path: input.core, what_happens: `Executes ${input.name}.` },
        ...supporting.map((repositoryPath) => ({
          path: repositoryPath,
          what_happens: `Consumes ${input.name} state.`,
        })),
        { path: input.test, what_happens: `Verifies ${input.name}.` },
      ],
    }],
    touchpoints: [
      {
        path: input.core,
        symbol: null,
        role: `Core ${input.name} behavior.`,
        line_range: null,
        centrality: "core",
      },
      {
        path: input.test,
        symbol: null,
        role: `Regression coverage for ${input.name}.`,
        line_range: null,
        centrality: "supporting",
      },
      ...supporting.map((repositoryPath) => ({
        path: repositoryPath,
        symbol: null,
        role: `Supporting dependency used by ${input.name}.`,
        line_range: null,
        centrality: "supporting" as const,
      })),
    ],
    invariants: [],
    pitfalls: [],
    entry_questions: [`Does this alter ${input.name}?`],
    validation: ["npm test"],
    spans_subtrees: ["src"],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-27T00:00:00.000Z",
  };
}

function mapWithConcerns(
  entryPoints: readonly string[],
  concerns: Concern[],
): CodebaseMap {
  const map = makeValidCodebaseMap();
  delete map.expert_evidence;
  map.meta.project_type = "semantic ownership fixture";
  map.meta.languages = ["TypeScript"];
  map.skeleton.entry_points = entryPoints.map((repositoryPath) => ({
    path: repositoryPath,
    role: "fixture entry point",
    language: "TypeScript",
    run_command: "npm test",
  }));
  map.skeleton.first_5_files_for_fresh_agent = entryPoints.map((repositoryPath) => ({
    path: repositoryPath,
    why: "fixture behavioral entry point",
  }));
  map.module_graph.edges = [];
  map.module_graph.parallelizable_subtrees = [];
  map.module_graph.shared_abstractions = [];
  map.module_graph.shared_state = [];
  map.pitfalls = [];
  map.operational_surface.build.recipe_file = "package.json";
  map.open_questions = [];
  map.concern_evidence = { concerns, not_concerns: [] };
  return map;
}

test("excluded behavior cannot be attached to a concern as positive semantic evidence", () => {
  const cwd = repository([
    "src/decoder.ts",
    "src/decoder.test.ts",
    "src/form-mapping.ts",
    "src/form-mapping.test.ts",
  ]);
  try {
    const decoding = concern({
      name: "request decoding",
      covers: "Decoder selection and decoded request values.",
      excludes: "Form mapping internals are a separate specialty.",
      core: "src/decoder.ts",
      test: "src/decoder.test.ts",
    });
    const map = mapWithConcerns(["src/decoder.ts"], [decoding]);
    const incomplete = assessSpecialistEvidence(map, { cwd });

    assert.equal(incomplete.complete, false);
    assert.ok(incomplete.uncovered_paths.includes("src/form-mapping.ts"));
    assert.ok(incomplete.uncovered_paths.includes("src/form-mapping.test.ts"));
    assert.ok(!incomplete.attachments.some((attachment) =>
      attachment.concern === "request decoding"
      && attachment.paths.some((repositoryPath) => repositoryPath.includes("form-mapping"))
    ));

    map.concern_evidence!.concerns.push(concern({
      name: "form mapping",
      covers: "Maps form fields into typed request destinations.",
      excludes: "Decoder selection remains in request decoding.",
      core: "src/form-mapping.ts",
      test: "src/form-mapping.test.ts",
    }));
    const complete = assessSpecialistEvidence(map, { cwd });
    assert.equal(complete.complete, true, complete.reasons.join("; "));

    map.concern_evidence!.concerns.push(concern({
      name: "form mapping test suite as a specialist",
      covers: "Duplicates form-mapping behavior while assigning its tests as core ownership.",
      excludes: "Decoder selection remains in request decoding.",
      core: "src/form-mapping.test.ts",
      test: "src/decoder.test.ts",
      supporting: ["src/form-mapping.ts"],
    }));
    const testCore = assessSpecialistEvidence(map, { cwd });
    assert.equal(testCore.complete, false);
    assert.ok(
      testCore.reasons.some((reason) => /test-only core ownership.*implementation context/i.test(reason)),
      testCore.reasons.join("; "),
    );

  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("test-only repositories may own their executable test behavior as core", () => {
  const cwd = repository([
    "tests/orchestration",
    "tests/orchestration.spec",
  ]);
  try {
    const map = mapWithConcerns(
      ["tests/orchestration"],
      [concern({
        name: "executable conformance orchestration",
        covers: "Runs the repository's conformance product and verifies its result contract.",
        excludes: "Package metadata and documentation.",
        core: "tests/orchestration",
        test: "tests/orchestration.spec",
      })],
    );
    const assessment = assessSpecialistEvidence(map, { cwd });
    assert.equal(assessment.complete, true, assessment.reasons.join("; "));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalization promotes a uniquely cited implementation out of test-only core ownership", () => {
  const cwd = repository([
    "src/parser.ts",
    "src/parser.test.ts",
  ]);
  try {
    const parser = concern({
      name: "request grammar and rejection",
      covers: "Parses request grammar and preserves rejection behavior.",
      excludes: "Transport and response rendering.",
      core: "src/parser.test.ts",
      test: "src/parser.test.ts",
      supporting: ["src/parser.ts"],
    });
    const map = mapWithConcerns(["src/parser.ts"], [parser]);
    const compilation = compileSpecialistEvidence(map, { cwd });

    assert.equal(compilation.complete, true, compilation.reasons.join("; "));
    assert.equal(
      compilation.map.concern_evidence?.concerns[0]?.touchpoints
        .find((touchpoint) => touchpoint.path === "src/parser.ts")?.centrality,
      "core",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a shared high-signal implementation needs explicit core behavioral ownership", () => {
  const cwd = repository([
    "src/auth.ts",
    "src/auth.test.ts",
    "src/render.ts",
    "src/render.test.ts",
    "src/context.ts",
    "src/context.test.ts",
  ]);
  try {
    const map = mapWithConcerns(
      ["src/auth.ts", "src/render.ts"],
      [
        concern({
          name: "authentication",
          covers: "Credential verification and authenticated request state.",
          excludes: "Response rendering and Context lifecycle mechanics.",
          core: "src/auth.ts",
          test: "src/auth.test.ts",
          supporting: ["src/context.ts"],
        }),
        concern({
          name: "response rendering",
          covers: "Serializes response bodies and commits output.",
          excludes: "Authentication and Context lifecycle mechanics.",
          core: "src/render.ts",
          test: "src/render.test.ts",
          supporting: ["src/context.ts"],
        }),
      ],
    );

    const incomplete = assessSpecialistEvidence(map, { cwd });
    assert.equal(incomplete.complete, false);
    assert.ok(incomplete.uncovered_paths.includes("src/context.ts"));
    assert.ok(incomplete.uncovered_clusters.some((cluster) =>
      cluster.implementation_paths.includes("src/context.ts")
    ));

    map.concern_evidence!.concerns.push(concern({
      name: "request Context lifecycle",
      covers: "Handler progression, abort state, copies, errors, and request-local metadata.",
      excludes: "Credential policy and response serialization.",
      core: "src/context.ts",
      test: "src/context.test.ts",
    }));
    const complete = assessSpecialistEvidence(map, { cwd });
    assert.equal(complete.complete, true, complete.reasons.join("; "));

    map.concern_evidence!.concerns.push(concern({
      name: "Context lifecycle implementation detail",
      covers: "Duplicates the same request Context core implementation under a location-oriented label.",
      excludes: "Credential policy and response serialization.",
      core: "src/context.ts",
      test: "src/context.test.ts",
    }));
    const ambiguous = assessSpecialistEvidence(map, { cwd });
    assert.equal(ambiguous.complete, false);
    assert.ok(
      ambiguous.reasons.some((reason) =>
        /src\/context\.ts/i.test(reason) && /multiple core owners/i.test(reason)
      ),
      ambiguous.reasons.join("; "),
    );
    const ambiguousCompilation = compileSpecialistEvidence(map, { cwd });
    assert.equal(ambiguousCompilation.complete, false);
    assert.ok(ambiguousCompilation.reasons.some((reason) =>
      /src\/context\.ts/i.test(reason) && /multiple core owners/i.test(reason)
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalization gives a shared core path to the sole concern that depends on it", () => {
  const cwd = repository([
    "src/auth.ts",
    "src/auth.test.ts",
    "src/render.ts",
    "src/render.test.ts",
    "src/context.ts",
    "src/context.test.ts",
  ]);
  try {
    const authentication = concern({
      name: "authentication",
      covers: "Credential verification through shared request context.",
      excludes: "Response rendering and Context lifecycle mechanics.",
      core: "src/auth.ts",
      test: "src/auth.test.ts",
      supporting: ["src/context.ts"],
    });
    authentication.touchpoints.find((entry) => entry.path === "src/context.ts")!.centrality = "core";
    const rendering = concern({
      name: "response rendering",
      covers: "Response serialization through shared request context.",
      excludes: "Authentication and Context lifecycle mechanics.",
      core: "src/render.ts",
      test: "src/render.test.ts",
      supporting: ["src/context.ts"],
    });
    rendering.touchpoints.find((entry) => entry.path === "src/context.ts")!.centrality = "core";
    const contextLifecycle = concern({
      name: "request Context lifecycle",
      covers: "Handler progression, abort state, copies, errors, and request-local metadata.",
      excludes: "Credential policy and response serialization.",
      core: "src/context.ts",
      test: "src/context.test.ts",
    });
    const map = mapWithConcerns(
      ["src/auth.ts", "src/render.ts", "src/context.ts"],
      [authentication, rendering, contextLifecycle],
    );

    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.complete, true, compiled.reasons.join("; "));
    const owners = compiled.map.concern_evidence!.concerns.filter((candidate) =>
      candidate.touchpoints.some((entry) =>
        entry.path === "src/context.ts" && entry.centrality === "core"
      )
    );
    assert.deepEqual(owners.map((entry) => entry.concern), ["request Context lifecycle"]);
    assert.ok(compiled.map.concern_evidence!.concerns
      .filter((entry) => entry.concern !== "request Context lifecycle")
      .every((entry) => entry.touchpoints.some((touchpoint) =>
        touchpoint.path === "src/context.ts" && touchpoint.centrality === "supporting"
      )));

    const repeated = compileSpecialistEvidence(compiled.map, { cwd });
    assert.equal(repeated.complete, true, repeated.reasons.join("; "));
    assert.strictEqual(repeated.map, compiled.map);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalization gives shared orchestration to its unique dependent supporting claimant", () => {
  const cwd = repository([
    "src/command.ts",
    "src/argument.ts",
    "src/error.ts",
    "tests/routing.test.ts",
    "tests/argument.test.ts",
    "tests/error.test.ts",
  ]);
  try {
    const routing = concern({
      name: "routing and dispatch",
      covers: "Routes commands through the shared dispatcher.",
      excludes: "Argument coercion and error formatting.",
      core: "tests/routing.test.ts",
      test: "tests/routing.test.ts",
      supporting: ["src/command.ts"],
    });
    const argumentsConcern = concern({
      name: "argument coercion",
      covers: "Coerces positional arguments through command integration.",
      excludes: "Routing and error formatting.",
      core: "src/argument.ts",
      test: "tests/argument.test.ts",
      supporting: ["src/command.ts"],
    });
    argumentsConcern.touchpoints.find((entry) => entry.path === "src/command.ts")!.centrality = "core";
    const errors = concern({
      name: "error formatting",
      covers: "Formats errors through command integration.",
      excludes: "Routing and argument coercion.",
      core: "src/error.ts",
      test: "tests/error.test.ts",
      supporting: ["src/command.ts"],
    });
    errors.touchpoints.find((entry) => entry.path === "src/command.ts")!.centrality = "core";
    const map = mapWithConcerns(["src/command.ts", "src/argument.ts", "src/error.ts"], [
      routing,
      argumentsConcern,
      errors,
    ]);

    const resolved = assessSpecialistEvidence(map, { cwd });
    assert.ok(resolved.core_ownership_resolutions.some((entry) =>
      entry.path === "src/command.ts" && entry.concern === "routing and dispatch"
    ));
    assert.ok(!resolved.reasons.some((reason) => /src\/command\.ts.*multiple core owners/i.test(reason)));

    map.concern_evidence!.concerns.push(concern({
      name: "alternate routing",
      covers: "Duplicates routing through the same dispatcher.",
      excludes: "Argument coercion and error formatting.",
      core: "tests/routing.test.ts",
      test: "tests/routing.test.ts",
      supporting: ["src/command.ts"],
    }));
    const tied = assessSpecialistEvidence(map, { cwd });
    assert.ok(!tied.core_ownership_resolutions.some((entry) => entry.path === "src/command.ts"));
    assert.ok(tied.reasons.some((reason) => /src\/command\.ts.*multiple core owners/i.test(reason)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
