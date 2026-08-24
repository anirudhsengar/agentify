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
import { SYNTHETIC_SPECIALIST_WARNING_PREFIX } from "../../src/core/specialists/discovery.ts";
import { specialistPortfolioDigest } from "../../src/core/specialists/validation.ts";

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
    ["specialist-billing", "specialist-lib-semantics", "specialist-public-api-contracts"],
  );
  const billing = first.specialists[0]!;
  assert.deepEqual(billing.source_kinds, ["expert_evidence"]);
  assert.deepEqual(billing.execution_policy, SPECIALIST_READ_ONLY_EXECUTION_POLICY);
  assert.equal(billing.freshness, "current");
  assert.equal(billing.supporting_commit, COMMIT_A);
  assert.equal(billing.evidence_paths.includes("src/billing"), false);
  assert.ok(billing.evidence_paths.includes("src/billing/index.ts"));
  assert.equal(first.specialists.some((specialist) => specialist.domain === "docs"), false);
  const gapSpecialists = first.specialists.slice(1);
  assert.ok(gapSpecialists.every((specialist) =>
    specialist.source_kinds.length === 1 && specialist.source_kinds[0] === "structural_evidence"
  ));
  assert.ok(gapSpecialists.some((specialist) => specialist.owned_paths.includes("src/index.ts")));
  assert.ok(gapSpecialists.some((specialist) => specialist.owned_paths.includes("src/lib.ts")));
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

test("partial expert portfolios are completed with critical path ownership", () => {
  const map = makeSpecialistFixtureMap();
  map.skeleton.entry_points.push({
    path: "index.js",
    role: "public API",
    language: "javascript",
    run_command: "node index.js",
  });
  map.module_graph.edges.push(
    { from: "lib/command.js", to: "lib/argument.js", kind: "import" },
    { from: "lib/argument.js", to: "lib/error.js", kind: "import" },
  );
  map.type_contract_surface.typescript_interfaces.push({
    path: "typings/index.d.ts",
    name: "Command",
    fields: ["parse", "option", "argument"],
  });
  map.expert_evidence!.expert_domains.push(
    {
      domain: "option-parsing",
      rationale: "Option behavior is recurring and independently tested.",
      primary_paths: ["lib/option.js"],
      entry_points: ["lib/option.js"],
      test_paths: ["tests/options.test.js"],
      key_files: [{ path: "lib/option.js", purpose: "Option implementation.", line_range: [1, 120] }],
      key_types: [],
      patterns: [],
      pitfalls: [],
      conventions: [],
      stability: "high",
      recurrence: "high",
      test_command: "npm test",
      last_updated: "2026-08-01T00:00:00.000Z",
    },
    {
      domain: "help-generation",
      rationale: "Help output has a cohesive rendering surface.",
      primary_paths: ["lib/help.js"],
      entry_points: ["lib/help.js"],
      test_paths: ["tests/help.test.js"],
      key_files: [{ path: "lib/help.js", purpose: "Help implementation.", line_range: [1, 120] }],
      key_types: [],
      patterns: [],
      pitfalls: [],
      conventions: [],
      stability: "high",
      recurrence: "high",
      test_command: "npm test",
      last_updated: "2026-08-01T00:00:00.000Z",
    },
  );
  const tracked = [
    "package.json",
    "index.js",
    "lib/argument.js",
    "lib/command.js",
    "lib/error.js",
    "lib/help.js",
    "lib/option.js",
    "src/billing/index.ts",
    "src/billing/types.ts",
    "tests/billing.test.ts",
    "tests/help.test.js",
    "tests/options.test.js",
    "typings/index.d.ts",
  ];
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A, tracked);
  assert.ok(portfolio.specialists.some((specialist) =>
    specialist.specialist_id === "specialist-public-api-contracts"
  ));
  const option = portfolio.specialists.find((specialist) =>
    specialist.specialist_id === "specialist-option-parsing"
  );
  const help = portfolio.specialists.find((specialist) =>
    specialist.specialist_id === "specialist-help-generation"
  );
  assert.ok(option?.owned_paths.includes("lib/argument.js"));
  assert.ok(help?.owned_paths.includes("lib/error.js"));
  const critical = ["index.js", "lib/argument.js", "lib/command.js", "lib/error.js", "lib/help.js", "lib/option.js", "typings/index.d.ts"];
  assert.ok(critical.every((repositoryPath) =>
    portfolio.specialists.some((specialist) =>
      specialist.owned_paths.some((scope) =>
        repositoryPath === scope || repositoryPath.startsWith(`${scope}/`)
      )
    )
  ), JSON.stringify(portfolio.warnings));
});

test("prose placeholders are never persisted as validation commands", () => {
  const map = makeSpecialistFixtureMap();
  map.operational_surface.build.command = "(none — pure JavaScript library, no build step)";
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A);
  for (const specialist of portfolio.specialists) {
    assert.ok(!specialist.validation_commands.some((command) => command.startsWith("(none")));
  }
  for (const procedure of portfolio.procedures) {
    assert.ok(!procedure.validation_commands.some((command) => command.startsWith("(none")));
    assert.ok(!procedure.allowed_commands.some((command) => command.startsWith("(none")));
  }
});

test("installer-attested commands replace unverified audit command claims", () => {
  const map = makeSpecialistFixtureMap();
  map.validation_surface.test_command = "npm run hallucinated";
  map.expert_evidence!.expert_domains[0]!.test_command = "npm run focused-but-unverified";
  const portfolio = discoverSpecialistPortfolio(
    map,
    COMMIT_A,
    undefined,
    ["npm run verified"],
  );
  assert.ok(portfolio.specialists.length > 0);
  assert.ok(portfolio.specialists.every((specialist) =>
    specialist.validation_commands.every((command) => command === "npm run verified")
  ));
  assert.ok(portfolio.procedures.every((procedure) =>
    procedure.validation_commands.every((command) => command === "npm run verified")
  ));
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
  assert.equal(
    portfolio.specialists.some((specialist) =>
      specialist.owned_paths.some((scope) => scope === "packages/api/src" || scope === "packages")
    ),
    false,
  );
  assert.ok(portfolio.specialists.length > 0);
  assert.ok(portfolio.specialists.every((specialist) =>
    specialist.owned_paths.every((scope) => scope.includes("/") || scope.includes("."))
  ));
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

test("a path is claimed by exactly one primary owner", () => {
  const portfolio = discoverSpecialistPortfolio(makeSpecialistFixtureMap(), COMMIT_A);
  const primaryOwners = new Map<string, string[]>();
  for (const specialist of portfolio.specialists) {
    for (const owned of specialist.owned_paths) {
      primaryOwners.set(owned, [...(primaryOwners.get(owned) ?? []), specialist.specialist_id]);
    }
  }
  const contested = [...primaryOwners.entries()].filter(([, owners]) => owners.length > 1);
  assert.deepEqual(contested, [], `ambiguous routing: ${JSON.stringify(contested)}`);

  // A demoted claim is retained as a secondary stake, not discarded, so the
  // other interested specialist is still a named reviewer for that file.
  for (const specialist of portfolio.specialists) {
    for (const secondary of specialist.secondary_paths) {
      assert.equal(specialist.owned_paths.includes(secondary), false);
      assert.ok(
        specialist.observed_paths.includes(secondary),
        `${specialist.specialist_id} lost visibility of ${secondary}`,
      );
      assert.ok(
        portfolio.specialists.some((other) => other.owned_paths.includes(secondary)),
        `${secondary} has a secondary stake but no primary owner`,
      );
    }
  }
});

test("a manufactured specialist is reported rather than silently satisfying ownership", () => {
  const map = makeSpecialistFixtureMap();
  // Strip the recorded expertise so ownership can only be closed structurally.
  map.expert_evidence = { expert_domains: [] };
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A);

  const synthetic = portfolio.specialists.filter((specialist) =>
    specialist.source_kinds.length === 1 && specialist.source_kinds[0] === "structural_evidence"
  );
  assert.ok(synthetic.length > 0, "the fixture should require structural recovery");
  assert.ok(
    portfolio.warnings.some((warning) => warning.startsWith(SYNTHETIC_SPECIALIST_WARNING_PREFIX)),
    `expected a synthetic-specialist warning; got ${JSON.stringify(portfolio.warnings)}`,
  );
  for (const specialist of synthetic) {
    assert.ok(
      portfolio.warnings.some((warning) => warning.includes(specialist.specialist_id)),
      `${specialist.specialist_id} was not named in any warning`,
    );
  }
});

test("the public API specialist carries the surface a contract change travels with", () => {
  const map = makeSpecialistFixtureMap();
  map.expert_evidence = { expert_domains: [] };
  const portfolio = discoverSpecialistPortfolio(
    map,
    COMMIT_A,
    ["src/index.ts", "src/lib.ts", "package.json", "src/index.test-d.ts", "tests/lib.test.ts"],
  );
  const publicApi = portfolio.specialists.find((specialist) =>
    specialist.specialist_id.includes("public-api-contracts")
  );
  if (publicApi) {
    // A declaration cannot be changed without loading the manifest that exports
    // it and the type tests that pin its inference. The type test is found from
    // the tracked file list, because an audit need not have recorded it.
    assert.ok(
      publicApi.observed_paths.includes("package.json"),
      `public API specialist must observe the package manifest; got ${JSON.stringify(publicApi.observed_paths)}`,
    );
    assert.ok(
      publicApi.observed_paths.includes("src/index.test-d.ts"),
      `public API specialist must observe its type tests; got ${JSON.stringify(publicApi.observed_paths)}`,
    );
  }
});

test("a secondary stake routes as a reviewer, ranked below the primary owner", () => {
  const portfolio = portfolioFixture();
  const owner = portfolio.specialists[0];
  assert.ok(owner, "the fixture needs a specialist");
  const contested = owner.owned_paths[0];
  assert.ok(contested, "the primary owner needs an owned path");
  const other = portfolio.specialists.find((candidate) =>
    candidate.specialist_id !== owner.specialist_id
    && !candidate.owned_paths.includes(contested)
  );
  assert.ok(other, "the fixture needs a second specialist that does not own the path");

  // Model the resolved outcome: one primary owner, one named secondary stake.
  const specialists = portfolio.specialists.map((specialist) =>
    specialist.specialist_id === other.specialist_id
      ? {
        ...specialist,
        secondary_paths: [contested],
        observed_paths: [...new Set([...specialist.observed_paths, contested])]
          .sort((left, right) => left.localeCompare(right)),
      }
      : specialist
  );
  const contended = {
    ...portfolio,
    specialists,
    source_map_digest: specialistPortfolioDigest({
      evidence_paths: portfolio.evidence_paths,
      specialists,
      procedures: portfolio.procedures,
    }),
  };
  const routed = routeSpecialistPortfolio(contended, {
    task_description: "Change the contested module",
    candidate_paths: [contested],
  });

  const ownerSelection = routed.selected_specialists.find((s) => s.specialist_id === owner.specialist_id);
  const reviewerSelection = routed.selected_specialists.find((s) => s.specialist_id === other.specialist_id);
  assert.ok(ownerSelection, "the primary owner must be selected");
  assert.ok(reviewerSelection, "the secondary stake must still be selected as a reviewer");
  assert.ok(
    ownerSelection.score > reviewerSelection.score,
    `the primary owner must outrank the secondary stake (${ownerSelection.score} vs ${reviewerSelection.score})`,
  );
  assert.ok(
    reviewerSelection.reasons.some((reason) => reason.kind === "secondary_path"),
    `secondary responsibility must be its own routing reason; got ${JSON.stringify(reviewerSelection.reasons)}`,
  );
});

test("example scripts do not become the public contract specialist", () => {
  const map = makeSpecialistFixtureMap();
  // Commander's audit recorded its example scripts as entry points. With
  // index.js already owned, the leftovers were named "public-api-contracts"
  // and the specialist owned demonstration code.
  map.skeleton.entry_points.push(
    { path: "examples/split.js", role: "example", language: "javascript", run_command: "node examples/split.js" },
    { path: "examples/string-util.js", role: "example", language: "javascript", run_command: "node examples/string-util.js" },
  );
  const portfolio = discoverSpecialistPortfolio(
    map,
    COMMIT_A,
    ["src/index.ts", "src/lib.ts", "examples/split.js", "examples/string-util.js", "package.json"],
  );

  const publicApi = portfolio.specialists.find((specialist) =>
    specialist.specialist_id.includes("public-api-contracts")
  );
  if (publicApi) {
    const illustrative = publicApi.owned_paths.filter((candidate) => candidate.startsWith("examples/"));
    assert.deepEqual(
      illustrative,
      [],
      `the public contract specialist must not own demonstration code; got ${JSON.stringify(publicApi.owned_paths)}`,
    );
  }
});

test("a pitfall that cannot be traced to a file caps specialist confidence", () => {
  const supported = makeSpecialistFixtureMap();
  const domain = supported.expert_evidence!.expert_domains[0]!;
  assert.ok(domain.pitfalls.length > 0, "the fixture domain needs a pitfall");

  const tracked = ["src/billing/index.ts", "src/billing/types.ts", "tests/billing.test.ts"];
  const before = discoverSpecialistPortfolio(supported, COMMIT_A, tracked)
    .specialists.find((entry) => entry.specialist_id.includes("billing"));
  assert.ok(before);

  // The same domain, with its hazard pointing at a file the repository does
  // not track. The claim is now untraceable, so it cannot carry high confidence.
  const unsupported = makeSpecialistFixtureMap();
  unsupported.expert_evidence!.expert_domains[0]!.pitfalls = [{
    risk: "Retries can double-charge.",
    consequence: "Customers are billed twice.",
    reference: "src/nowhere/invented.ts:42",
  }];
  const after = discoverSpecialistPortfolio(unsupported, COMMIT_A, tracked)
    .specialists.find((entry) => entry.specialist_id.includes("billing"));
  assert.ok(after);
  assert.notEqual(after.confidence, "high", "an untraceable hazard must not be high confidence");

  // The reference is retained so the claim stays checkable.
  assert.ok(
    after.pitfalls.some((pitfall) => pitfall.includes("src/nowhere/invented.ts:42")),
    `pitfalls must record their reference; got ${JSON.stringify(after.pitfalls)}`,
  );
});

test("a file-level pitfall reference does not locate a hazard", () => {
  const tracked = ["src/billing/index.ts", "src/billing/types.ts", "tests/billing.test.ts"];
  const build = (reference: string) => {
    const map = makeSpecialistFixtureMap();
    map.expert_evidence!.expert_domains[0]!.pitfalls = [{
      risk: "Retries can double-charge.",
      consequence: "Customers are billed twice.",
      reference,
    }];
    return discoverSpecialistPortfolio(map, COMMIT_A, tracked)
      .specialists.find((entry) => entry.specialist_id.includes("billing"));
  };

  // A bare path says which file to read; it does not establish the hazard.
  const fileOnly = build("src/billing/index.ts");
  assert.ok(fileOnly);
  assert.notEqual(fileOnly.confidence, "high");

  const located = build("src/billing/index.ts:55");
  assert.ok(located);
  assert.equal(located.confidence, "high");
});

test("a manufactured specialist is not recorded as confident knowledge", () => {
  const map = makeSpecialistFixtureMap();
  map.expert_evidence = { expert_domains: [] };
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A);
  const synthetic = portfolio.specialists.filter((specialist) =>
    specialist.source_kinds.length === 1 && specialist.source_kinds[0] === "structural_evidence"
  );
  assert.ok(synthetic.length > 0);
  for (const specialist of synthetic) {
    assert.equal(
      specialist.confidence,
      "low",
      `${specialist.specialist_id} closes an ownership gap and carries no recorded expertise`,
    );
  }
});

