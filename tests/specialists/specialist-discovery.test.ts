import assert from "node:assert/strict";
import test from "node:test";
import {
  SPECIALIST_READ_ONLY_EXECUTION_POLICY,
  assessExpertiseInvalidation,
  discoverSpecialistPortfolio,
  routeSpecialistPortfolio,
  validateSpecialistPortfolio,
} from "../../src/core/specialists/index.ts";
import { makeSpecialistFixtureMap } from "../fixtures/specialist-map.ts";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function portfolioFixture() {
  const map = makeSpecialistFixtureMap();
  map.artifact_intents!.feature_agents.push({
    name: "docs",
    description: "Documentation helper.",
    globs: ["docs"],
    body: "Write documentation.",
  });
  map.skeleton.top_level_tree.push("docs");
  return discoverSpecialistPortfolio(map, COMMIT_A);
}

function structuralPortfolioFixture(root = "src", suggestedDomains: string[] = []) {
  const map = makeSpecialistFixtureMap();
  map.meta.project_type = "typed-arithmetic-library";
  map.meta.domain_hypothesis = "A cohesive typed arithmetic library with a stable input contract.";
  map.meta.suggested_subagent_domains = suggestedDomains;
  map.expert_evidence = { expert_domains: [] };
  map.artifact_intents!.feature_agents = [];
  map.module_graph.edges = [
    { from: `${root}/math.ts`, to: `${root}/types.ts`, kind: "import" },
    { from: `${root}/index.ts`, to: `${root}/math.ts`, kind: "import" },
  ];
  map.module_graph.parallelizable_subtrees = [];
  map.type_contract_surface.pydantic_models = [];
  map.type_contract_surface.typescript_interfaces = [
    { path: `${root}/types.ts`, name: "AddInput", fields: ["left", "right"] },
  ];
  map.type_contract_surface.db_models = [];
  map.pitfalls = [
    {
      module: `${root}/math.ts`,
      what: "Arithmetic inputs must remain finite.",
      consequence: "Invalid results can propagate silently.",
      line_ref: 3,
    },
  ];
  map.conventions.patterns = [];
  return discoverSpecialistPortfolio(map, COMMIT_A);
}

test("discovery uses evidence-backed domains and ignores speculative artifact helpers", () => {
  const first = portfolioFixture();
  const second = portfolioFixture();
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.specialists.map((specialist) => specialist.specialist_id),
    ["specialist-billing"],
  );
  const billing = first.specialists[0]!;
  assert.deepEqual(billing.source_kinds, ["expert_evidence"]);
  assert.deepEqual(billing.execution_policy, SPECIALIST_READ_ONLY_EXECUTION_POLICY);
  assert.equal(billing.freshness, "current");
  assert.equal(billing.supporting_commit, COMMIT_A);
  assert.equal(billing.evidence_paths.includes("src/billing"), false);
  assert.ok(billing.evidence_paths.includes("src/billing/index.ts"));
  assert.equal(first.specialists.some((specialist) => specialist.domain === "docs"), false);
  assert.equal(first.procedures.some((procedure) => procedure.procedure_id === "api-endpoint"), false);
  assert.equal(first.procedures.some((procedure) => procedure.procedure_id === "prime-db"), false);
  assert.ok(first.procedures.every((procedure) => procedure.evidence_paths.length > 0));
  assert.ok(first.procedures.every((procedure) => procedure.validation_commands.length > 0));
  assert.ok(first.procedures.every((procedure) =>
    procedure.evidence_paths.every((path) => !path.includes("/skills/"))
  ));
});

test("discovery derives one specialist from cohesive independent structural evidence", () => {
  const portfolio = structuralPortfolioFixture();
  assert.deepEqual(
    portfolio.specialists.map((specialist) => specialist.specialist_id),
    ["specialist-typed-arithmetic-library"],
  );
  const specialist = portfolio.specialists[0]!;
  assert.deepEqual(specialist.owned_paths, ["src"]);
  assert.deepEqual(specialist.source_kinds, ["structural_evidence"]);
  assert.ok(specialist.observed_paths.every((path) => !path.endsWith("/")));
  assert.ok(specialist.evidence_paths.includes("src/math.ts"));
  assert.ok(specialist.evidence_paths.includes("src/types.ts"));
  assert.ok(portfolio.evidence_paths.every((path) =>
    path.split("/").every((segment) => !segment.startsWith("."))
  ));
  assert.ok(specialist.discovery_score >= 7);
  const routing = routeSpecialistPortfolio(portfolio, {
    task_description: "Correct the arithmetic contract",
    candidate_paths: ["src/math.ts"],
    contracts: ["AddInput: left, right"],
  });
  assert.equal(routing.selected_specialists[0]?.specialist_id, "specialist-typed-arithmetic-library");
});

test("display annotations are removed from repository evidence paths", () => {
  const map = makeSpecialistFixtureMap();
  map.pitfalls = map.pitfalls.map((pitfall) => ({
    ...pitfall,
    module: `${pitfall.module} (model display label)`,
  }));
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A);
  assert.ok(portfolio.evidence_paths.includes("src/billing/index.ts"));
  assert.ok(portfolio.evidence_paths.every((candidate) => !candidate.includes("(model display label)")));
  assert.ok(portfolio.specialists.every((specialist) =>
    specialist.evidence_paths.every((candidate) => !candidate.includes("(model display label)"))
  ));
});

test("repository-backed discovery excludes module specifiers that are not tracked files", () => {
  const map = makeSpecialistFixtureMap();
  map.module_graph.edges.push({
    from: "src/billing/index.ts",
    to: "fs-helper.js",
    kind: "import",
  });
  const tracked = [
    "package.json",
    "src/billing/index.ts",
    "src/billing/types.ts",
    "tests/billing.test.ts",
  ];
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A, tracked);
  assert.ok(portfolio.evidence_paths.length > 0);
  assert.ok(portfolio.evidence_paths.every((candidate) => tracked.includes(candidate)));
  assert.ok(portfolio.specialists.every((specialist) => (
    specialist.evidence_paths.every((candidate) => tracked.includes(candidate))
  )));
  assert.ok(portfolio.procedures.every((procedure) => (
    procedure.evidence_paths.every((candidate) => tracked.includes(candidate))
  )));
  assert.ok(!portfolio.evidence_paths.includes("fs-helper.js"));
});

test("expert evidence paths are filtered to tracked files", () => {
  const map = makeSpecialistFixtureMap();
  // The model claims a directory and an untracked path as domain evidence.
  map.expert_evidence!.expert_domains[0]!.test_paths = ["tests/billing/"];
  map.expert_evidence!.expert_domains[0]!.entry_points.push("scripts/disabled_tests/tests");
  const tracked = [
    "package.json",
    "src/billing/index.ts",
    "src/billing/types.ts",
    "tests/billing.test.ts",
  ];
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A, tracked);
  const billing = portfolio.specialists.find((specialist) => specialist.specialist_id === "specialist-billing");
  assert.ok(billing, "specialist survives on its remaining tracked evidence");
  assert.ok(billing.evidence_paths.length > 0);
  assert.ok(billing.evidence_paths.every((candidate) => tracked.includes(candidate)));
  assert.ok(!billing.evidence_paths.includes("scripts/disabled_tests/tests"));
  assert.ok(!billing.evidence_paths.includes("tests/billing"));
  assert.ok(portfolio.evidence_paths.every((candidate) => tracked.includes(candidate)));
});

test("expert domain with no tracked evidence is dropped", () => {
  const map = makeSpecialistFixtureMap();
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A, ["package.json"]);
  assert.equal(
    portfolio.specialists.some((specialist) => specialist.specialist_id === "specialist-billing"),
    false,
  );
  assert.ok(
    portfolio.procedures.every((procedure) =>
      procedure.evidence_paths.every((candidate) => candidate === "package.json")
    ),
  );
});

test("structural fallback refuses a monorepo container root", () => {
  const portfolio = structuralPortfolioFixture("packages/api/src");
  assert.deepEqual(portfolio.specialists, []);
  assert.ok(portfolio.warnings.includes("No repository domain met the specialist evidence and validation threshold."));
});

test("a shallow optional domain hint is ignored in favor of structural evidence", () => {
  const portfolio = structuralPortfolioFixture("src", ["src"]);
  assert.deepEqual(
    portfolio.specialists.map((specialist) => specialist.specialist_id),
    ["specialist-typed-arithmetic-library"],
  );
  assert.deepEqual(portfolio.specialists[0]?.source_kinds, ["structural_evidence"]);
});

test("routing is deterministic and explains path, contract, and risk decisions", () => {
  const portfolio = portfolioFixture();
  const report = routeSpecialistPortfolio(portfolio, {
    task_description: "Add partial invoice refunds while preserving idempotency",
    candidate_paths: ["src/billing/refunds.ts"],
    contracts: ["Invoice"],
    risk_category: "high",
  });
  assert.equal(report.selected_specialists[0]?.specialist_id, "specialist-billing");
  assert.ok(report.selected_specialists[0]?.reasons.some((reason) => reason.kind === "owned_path"));
  assert.ok(report.selected_specialists[0]?.reasons.some((reason) => reason.kind === "contract"));
  assert.ok(report.selected_procedures.some((procedure) => procedure.procedure_id === "validate-billing"));
  assert.throws(() => routeSpecialistPortfolio(portfolio, {
    task_description: "Read a secret",
    candidate_paths: ["../secret"],
  }));
});

test("invalidation affects only expertise whose dependencies intersect changed files", () => {
  const portfolio = portfolioFixture();
  const report = assessExpertiseInvalidation(portfolio, ["src/billing/refunds.ts"]);
  assert.deepEqual(report.specialist_ids, ["specialist-billing"]);
  assert.ok(report.procedure_ids.includes("validate-billing"));
  assert.equal(report.procedure_ids.includes("prime-db"), false);
});

test("monorepo domains remain distinct", () => {
  const map = makeSpecialistFixtureMap();
  map.meta.suggested_subagent_domains = ["packages/api/src", "packages/web/src"];
  map.skeleton.top_level_tree = ["packages/api/src", "packages/web/src"];
  map.skeleton.entry_points = [
    { path: "packages/api/src/index.ts", role: "api", language: "typescript", run_command: "node packages/api/src/index.ts" },
    { path: "packages/web/src/index.ts", role: "web", language: "typescript", run_command: "node packages/web/src/index.ts" },
  ];
  map.skeleton.first_5_files_for_fresh_agent = [
    { path: "packages/api/src/index.ts", why: "API entry point." },
    { path: "packages/web/src/index.ts", why: "Web entry point." },
  ];
  map.module_graph.edges = [
    { from: "packages/web/src/client.ts", to: "packages/api/src/contracts.ts", kind: "rpc" },
  ];
  map.module_graph.parallelizable_subtrees = [["packages/api/src", "packages/web/src"]];
  map.module_graph.shared_abstractions = [];
  map.type_contract_surface.typescript_interfaces = [
    { path: "packages/api/src/contracts.ts", name: "ApiResponse", fields: ["data"] },
    { path: "packages/web/src/state.ts", name: "WebState", fields: ["ready"] },
  ];
  map.pitfalls = [
    { module: "packages/api/src/index.ts", what: "Preserve API compatibility.", consequence: "Clients break.", line_ref: 1 },
    { module: "packages/web/src/index.ts", what: "Preserve hydration state.", consequence: "Rendering breaks.", line_ref: 1 },
  ];
  map.expert_evidence = {
    expert_domains: [
      {
        domain: "api",
        rationale: "API owns external contracts.",
        primary_paths: ["packages/api/src"],
        entry_points: ["packages/api/src/index.ts"],
        test_paths: ["packages/api/tests/api.test.ts"],
        key_files: [{ path: "packages/api/src/contracts.ts", purpose: "API contract.", line_range: [1, 20] }],
        key_types: [{ name: "ApiResponse", path: "packages/api/src/contracts.ts:1", purpose: "External contract." }],
        patterns: [],
        pitfalls: [{ risk: "Contract break.", consequence: "Clients fail.", reference: "packages/api/src/contracts.ts:1" }],
        conventions: [],
        stability: "high",
        recurrence: "high",
        test_command: "npm test --workspace api",
        last_updated: "2026-07-30T00:00:00.000Z",
      },
      {
        domain: "web-ui",
        rationale: "Web UI owns browser state.",
        primary_paths: ["packages/web/src"],
        entry_points: ["packages/web/src/index.ts"],
        test_paths: ["packages/web/tests/web.test.ts"],
        key_files: [{ path: "packages/web/src/state.ts", purpose: "Browser state.", line_range: [1, 20] }],
        key_types: [{ name: "WebState", path: "packages/web/src/state.ts:1", purpose: "Browser state." }],
        patterns: [],
        pitfalls: [{ risk: "Hydration mismatch.", consequence: "Rendering fails.", reference: "packages/web/src/state.ts:1" }],
        conventions: [],
        stability: "high",
        recurrence: "high",
        test_command: "npm test --workspace web",
        last_updated: "2026-07-30T00:00:00.000Z",
      },
    ],
  };
  map.artifact_intents!.feature_agents = [];
  map.customization_evidence = { custom_tool_candidates: [], skill_candidates: [] };
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_B);
  assert.deepEqual(
    portfolio.specialists.map((specialist) => specialist.specialist_id),
    ["specialist-api", "specialist-web-ui"],
  );
});

test("stable domain identity survives a module rename while freshness dependencies move", () => {
  const before = portfolioFixture();
  const map = makeSpecialistFixtureMap();
  const replacePath = (value: string): string => value.replaceAll("src/billing", "src/payments");
  const expert = map.expert_evidence!.expert_domains[0]!;
  expert.primary_paths = expert.primary_paths.map(replacePath);
  expert.entry_points = expert.entry_points.map(replacePath);
  expert.test_paths = expert.test_paths.map((value) => value.replaceAll("billing", "payments"));
  expert.key_files = expert.key_files.map((entry) => ({ ...entry, path: replacePath(entry.path) }));
  expert.key_types = expert.key_types.map((entry) => ({ ...entry, path: replacePath(entry.path) }));
  expert.patterns = expert.patterns.map((entry) => ({ ...entry, example_ref: replacePath(entry.example_ref) }));
  expert.pitfalls = expert.pitfalls.map((entry) => ({ ...entry, reference: replacePath(entry.reference) }));
  map.artifact_intents!.feature_agents[0]!.globs = ["src/payments"];
  map.module_graph.edges = map.module_graph.edges.map((edge) => ({
    ...edge,
    from: replacePath(edge.from),
    to: replacePath(edge.to),
  }));
  map.type_contract_surface.typescript_interfaces = map.type_contract_surface.typescript_interfaces.map((entry) => ({
    ...entry,
    path: replacePath(entry.path),
  }));
  const after = discoverSpecialistPortfolio(map, COMMIT_B);
  assert.ok(before.specialists.some((specialist) => specialist.specialist_id === "specialist-billing"));
  const renamed = after.specialists.find((specialist) => specialist.specialist_id === "specialist-billing");
  assert.ok(renamed);
  assert.ok(renamed.owned_paths.includes("src/payments"));
  assert.notEqual(before.source_map_digest, after.source_map_digest);
});

test("portfolio validation rejects authority and digest tampering", () => {
  const portfolio = portfolioFixture();
  const policyTampered = structuredClone(portfolio);
  policyTampered.specialists[0]!.execution_policy.filesystem_writes = "allowed" as never;
  assert.throws(() => validateSpecialistPortfolio(policyTampered));
  const digestTampered = structuredClone(portfolio);
  digestTampered.procedures[0]!.purpose = "Changed without recomputing the digest.";
  assert.throws(() => validateSpecialistPortfolio(digestTampered));
});
