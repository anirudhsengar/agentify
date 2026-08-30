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

function createAqaShapedRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-specialist-reconcile-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  for (const relativePath of [
    "README.md",
    "get.sh",
    "buildenv/jenkins/getDependency",
    "openjdk/playlist.xml",
    "openjdk/openjdk.mk",
  ]) {
    write(cwd, relativePath);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

function aqaShapedMap(): CodebaseMap {
  const map = makeValidCodebaseMap();
  delete map.expert_evidence;
  map.skeleton.top_level_tree = ["buildenv/", "get.sh", "openjdk/"];
  map.skeleton.entry_points = [{
    path: "get.sh",
    role: "material acquisition",
    language: "shell",
    run_command: "./get.sh",
  }];
  map.skeleton.first_5_files_for_fresh_agent = [{
    path: "get.sh",
    why: "Tracked acquisition entry point.",
  }];
  map.skeleton.code_test_mirror = { observed: false, pattern: "not observed" };
  map.module_graph.edges = [
    { from: "get.sh", to: "buildenv/jenkins/getDependency", kind: "delegates acquisition" },
    { from: "get.sh", to: "openjdk/playlist.xml", kind: "stages playlist" },
    { from: "openjdk/playlist.xml", to: "openjdk/openjdk.mk", kind: "generates make targets" },
  ];
  map.module_graph.parallelizable_subtrees = [];
  map.module_graph.shared_abstractions = [];
  map.module_graph.shared_state = [];
  map.pitfalls = [{
    module: "get.sh",
    what: "Branch selection controls fetched test material.",
    consequence: "The wrong test inputs run.",
    line_ref: 1,
  }];
  map.operational_surface.build.recipe_file = "get.sh";
  map.concern_evidence = {
    concerns: [
      concern({
        name: "Test dependency and external material acquisition",
        covers: "JDK, TKG, vendor material, and Jenkins dependency acquisition.",
        excludes: "Playlist interpretation and generated Make targets.",
        touchpoints: [
          {
            path: "get.sh",
            symbol: "getBinaryOpenjdk / getTestKitGen / getVendorTestMaterial / executeCmdWithRetry",
            role: "Central tracked acquisition entry point.",
            line_range: null,
            centrality: "core",
          },
          {
            path: "buildenv/jenkins/getDependency",
            symbol: "getDependency",
            role: "Jenkins dependency acquisition.",
            line_range: null,
            centrality: "core",
          },
        ],
        flow: ["get.sh", "buildenv/jenkins/getDependency"],
      }),
      concern({
        name: "Playlist-to-Make target generation",
        covers: "Tracked playlist interpretation and Make target generation after TKG bootstrap.",
        excludes: "SDK and vendor dependency acquisition.",
        touchpoints: [
          {
            path: "get.sh",
            symbol: "getTestKitGen / main driver",
            role: "Bootstraps the external generator.",
            line_range: null,
            centrality: "core",
          },
          {
            path: "openjdk/playlist.xml",
            symbol: "playlist",
            role: "Defines test targets consumed by the generator.",
            line_range: null,
            centrality: "core",
          },
          {
            path: "openjdk/openjdk.mk",
            symbol: "make targets",
            role: "Provides repository-owned generated target inputs.",
            line_range: null,
            centrality: "core",
          },
        ],
        flow: ["get.sh", "openjdk/playlist.xml", "openjdk/openjdk.mk"],
      }),
    ],
    not_concerns: [{
      candidate: "Playlist-to-Make behavior as merely get.sh",
      why_rejected: "Not rejected: retained because tracked playlist and Make inputs establish an independent behavior.",
    }],
  };
  return map;
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
    vetTouchpoint.role = "Explicitly owns the shared Vet representation contract.";

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

test("specialist compilation removes stale retained-candidate entries and resolves strict symbol-superset ownership", () => {
  const cwd = createAqaShapedRepository();
  try {
    const compiled = compileSpecialistEvidence(aqaShapedMap(), { cwd });
    assert.equal(compiled.status, "compiled", compiled.reasons.join("; "));
    assert.equal(compiled.complete, true);
    assert.equal(compiled.map.concern_evidence?.not_concerns.length, 0);
    const concerns = compiled.map.concern_evidence?.concerns ?? [];
    const acquisition = concerns.find((entry) =>
      entry.concern === "Test dependency and external material acquisition"
    );
    const playlist = concerns.find((entry) =>
      entry.concern === "Playlist-to-Make target generation"
    );
    assert.equal(
      acquisition?.touchpoints.find((entry) => entry.path === "get.sh")?.centrality,
      "core",
    );
    assert.equal(
      playlist?.touchpoints.find((entry) => entry.path === "get.sh")?.centrality,
      "supporting",
    );
    assert.strictEqual(compileSpecialistEvidence(compiled.map, { cwd }).map, compiled.map);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("specialist compilation leaves disjoint shared-symbol claims unresolved", () => {
  const cwd = createAqaShapedRepository();
  try {
    const map = aqaShapedMap();
    map.concern_evidence!.not_concerns = [];
    map.concern_evidence!.concerns[1]!.touchpoints[0]!.symbol = "generateTargets";
    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.status, "incomplete");
    assert.ok(compiled.reasons.some((reason) =>
      reason.includes("get.sh has multiple core owners")
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a path-backed rejection cannot delegate behavior to a nonexistent concern", () => {
  const cwd = createAqaShapedRepository();
  try {
    write(cwd, "scripts/common/__init__.py");
    write(cwd, "scripts/tests/__init__.py");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "add mirrored package files");
    const map = aqaShapedMap();
    map.concern_evidence!.not_concerns = [{
      candidate: "init",
      why_rejected: "The tracked files are subsumed by the accepted package initialization concern; scripts/common/__init__.py and scripts/tests/__init__.py do not warrant a duplicate specialist.",
    }];
    map.concern_evidence!.concerns[1]!.touchpoints[0]!.centrality = "supporting";

    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.status, "incomplete");
    assert.ok(compiled.reasons.some((reason) =>
      reason.includes("no accepted concern semantically matches")
    ));
    assert.ok(compiled.reasons.some((reason) => reason.includes("scripts/common/__init__.py")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a path-backed rejection trusts an exact grouped_into owner before prose aliases", () => {
  const cwd = createAqaShapedRepository();
  try {
    write(cwd, "scripts/common/__init__.py");
    write(cwd, "scripts/tests/__init__.py");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "add mirrored package files");
    const map = aqaShapedMap();
    map.concern_evidence!.not_concerns = [{
      candidate: "implementation/test cluster init [scripts/common/__init__.py, scripts/tests/__init__.py]",
      why_rejected: "These empty package markers are subsumed by the accepted orchestration family and do not define independent behavior or specialist ownership.",
      grouped_into: map.concern_evidence!.concerns[0]!.concern,
    }];
    map.concern_evidence!.concerns[1]!.touchpoints[0]!.centrality = "supporting";

    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.status, "compiled", compiled.reasons.join("; "));
    assert.equal(compiled.complete, true);

    const nonexistentOwner = structuredClone(map);
    nonexistentOwner.concern_evidence!.not_concerns[0]!.grouped_into = "Missing concern";
    const unresolved = compileSpecialistEvidence(nonexistentOwner, { cwd });
    assert.equal(unresolved.status, "incomplete");
    assert.ok(unresolved.reasons.some((reason) =>
      reason.includes("no accepted concern semantically matches")
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a negative hypothetical about an accepted concern is not a delegation", () => {
  const cwd = createAqaShapedRepository();
  try {
    write(cwd, "CONTRIBUTING.md");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "add contribution policy");
    const map = aqaShapedMap();
    map.concern_evidence!.not_concerns = [{
      candidate: "CONTRIBUTING.md",
      why_rejected: "Contributor onboarding and PR workflow only. It documents how humans submit patches rather than recurring runtime behavior, so attaching it to an accepted runtime concern would conflate project governance with library semantics.",
    }];
    map.concern_evidence!.concerns[1]!.touchpoints[0]!.centrality = "supporting";

    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.status, "compiled", compiled.reasons.join("; "));
    assert.equal(compiled.complete, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("path-backed rejection labels close only their exact tracked cluster", () => {
  const cwd = createAqaShapedRepository();
  try {
    write(cwd, "scripts/common/__init__.py");
    write(cwd, "scripts/tests/__init__.py");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "add empty mirrored package files");
    const map = aqaShapedMap();
    map.concern_evidence!.not_concerns = [{
      candidate: "implementation/test cluster init [scripts/common/__init__.py, scripts/tests/__init__.py]",
      why_rejected: "Both tracked files are empty package initializers with no independent behavior or specialist ownership.",
    }];
    map.concern_evidence!.concerns[1]!.touchpoints[0]!.centrality = "supporting";
    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.status, "compiled", compiled.reasons.join("; "));
    assert.equal(compiled.complete, true);

    write(cwd, "other/__init__.py");
    write(cwd, "other/tests/__init__.py");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "add unrelated empty mirrored package files");
    const counterexample = compileSpecialistEvidence(map, { cwd });
    assert.equal(counterexample.status, "incomplete");
    assert.ok(counterexample.reasons.some((reason) => reason.includes("other/__init__.py")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("specialist compilation canonicalizes scout names and recomputes trusted inferred attachments", () => {
  const cwd = createAqaShapedRepository();
  try {
    write(cwd, "scripts/disabled_tests/exclude_openjdk.py");
    write(cwd, "scripts/disabled_tests/inventory.py");
    write(cwd, "scripts/disabled_tests/issue_filter.py");
    write(cwd, "scripts/disabled_tests/tests/test_exclude_openjdk.py");
    write(cwd, "scripts/disabled_tests/tests/test_issue_filter.py");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "add exclusion maintenance fixture");
    const map = aqaShapedMap();
    const acquisition = map.concern_evidence!.concerns[0]!;
    acquisition.concern = "Test dependency and external material acquisition; seed paths: get.sh and Jenkins. Trace sources, branches, credentials, and tracked descriptors only.";
    const inventory = concern({
      name: "Disabled and excluded test inventory maintenance",
      covers: "ProblemList exclusion parsing, issue filtering, and mirrored regression behavior.",
      excludes: "Playlist-to-Make generation, dependency acquisition, and openjdk/excludes inputs owned by test suites.",
      touchpoints: [
        {
          path: "scripts/disabled_tests/inventory.py",
          symbol: "inventory",
          role: "Implements disabled test inventory maintenance.",
          line_range: null,
          centrality: "core",
        },
      ],
      flow: [
        "scripts/disabled_tests/inventory.py",
        "scripts/disabled_tests/inventory.py",
      ],
    });
    map.concern_evidence!.concerns.push(inventory);
    const playlist = map.concern_evidence!.concerns[1]!;
    for (const repositoryPath of [
      "scripts/disabled_tests/exclude_openjdk.py",
      "scripts/disabled_tests/tests/test_exclude_openjdk.py",
    ]) {
      playlist.touchpoints.push({
        path: repositoryPath,
        symbol: null,
        role: "Trusted semantic closure attached this tracked dependency: unique path-local and semantic match to accepted concern evidence.",
        line_range: null,
        centrality: "supporting",
      });
    }
    map.explorer_receipts = {
      repository_commit: git(cwd, "rev-parse", "HEAD"),
      run_id: "fixture-run",
      receipts: [{
        sequence: 1,
        mode: "concern_scout",
        success: true,
        target_path: ".",
        focus: "discover repository concerns",
        report_concern: null,
        failure_kind: null,
        proposed_concerns: [
          "Test dependency and external material acquisition",
          "Playlist-to-Make target generation",
          "Disabled and excluded test inventory maintenance",
        ],
      }],
    };

    const ambiguous = structuredClone(map);
    ambiguous.concern_evidence!.concerns.push({
      ...structuredClone(acquisition),
      concern: "Test dependency and external material acquisition",
    });
    const ambiguousCompilation = compileSpecialistEvidence(ambiguous, { cwd });
    assert.ok(ambiguousCompilation.map.concern_evidence!.concerns.some((entry) =>
      entry.concern.includes("seed paths:")
    ));

    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.status, "compiled", compiled.reasons.join("; "));
    const concerns = compiled.map.concern_evidence!.concerns;
    assert.ok(concerns.some((entry) => entry.concern === "Test dependency and external material acquisition"));
    assert.ok(!concerns.some((entry) => entry.concern.includes("seed paths:")));
    const normalizedPlaylist = concerns.find((entry) => entry.concern === "Playlist-to-Make target generation")!;
    assert.ok(!normalizedPlaylist.touchpoints.some((entry) => entry.path.includes("exclude_openjdk")));
    assert.strictEqual(compileSpecialistEvidence(compiled.map, { cwd }).map, compiled.map);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
