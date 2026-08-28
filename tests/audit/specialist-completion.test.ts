import assert from "node:assert/strict";
import test from "node:test";
import {
  assessSpecialistEvidence,
  specialistEvidenceRecorded,
} from "../../src/core/audit/schema.ts";
import type { CodebaseMap } from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

function concern(input: {
  name: string;
  paths: string[];
}): NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number] {
  return {
    concern: input.name,
    one_line: `Owns ${input.name}.`,
    covers: `End-to-end behavior for ${input.name}.`,
    excludes: "Adjacent concerns are recorded separately.",
    flows: [{
      name: `${input.name} flow`,
      description: `Observed ${input.name} path.`,
      steps: input.paths.slice(0, 2).map((path) => ({ path, what_happens: `Observed step in ${path}.` })),
    }],
    touchpoints: input.paths.map((path, index) => ({
      path,
      symbol: null,
      role: `Observed role for ${input.name}.`,
      line_range: null,
      centrality: index === 0 ? "core" as const : "supporting" as const,
    })),
    invariants: [],
    pitfalls: [],
    entry_questions: [`Does this change alter ${input.name}?`],
    validation: ["npm test"],
    spans_subtrees: [...new Set(input.paths.map((path) => path.includes("/") ? path.split("/")[0]! : path))],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-25T00:00:00.000Z",
  };
}

function commanderLikeMap(): CodebaseMap {
  const map = makeValidCodebaseMap();
  delete map.expert_evidence;
  map.meta.project_type = "JavaScript CLI library";
  map.meta.languages = ["JavaScript", "TypeScript declarations"];
  map.skeleton.entry_points = [
    { path: "index.js", role: "public package entry", language: "JavaScript", run_command: "npm test" },
  ];
  map.skeleton.first_5_files_for_fresh_agent = [
    { path: "Readme.md", why: "public behavior" },
    { path: "lib/command.js", why: "command lifecycle" },
  ];
  map.module_graph.edges = [
    { from: "index.js", to: "lib/command.js", kind: "public import" },
    { from: "lib/command.js", to: "lib/option.js", kind: "core dependency" },
    { from: "lib/command.js", to: "lib/help.js", kind: "help rendering" },
    { from: "lib/command.js", to: "lib/error.js", kind: "error contract" },
  ];
  map.module_graph.parallelizable_subtrees = [
    ["lib/argument.js", "lib/option.js"],
    ["lib/help.js"],
  ];
  map.type_contract_surface.typescript_interfaces = [{
    path: "typings/index.d.ts",
    name: "Command",
    fields: ["args", "options"],
  }];
  map.pitfalls = [{
    module: "lib/command.js",
    what: "Command parsing and dispatch have observable ordering.",
    consequence: "Public behavior changes.",
    line_ref: 1,
  }];
  map.operational_surface.build.recipe_file = "package.json";
  return map;
}

test("legacy expert evidence remains attachable for migration", () => {
  assert.equal(specialistEvidenceRecorded(makeValidCodebaseMap()), true);
});

test("a single parser concern cannot close a multi-area Commander-style repository", () => {
  const map = commanderLikeMap();
  map.concern_evidence = {
    concerns: [concern({
      name: "CLI argument parser",
      paths: ["lib/command.js", "lib/option.js", "lib/argument.js", "lib/error.js"],
    })],
    not_concerns: [
      { candidate: "TypeScript definitions", why_rejected: "They mirror runtime behavior." },
      { candidate: "Test infrastructure", why_rejected: "It supports production concerns." },
    ],
  };
  const assessment = assessSpecialistEvidence(map);
  assert.equal(assessment.complete, false);
  assert.ok(assessment.uncovered_paths.includes("lib/help.js"));
  assert.ok(assessment.uncovered_paths.includes("typings/index.d.ts"));
  assert.ok(assessment.reasons.some((reason) => /thin specialist portfolio/i.test(reason)));
});

test("complete overlapping concerns close only after high-signal paths are accounted for", () => {
  const map = commanderLikeMap();
  map.concern_evidence = {
    concerns: [
      concern({
        name: "CLI argument parsing",
        paths: ["index.js", "lib/command.js", "lib/option.js", "lib/argument.js", "lib/error.js"],
      }),
      concern({
        name: "Help and output rendering",
        paths: ["lib/command.js", "lib/help.js", "Readme.md"],
      }),
    ],
    not_concerns: [
      {
        candidate: "Type declaration maintenance",
        why_rejected: "typings/index.d.ts mirrors the public runtime API and is validated with the concerns above.",
      },
      {
        candidate: "Package metadata",
        why_rejected: "package.json is repository plumbing rather than an independent body of knowledge.",
      },
    ],
  };
  const assessment = assessSpecialistEvidence(map);
  assert.deepEqual(assessment.uncovered_paths, []);
  assert.equal(assessment.complete, true, assessment.reasons.join("; "));
  assert.equal(specialistEvidenceRecorded(map), true);
});

test("unknown language metadata cannot silently complete concern discovery", () => {
  const map = commanderLikeMap();
  map.meta.project_type = "unknown";
  map.meta.languages = [];
  map.concern_evidence = {
    concerns: [concern({ name: "repository behavior", paths: ["index.js", "lib/command.js"] })],
    not_concerns: [],
  };
  const assessment = assessSpecialistEvidence(map);
  assert.equal(assessment.complete, false);
  assert.ok(assessment.reasons.some((reason) => /project_type/i.test(reason)));
  assert.ok(assessment.reasons.some((reason) => /languages\/formats/i.test(reason)));
});

test("accepted candidates cannot masquerade as compiler rejection evidence", () => {
  const map = commanderLikeMap();
  map.concern_evidence = {
    concerns: [concern({
      name: "CLI argument parsing",
      paths: ["index.js", "lib/command.js", "lib/option.js", "lib/argument.js", "lib/error.js", "lib/help.js"],
    })],
    not_concerns: [{
      candidate: "Type declaration maintenance",
      why_rejected: "Not rejected; accepted for tracing because it protects compatibility.",
    }],
  };
  const assessment = assessSpecialistEvidence(map);
  assert.equal(assessment.complete, false);
  assert.ok(
    assessment.reasons.some((reason) => /does not contain a substantive rejection/i.test(reason)),
    assessment.reasons.join("; "),
  );
});
