import assert from "node:assert/strict";
import test from "node:test";
import { validateMap } from "../../src/core/audit/map-validation.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assessCoverageClosure,
  documentedContributionBranch,
} from "../../src/core/audit/coverage.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

test("complete maps reject internally contradictory high-confidence evidence", () => {
  const map = makeValidCodebaseMap();
  map.meta.project_type = "unknown";
  map.meta.languages = [];
  map.meta.lifecycle.review_loop = { present: true, kind: "none" };
  map.meta.documentation.readme_metrics = {
    present: true,
    line_count: 0,
    section_count: 4,
  };
  map.skeleton.top_level_tree.push(".agentify/", "CHANGELOG.md");
  map.coverage.D8_security.evidence = [{
    path: ".agentify/policies",
    excerpt: "Generated policy directory.",
    kind: "positive",
  }];
  map.meta.documentation.changelog_present = false;
  map.open_questions = ["Initial draft: gather repository evidence before closing coverage."];

  const result = validateMap(map);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Semantic validation failed/);
    assert.match(result.error, /project_type is unknown/);
    assert.match(result.error, /Agentify-generated control paths/);
    assert.match(result.error, /coverage cites Agentify-generated control paths/);
    assert.match(result.error, /coverage is closed while questions remain open/);
  }
});

test("a coherent complete map passes semantic validation", () => {
  const result = validateMap(makeValidCodebaseMap());
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("complete maps reject prose in command fields", () => {
  const map = makeValidCodebaseMap();
  map.operational_surface.build.command = "(none — pure JS ESM library, no build step)";
  map.skeleton.entry_points[0]!.run_command = "n/a";

  const result = validateMap(map);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /operational_surface\.build\.command holds prose/);
    assert.match(result.error, /skeleton\.entry_points\[0\]\.run_command holds prose/);
  }
});

test("complete maps reject unknown metadata and zero metrics beside real evidence", () => {
  const map = makeValidCodebaseMap();
  map.meta.domain_hypothesis = "unknown";
  map.skeleton.app_vs_agentic_layer.app_layer = "unknown";
  map.conventions.file_size = { observed_avg: 0, observed_max: 0 };
  map.validation_surface.test_runtime_seconds_estimate = 0;

  const result = validateMap(map);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /domain_hypothesis is unknown/);
    assert.match(result.error, /app_layer is unknown/);
    assert.match(result.error, /observed_avg is zero/);
    assert.match(result.error, /observed_max is zero/);
    assert.match(result.error, /zero runtime estimate/);
  }
});

test("complete maps reject a subtree marked parallel with its own dependency", () => {
  const map = makeValidCodebaseMap();
  const [edge] = map.module_graph.edges;
  assert.ok(edge);
  map.module_graph.parallelizable_subtrees = [[edge.from, edge.to]];

  const result = validateMap(map);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /parallelizable while recording a dependency between them/);
  }
});

test("complete maps reject unproven pitfalls and untraceable expert evidence", () => {
  const map = makeValidCodebaseMap();
  map.pitfalls = [{
    module: "src/index.ts",
    what: "Optional option values become null.",
    consequence: "Callers cannot distinguish an absent value.",
    line_ref: 0,
  }];
  map.expert_evidence = {
    expert_domains: [{
      domain: "billing",
      rationale: "Recurring payment invariants.",
      primary_paths: ["src/billing"],
      entry_points: ["src/billing/index.ts"],
      test_paths: ["tests/billing.test.ts"],
      key_files: [{ path: "src/billing/index.ts", purpose: "Whole file.", line_range: [0, 0] }],
      key_types: [],
      patterns: [],
      pitfalls: [],
      conventions: [],
      stability: "high",
      recurrence: "high",
      test_command: null,
      last_updated: "not-a-timestamp",
    }],
  };

  const result = validateMap(map);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /pitfalls carry no line reference/);
    assert.match(result.error, /unparsable last_updated timestamp/);
    assert.match(result.error, /without a usable line range/);
  }
});

test("incomplete coverage still tolerates in-progress contradictions", () => {
  const map = makeValidCodebaseMap();
  const [dimension] = Object.keys(map.coverage) as Array<keyof typeof map.coverage>;
  map.coverage[dimension!].status = "gap";
  map.meta.project_type = "unknown";
  map.meta.domain_hypothesis = "unknown";

  assert.equal(validateMap(map).ok, true);
});

test("branch policy prose downgrades the operational dimension", () => {
  const map = makeValidCodebaseMap();
  // The exact value the Commander audit produced, which silently disabled the
  // contribution-branch guard downstream.
  map.operational_surface.git_workflow.main_branch =
    "develop (PRs target develop; release/maintenance tags off master+develop)";

  // Dimension-scoped facts downgrade their own dimension with targeted repair
  // guidance rather than rejecting the whole map and burning an audit attempt.
  const closure = assessCoverageClosure(map);
  assert.ok(
    closure.unresolved.includes("D7_operational"),
    `expected D7_operational unresolved; got ${JSON.stringify(closure.unresolved)}`,
  );
  assert.match(closure.reasons.D7_operational!, /not a bare git ref name/);
});

test("a contribution branch without usable evidence downgrades the operational dimension", () => {
  const map = makeValidCodebaseMap();
  map.operational_surface.git_workflow.contribution_branches = [{
    name: "develop",
    purpose: "pull_request_base",
    evidence: { path: "CONTRIBUTING.md", line_start: 0, line_end: 0 },
  }];

  const closure = assessCoverageClosure(map);
  assert.ok(closure.unresolved.includes("D7_operational"));
  assert.match(closure.reasons.D7_operational!, /no usable evidence line range/);
});

test("a well-formed structured contribution branch is accepted", () => {
  const map = makeValidCodebaseMap();
  map.operational_surface.git_workflow.contribution_branches = [{
    name: "develop",
    purpose: "pull_request_base",
    evidence: { path: "CONTRIBUTING.md", line_start: 15, line_end: 15 },
    note: "PRs target develop; release tags are cut from master.",
  }];

  assert.equal(validateMap(map).ok, true);
});

test("complete maps reject a value the audit admits is false", () => {
  const map = makeValidCodebaseMap();
  map.coverage.D9_process.evidence_summary =
    "PR review loop details cannot be enumerated from the schema-allowed enum; "
    + "declared present=false to satisfy schema and documented the process in sdlc_model.";

  const result = validateMap(map);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /admits is false to satisfy the schema/);
});

test("a build command the repository blocks downgrades the operational dimension", () => {
  const map = makeValidCodebaseMap();
  // The exact contradiction the Commander audit produced.
  map.operational_surface.build.command = "npm publish";
  map.security_surface.bash_blocked_patterns = ["npm publish"];

  const closure = assessCoverageClosure(map);
  assert.ok(closure.unresolved.includes("D7_operational"));
  assert.match(closure.reasons.D7_operational!, /blocked by security policy/);
});

test("a review narrative contradicting the review_loop flag downgrades process", () => {
  const map = makeValidCodebaseMap();
  map.meta.lifecycle.review_loop = { present: false, kind: "none" };
  map.meta.lifecycle.sdlc_model = "GitHub Flow with manual PR review before merge.";

  const closure = assessCoverageClosure(map);
  assert.ok(closure.unresolved.includes("D9_process"));
  assert.match(closure.reasons.D9_process!, /describes a review process/);
});

test("a documented pull-request base missing from branch policy downgrades operational", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-contribution-base-"));
  try {
    // The fixture map cites these; the evidence gate runs before substance.
    for (const cited of ["README.md", "package.json", "src/index.ts", "src/lib.ts"]) {
      const target = path.join(cwd, cited);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Seeded content must contain the excerpt the fixture map cites, because
      // the evidence gate now verifies the quotation against the file.
      fs.writeFileSync(target, "Test fixture evidence citation.\n");
    }
    // Commander's exact wording. The guard depends on this reaching the map, so
    // it must not rest on the model happening to notice it.
    fs.writeFileSync(
      path.join(cwd, "CONTRIBUTING.md"),
      "## Pull Requests\n\nPull Requests will be considered. Please submit pull requests against the develop branch.\n",
    );
    assert.deepEqual(documentedContributionBranch(cwd), { branch: "develop", path: "CONTRIBUTING.md" });

    const map = makeValidCodebaseMap();
    map.operational_surface.git_workflow.main_branch = "master";
    const omitted = assessCoverageClosure(map, { cwd });
    assert.ok(omitted.unresolved.includes("D7_operational"));
    assert.match(omitted.reasons.D7_operational!, /documents pull requests against develop/);

    // Recording it in either field satisfies the check.
    map.operational_surface.git_workflow.contribution_branches = [{
      name: "develop",
      purpose: "pull_request_base",
      evidence: { path: "CONTRIBUTING.md", line_start: 3, line_end: 3 },
    }];
    const recorded = assessCoverageClosure(map, { cwd });
    assert.equal(recorded.unresolved.includes("D7_operational"), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a repository documenting no pull-request base is unaffected", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-no-base-"));
  try {
    // The fixture map cites these; the evidence gate runs before substance.
    for (const cited of ["README.md", "package.json", "src/index.ts", "src/lib.ts"]) {
      const target = path.join(cwd, cited);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Seeded content must contain the excerpt the fixture map cites, because
      // the evidence gate now verifies the quotation against the file.
      fs.writeFileSync(target, "Test fixture evidence citation.\n");
    }
    fs.writeFileSync(path.join(cwd, "CONTRIBUTING.md"), "Open a PR when ready.\n");
    assert.equal(documentedContributionBranch(cwd), null);
    assert.equal(
      assessCoverageClosure(makeValidCodebaseMap(), { cwd }).unresolved.includes("D7_operational"),
      false,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an excerpt that does not appear in the file it cites downgrades the dimension", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-excerpt-verify-"));
  try {
    for (const cited of ["README.md", "package.json", "src/index.ts", "src/lib.ts"]) {
      const target = path.join(cwd, cited);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "Test fixture evidence citation.\n");
    }
    assert.equal(assessCoverageClosure(makeValidCodebaseMap(), { cwd }).unresolved.length, 0);

    // A real path supporting an invented quotation is not evidence.
    const map = makeValidCodebaseMap();
    map.coverage.D1_topography.evidence = [{
      path: "README.md",
      excerpt: "This sentence is nowhere in the cited file.",
      kind: "positive",
    }];
    const closure = assessCoverageClosure(map, { cwd });
    assert.ok(closure.unresolved.includes("D1_topography"));
    assert.match(closure.reasons.D1_topography!, /excerpt does not appear in README\.md/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("complete maps reject scratchpad instructions recorded as findings", () => {
  const map = makeValidCodebaseMap();
  // The exact summaries the Commander audit closed high-confidence dimensions with.
  map.coverage.D7_operational.evidence_summary = "Try with name field.";
  map.coverage.D9_process.evidence_summary = "Record expert domains.";
  map.coverage.D10_documentation.evidence_summary =
    "Set present=false on both loops and fix parallelizable + open_questions + D10.";

  const result = validateMap(map);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /D7_operational\.evidence_summary is an audit instruction/);
    assert.match(result.error, /D9_process\.evidence_summary is an audit instruction/);
    assert.match(result.error, /D10_documentation\.evidence_summary is an audit instruction/);
  }
});

