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

function concern(input: {
  name: string;
  covers: string;
  excludes: string;
  touchpoints: Concern["touchpoints"];
  flow: string[];
  invariants?: Concern["invariants"];
}): Concern {
  return {
    concern: input.name,
    one_line: `Owns ${input.name}.`,
    covers: input.covers,
    excludes: input.excludes,
    flows: [{
      name: `${input.name} flow`,
      description: `Observed end-to-end ${input.name} behavior.`,
      steps: input.flow.map((repositoryPath, index) => ({
        path: repositoryPath,
        what_happens: `Performs distinct operation ${index + 1} for ${input.name}.`,
      })),
    }],
    touchpoints: input.touchpoints,
    invariants: input.invariants ?? [],
    pitfalls: [],
    entry_questions: [`Does this change alter ${input.name}?`],
    validation: ["./gradlew test"],
    spans_subtrees: ["src/main/java", "src/test/java"],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-28T00:00:00.000Z",
  };
}

function springProjectionMap(): CodebaseMap {
  const map = makeValidCodebaseMap();
  delete map.expert_evidence;
  map.meta.project_type = "Spring Boot Java web application";
  map.meta.languages = ["Java", "Groovy"];
  map.skeleton.top_level_tree = ["build.gradle", "src/main/java", "src/test/java"];
  map.skeleton.entry_points = [{
    path: "src/main/java/org/example/PetClinicApplication.java",
    role: "Spring Boot entry point",
    language: "Java",
    run_command: "./gradlew bootRun",
  }];
  map.skeleton.first_5_files_for_fresh_agent = [
    {
      path: "src/main/java/org/example/vet/VetController.java",
      why: "Vet HTTP boundary.",
    },
    {
      path: "src/main/java/org/example/PetClinicRuntimeHints.java",
      why: "Native-image registration.",
    },
  ];
  map.skeleton.code_test_mirror = {
    observed: true,
    pattern: "src/test/java mirrors src/main/java",
  };
  map.module_graph.edges = [
    {
      from: "src/main/java/org/example/PetClinicApplication.java",
      to: "src/main/java/org/example/PetClinicRuntimeHints.java",
      kind: "runtime-hint registration",
    },
    {
      from: "src/main/java/org/example/vet/VetController.java",
      to: "src/main/java/org/example/vet/VetRepository.java",
      kind: "repository dependency",
    },
    {
      from: "src/main/java/org/example/PetClinicRuntimeHints.java",
      to: "src/main/java/org/example/vet/Vet.java",
      kind: "serialization hint",
    },
  ];
  map.module_graph.parallelizable_subtrees = [];
  map.module_graph.shared_abstractions = [];
  map.module_graph.shared_state = [];
  map.module_graph.client_server_split = null;
  map.pitfalls = [
    {
      module: "src/main/java/org/example/PetClinicRuntimeHints.java",
      what: "Missing serialization hints fail only in a native image.",
      consequence: "The JVM suite can pass while native execution fails.",
      line_ref: 1,
    },
  ];
  map.operational_surface.build.recipe_file = "build.gradle";
  map.concern_evidence = {
    concerns: [
      concern({
        name: "Vet listings and representation contract",
        covers:
          "Vet list routing, cached repository reads, specialty ordering, and serialized representation behavior.",
        excludes: "Native-image registration, build plugins, and AOT test gating.",
        touchpoints: [
          {
            path: "src/main/java/org/example/vet/VetController.java",
            symbol: "VetController",
            role: "HTTP entry point for vet representations.",
            line_range: null,
            centrality: "core",
          },
          {
            path: "src/main/java/org/example/vet/VetRepository.java",
            symbol: "VetRepository",
            role: "Cached persistence boundary for vet listings.",
            line_range: null,
            centrality: "core",
          },
        ],
        flow: [
          "src/main/java/org/example/vet/VetController.java",
          "src/main/java/org/example/vet/VetRepository.java",
        ],
        invariants: [{
          rule: "Vet specialties remain sorted in every representation.",
          why: "HTML and serialized output share the domain accessor.",
          reference: "src/main/java/org/example/vet/Vet.java",
        }],
      }),
      concern({
        name: "GraalVM native image and AOT hints",
        covers:
          "Application hint registration, reflection serialization metadata, and native-only regression coverage.",
        excludes: "HTTP controllers, cache rendering, and persistence query behavior.",
        touchpoints: [
          {
            path: "src/main/java/org/example/PetClinicApplication.java",
            symbol: "PetClinicApplication",
            role: "Imports runtime hints into AOT processing.",
            line_range: null,
            centrality: "core",
          },
          {
            path: "src/main/java/org/example/PetClinicRuntimeHints.java",
            symbol: "PetClinicRuntimeHints",
            role: "Registers resources and serialization types.",
            line_range: null,
            centrality: "core",
          },
          {
            path: "src/test/java/org/example/vet/VetTests.java",
            symbol: "serialization",
            role: "Pins the Java serialization contract used by native hints.",
            line_range: null,
            centrality: "supporting",
          },
        ],
        flow: [
          "src/main/java/org/example/PetClinicApplication.java",
          "src/main/java/org/example/PetClinicRuntimeHints.java",
          "src/test/java/org/example/vet/VetTests.java",
        ],
      }),
    ],
    not_concerns: [],
  };
  return map;
}

function createSpringRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-specialist-compiler-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  for (const relativePath of [
    "README.md",
    "build.gradle",
    "src/main/java/org/example/PetClinicApplication.java",
    "src/main/java/org/example/PetClinicRuntimeHints.java",
    "src/main/java/org/example/vet/Vet.java",
    "src/main/java/org/example/vet/VetController.java",
    "src/main/java/org/example/vet/VetRepository.java",
    "src/test/java/org/example/vet/VetTests.java",
  ]) {
    write(cwd, relativePath);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

test("specialist compilation rejects normalization-created ownership gaps and reaches an idempotent fixed point", () => {
  const cwd = createSpringRepository();
  try {
    const map = springProjectionMap();
    const before = assessSpecialistEvidence(map, { cwd });
    assert.equal(before.complete, true, before.reasons.join("; "));
    assert.equal(
      map.concern_evidence?.concerns[0]?.touchpoints.some((entry) =>
        entry.path.endsWith("/vet/Vet.java")
      ),
      false,
      "model-authored evidence must remain immutable",
    );

    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.complete, false);
    assert.equal(compiled.status, "incomplete");
    assert.equal(compiled.phase, "post-normalization");
    assert.equal(compiled.normalized, true);
    assert.ok(compiled.reasons.some((reason) => /\bvet\b/i.test(reason)));
    assert.ok(compiled.assessment.uncovered_clusters.some((cluster) =>
      cluster.cluster_key === "vet"
    ));

    const normalizedConcerns = compiled.map.concern_evidence?.concerns ?? [];
    assert.ok(normalizedConcerns.every((entry) =>
      entry.touchpoints.some((touchpoint) =>
        touchpoint.path.endsWith("/vet/Vet.java")
      )
    ));

    const vets = normalizedConcerns.find((entry) =>
      entry.concern === "Vet listings and representation contract"
    );
    const vetTouchpoint = vets?.touchpoints.find((entry) =>
      entry.path.endsWith("/vet/Vet.java")
    );
    assert.ok(vetTouchpoint);
    vetTouchpoint.centrality = "core";

    const fixedPoint = compileSpecialistEvidence(compiled.map, { cwd });
    assert.equal(fixedPoint.complete, true, fixedPoint.reasons.join("; "));
    assert.equal(fixedPoint.status, "compiled");
    assert.equal(fixedPoint.phase, "fixed-point");

    const repeated = compileSpecialistEvidence(fixedPoint.map, { cwd });
    assert.equal(repeated.complete, true);
    assert.strictEqual(
      repeated.map,
      fixedPoint.map,
      "compiling an already compiled portfolio must be idempotent",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
