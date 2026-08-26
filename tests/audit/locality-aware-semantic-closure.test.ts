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

function write(cwd: string, repositoryPath: string): void {
  const absolute = path.join(cwd, ...repositoryPath.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${repositoryPath}\n`);
}

function concern(input: {
  name: string;
  oneLine: string;
  covers: string;
  corePaths: string[];
  flowPaths: string[];
}): Concern {
  return {
    concern: input.name,
    one_line: input.oneLine,
    covers: input.covers,
    excludes: "Adjacent repository contracts remain separate.",
    flows: [{
      name: `${input.name} flow`,
      description: `Observed ${input.name} behavior.`,
      steps: input.flowPaths.map((repositoryPath, index) => ({
        path: repositoryPath,
        what_happens: `Distinct operation ${index + 1} in ${repositoryPath}.`,
      })),
    }],
    touchpoints: input.corePaths.map((repositoryPath) => ({
      path: repositoryPath,
      symbol: null,
      role: `Core ${input.name} implementation.`,
      line_range: null,
      centrality: "core" as const,
    })),
    invariants: [],
    pitfalls: [],
    entry_questions: [`Does this change alter ${input.name}?`],
    validation: ["bun run test"],
    spans_subtrees: ["src"],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-26T00:00:00.000Z",
  };
}

function createRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-locality-closure-"));
  for (const repositoryPath of [
    "README.md",
    "package.json",
    "src/context.ts",
    "src/context.test.ts",
    "src/jsx/context.ts",
    "src/jsx/context.test.ts",
    "src/jsx/dom/context.ts",
    "src/jsx/dom/context.test.ts",
    "src/helper/ssg/ssg.ts",
    "src/helper/ssg/ssg.test.ts",
    "src/helper/ssg/middleware.ts",
    "runtime-tests/deno/middleware.test.tsx",
    "src/utils/mime.ts",
    "src/utils/mime.test.ts",
    "src/router.ts",
    "src/router/reg-exp-router/router.ts",
    "src/router/reg-exp-router/matcher.ts",
    "src/types.ts",
  ]) write(cwd, repositoryPath);
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "locality fixture");
  return cwd;
}

function honoShapedMap(): CodebaseMap {
  const map = makeValidCodebaseMap();
  delete map.expert_evidence;
  map.meta.project_type = "TypeScript web framework";
  map.meta.languages = ["TypeScript", "TSX"];
  map.skeleton.entry_points = [{
    path: "src/context.ts",
    role: "request lifecycle",
    language: "TypeScript",
    run_command: "bun run test",
  }];
  map.skeleton.first_5_files_for_fresh_agent = [{
    path: "src/context.ts",
    why: "request state",
  }];
  map.module_graph.edges = [];
  map.module_graph.parallelizable_subtrees = [];
  map.module_graph.shared_abstractions = [];
  map.module_graph.shared_state = [];
  map.pitfalls = [{
    module: "src/router/reg-exp-router/matcher.ts",
    what: "Matcher compilation is lazy.",
    consequence: "Cold-start routing behavior changes.",
    line_ref: 1,
  }];
  map.operational_surface.build.recipe_file = "package.json";
  map.open_questions = ["Initial draft: gather repository evidence before closing coverage."];
  map.concern_evidence = {
    concerns: [
      concern({
        name: "request lifecycle and middleware composition",
        oneLine: "Carries requests through middleware and Context response state.",
        covers: "Context, middleware dispatch, and response finalization.",
        corePaths: ["src/context.ts", "src/context.test.ts"],
        flowPaths: ["src/context.ts", "src/context.test.ts"],
      }),
      concern({
        name: "JSX rendering and DOM runtime",
        oneLine: "Preserves JSX context across server and DOM rendering.",
        covers: "JSX children, components, context providers, DOM state, and tests.",
        corePaths: ["src/jsx/context.ts", "src/jsx/dom/context.ts"],
        flowPaths: ["src/jsx/context.ts", "src/jsx/dom/context.ts"],
      }),
      concern({
        name: "static site generation and output safety",
        oneLine: "Generates static output and maps MIME extensions safely.",
        covers: "SSG orchestration, MIME mapping, and guarded writes.",
        corePaths: ["src/helper/ssg/ssg.ts", "src/helper/ssg/ssg.test.ts"],
        flowPaths: ["src/helper/ssg/ssg.ts", "src/helper/ssg/ssg.test.ts"],
      }),
      concern({
        name: "route matching and router selection",
        oneLine: "Compiles route matchers and selects router implementations.",
        covers: "Router contracts, RegExp matcher construction, and selection.",
        corePaths: ["src/router.ts", "src/router/reg-exp-router/router.ts"],
        flowPaths: ["src/router.ts", "src/router/reg-exp-router/router.ts"],
      }),
    ],
    not_concerns: [],
  };
  return map;
}

test("same-stem files are clustered by repository locality and attached to accepted concerns", () => {
  const cwd = createRepository();
  try {
    const map = honoShapedMap();
    const assessment = assessSpecialistEvidence(map, { cwd });
    assert.equal(assessment.complete, true, assessment.reasons.join("; "));
    const clusterKeys = assessment.repository_clusters.map((cluster) => cluster.cluster_key);
    assert.ok(clusterKeys.includes("context@src"));
    assert.ok(clusterKeys.includes("context@src/jsx"));
    assert.ok(clusterKeys.includes("context@src/jsx/dom"));
    assert.ok(!clusterKeys.some((key) => key.startsWith("middleware")));
    const attached = new Set(assessment.attachments.flatMap((attachment) => attachment.paths));
    assert.ok(attached.has("src/jsx/context.test.ts"));
    assert.ok(attached.has("src/jsx/dom/context.test.ts"));
    assert.ok(attached.has("src/utils/mime.ts"));
    assert.ok(attached.has("src/utils/mime.test.ts"));
    assert.ok(attached.has("src/router/reg-exp-router/matcher.ts"));

    const reconciled = reconcileSpecialistEvidence(map, assessment);
    const jsx = reconciled.concern_evidence?.concerns.find((entry) =>
      entry.concern === "JSX rendering and DOM runtime"
    );
    assert.ok(jsx?.touchpoints.some((touchpoint) => touchpoint.path === "src/jsx/context.test.ts"));
    assert.ok(jsx?.touchpoints.some((touchpoint) => touchpoint.path === "src/jsx/dom/context.test.ts"));

    map.module_graph.shared_abstractions = ["src/types.ts"];
    const typeGap = assessSpecialistEvidence(map, { cwd });
    assert.equal(typeGap.complete, false);
    assert.ok(typeGap.uncovered_paths.includes("src/types.ts"));
    assert.ok(typeGap.reasons.some((reason) => /high-signal repository files/i.test(reason)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
