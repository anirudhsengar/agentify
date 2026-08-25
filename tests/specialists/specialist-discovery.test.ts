import assert from "node:assert/strict";
import test from "node:test";
import {
  SPECIALIST_READ_ONLY_EXECUTION_POLICY,
  assessExpertiseInvalidation,
  discoverSpecialistPortfolio,
  routeSpecialistPortfolio,
  validateSpecialistPortfolio,
} from "../../src/core/specialists/index.ts";
import {
  SPECIALIST_FIXTURE_TRACKED_FILES,
  makeLegacySpecialistFixtureMap,
  makeSpecialistFixtureMap,
} from "../fixtures/specialist-map.ts";

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
  return discoverSpecialistPortfolio(map, COMMIT_A, SPECIALIST_FIXTURE_TRACKED_FILES);
}

test("discovery turns recorded concerns into specialists and ignores speculative helpers", () => {
  const first = portfolioFixture();
  const second = portfolioFixture();
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.specialists.map((specialist) => specialist.specialist_id),
    ["specialist-authentication", "specialist-billing"],
  );
  const auth = first.specialists[0]!;
  assert.deepEqual(auth.source_kinds, ["concern_evidence"]);
  assert.deepEqual(auth.execution_policy, SPECIALIST_READ_ONLY_EXECUTION_POLICY);
  assert.equal(auth.freshness, "current");
  assert.equal(auth.supporting_commit, COMMIT_A);
  assert.equal(auth.confidence, "high");
  assert.equal(first.specialists.some((specialist) => specialist.concern === "docs"), false);
  assert.equal(first.procedures.some((procedure) => procedure.procedure_id === "api-endpoint"), false);
  assert.equal(first.procedures.some((procedure) => procedure.procedure_id === "prime-db"), false);
  assert.ok(first.procedures.every((procedure) => procedure.evidence_paths.length > 0));
  assert.ok(first.procedures.every((procedure) => procedure.validation_commands.length > 0));
});

// The defining property of the concern model. The previous implementation
// merged any two candidates whose paths overlapped by 80%, which is precisely
// how a cross-cutting concern presents itself — so authentication and checkout
// collapsed into a single specialist that understood neither.
test("concerns sharing a file become separate, linked specialists rather than one merged blob", () => {
  const portfolio = portfolioFixture();
  const auth = portfolio.specialists.find((s) => s.specialist_id === "specialist-authentication")!;
  const billing = portfolio.specialists.find((s) => s.specialist_id === "specialist-billing")!;
  const shared = "src/middleware/session.ts";

  assert.ok(auth.touchpoints.some((touchpoint) => touchpoint.path === shared));
  assert.ok(billing.touchpoints.some((touchpoint) => touchpoint.path === shared));

  // The shared file carries a different role in each specialist, because each
  // reads it for a different reason.
  const authRole = auth.touchpoints.find((t) => t.path === shared)!.role;
  const billingRole = billing.touchpoints.find((t) => t.path === shared)!.role;
  assert.notEqual(authRole, billingRole);

  // Sharing code makes them related, not duplicates.
  assert.deepEqual(auth.related_specialists, ["specialist-billing"]);
  assert.deepEqual(billing.related_specialists, ["specialist-authentication"]);
});

test("a specialist records its concern's reach across unrelated subtrees", () => {
  const portfolio = portfolioFixture();
  const auth = portfolio.specialists[0]!;
  assert.deepEqual(auth.spans_subtrees, ["src", "tests"]);
  assert.ok(auth.context_paths.includes("src/routes/login.ts"));
  assert.ok(auth.context_paths.includes("src/auth/verify.ts"));
  assert.ok(auth.context_paths.includes("tests/auth.test.ts"));
});

test("a traced flow survives discovery as an ordered route", () => {
  const portfolio = portfolioFixture();
  const auth = portfolio.specialists[0]!;
  assert.equal(auth.flows.length, 1);
  assert.deepEqual(
    auth.flows[0]!.steps.map((step) => step.path),
    ["src/routes/login.ts", "src/auth/verify.ts", "src/middleware/session.ts"],
  );
});

test("touchpoints that are not tracked files are dropped and the specialist survives on the rest", () => {
  const map = makeSpecialistFixtureMap();
  map.concern_evidence!.concerns[0]!.touchpoints.push({
    path: "vendor/fetched/auth.js",
    symbol: null,
    role: "Vendored dependency the audit should not have cited.",
    line_range: null,
    centrality: "supporting",
  });
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A, SPECIALIST_FIXTURE_TRACKED_FILES);
  const auth = portfolio.specialists.find((s) => s.specialist_id === "specialist-authentication")!;
  assert.ok(auth);
  assert.ok(auth.touchpoints.every((touchpoint) =>
    SPECIALIST_FIXTURE_TRACKED_FILES.includes(touchpoint.path)
  ));
  assert.ok(!auth.context_paths.includes("vendor/fetched/auth.js"));
});

// The aqa-tests failure: every path of the only recorded concern lived in a
// directory fetched at build time, so nothing survived evidence binding.
test("a concern with no tracked touchpoint is rejected with a warning that names it and why", () => {
  const map = makeSpecialistFixtureMap();
  map.concern_evidence!.concerns = [map.concern_evidence!.concerns[0]!];
  map.concern_evidence!.concerns[0]!.touchpoints = [{
    path: "TKG/src/org/testKitGen/MainRunner.java",
    symbol: null,
    role: "Harness entry point in a directory cloned at build time.",
    line_range: null,
    centrality: "core",
  }];
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A, ["package.json"]);
  assert.deepEqual(portfolio.specialists, []);
  const warning = portfolio.warnings.find((text) => text.includes("authentication"));
  assert.ok(warning, "the warning names the rejected concern");
  assert.match(warning, /no touchpoint is a file tracked at/);
  assert.match(warning, /TKG\/src\/org\/testKitGen\/MainRunner\.java/);
  // Repository-wide procedure evidence may still stand; none of it is the
  // untracked code the rejected concern was built on.
  assert.ok(portfolio.evidence_paths.every((candidate) => !candidate.startsWith("TKG/")));
});

test("display annotations are removed from touchpoint paths", () => {
  const map = makeSpecialistFixtureMap();
  map.concern_evidence!.concerns[0]!.touchpoints[0]!.path = "src/auth/verify.ts (model display label)";
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A, SPECIALIST_FIXTURE_TRACKED_FILES);
  const auth = portfolio.specialists.find((s) => s.specialist_id === "specialist-authentication")!;
  assert.ok(auth.context_paths.includes("src/auth/verify.ts"));
  assert.ok(auth.context_paths.every((candidate) => !candidate.includes("(model display label)")));
});

test("a flow reduced below two steps by verification is dropped rather than kept as one hop", () => {
  const map = makeSpecialistFixtureMap();
  const tracked = SPECIALIST_FIXTURE_TRACKED_FILES.filter((path) =>
    path !== "src/auth/verify.ts" && path !== "src/middleware/session.ts"
  );
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A, tracked);
  const auth = portfolio.specialists.find((s) => s.specialist_id === "specialist-authentication")!;
  assert.ok(auth);
  assert.deepEqual(auth.flows, []);
});

// Routing must follow meaning. Previously a semantic match scored 2 against a
// path match at 12, so a task squarely about a concern could not be routed to
// it without also naming files inside a matching directory.
test("routing selects a specialist from the task's meaning with no path overlap at all", () => {
  const portfolio = portfolioFixture();
  const report = routeSpecialistPortfolio(portfolio, {
    task_description: "Rework authentication so a revoked account loses access immediately",
  });
  assert.equal(report.selected_specialists[0]?.specialist_id, "specialist-authentication");
  assert.ok(report.selected_specialists[0]?.reasons.some((reason) => reason.kind === "concern_match"));
});

test("routing explains touchpoint, contract, and risk decisions and rejects escaping paths", () => {
  const portfolio = portfolioFixture();
  const report = routeSpecialistPortfolio(portfolio, {
    task_description: "Add partial invoice refunds while preserving idempotency",
    candidate_paths: ["src/billing/charge.ts"],
    contracts: ["Amounts are stored in cents."],
    risk_category: "high",
  });
  assert.equal(report.selected_specialists[0]?.specialist_id, "specialist-billing");
  assert.ok(report.selected_specialists[0]?.reasons.some((reason) => reason.kind === "touchpoint"));
  assert.ok(report.selected_specialists[0]?.reasons.some((reason) => reason.kind === "contract"));
  assert.ok(report.selected_procedures.some((procedure) => procedure.procedure_id === "validate-billing"));
  assert.throws(() => routeSpecialistPortfolio(portfolio, {
    task_description: "Read a secret",
    candidate_paths: ["../secret"],
  }));
});

test("a core touchpoint outranks a merely known one", () => {
  const portfolio = portfolioFixture();
  const core = routeSpecialistPortfolio(portfolio, {
    task_description: "Adjust the stored value",
    candidate_paths: ["src/billing/index.ts"],
  }).selected_specialists.find((s) => s.specialist_id === "specialist-billing");
  const supporting = routeSpecialistPortfolio(portfolio, {
    task_description: "Adjust the stored value",
    candidate_paths: ["tests/billing.test.ts"],
  }).selected_specialists.find((s) => s.specialist_id === "specialist-billing");
  assert.ok(core && supporting);
  assert.ok(core.score > supporting.score);
});

// Risk must amplify whatever this repository recorded, never inject a fixed
// vocabulary of concerns the tool considers important in advance.
test("risk raises recorded concerns without introducing a vocabulary of its own", () => {
  const portfolio = portfolioFixture();
  const low = routeSpecialistPortfolio(portfolio, {
    task_description: "Adjust billing rounding",
    candidate_paths: ["src/billing/index.ts"],
    risk_category: "low",
  }).selected_specialists[0]!;
  const critical = routeSpecialistPortfolio(portfolio, {
    task_description: "Adjust billing rounding",
    candidate_paths: ["src/billing/index.ts"],
    risk_category: "critical",
  }).selected_specialists[0]!;
  assert.equal(low.specialist_id, critical.specialist_id);
  assert.ok(critical.score > low.score);

  // Risk amplifies an existing match; it can never select a specialist on its
  // own. A task with nothing in common with any recorded concern stays
  // unrouted no matter how risky it is declared to be.
  const unrelated = routeSpecialistPortfolio(portfolio, {
    task_description: "Bump the container base image tag",
    risk_category: "critical",
  });
  assert.deepEqual(unrelated.selected_specialists, []);
});

test("invalidation affects only expertise whose dependencies intersect changed files", () => {
  const portfolio = portfolioFixture();
  const report = assessExpertiseInvalidation(portfolio, ["src/billing/charge.ts"]);
  assert.deepEqual(report.specialist_ids, ["specialist-billing"]);
  assert.ok(report.procedure_ids.includes("validate-billing"));
  assert.equal(report.procedure_ids.includes("prime-db"), false);
});

test("a shared file invalidates every specialist that reads it", () => {
  const portfolio = portfolioFixture();
  const report = assessExpertiseInvalidation(portfolio, ["src/middleware/session.ts"]);
  assert.deepEqual(report.specialist_ids, ["specialist-authentication", "specialist-billing"]);
});

test("stable concern identity survives a module rename while dependencies move", () => {
  const before = portfolioFixture();
  const map = makeSpecialistFixtureMap();
  const rename = (value: string): string => value.replaceAll("src/billing", "src/payments");
  const billing = map.concern_evidence!.concerns[1]!;
  billing.touchpoints = billing.touchpoints.map((touchpoint) => ({
    ...touchpoint,
    path: rename(touchpoint.path),
  }));
  billing.flows = billing.flows.map((flow) => ({
    ...flow,
    steps: flow.steps.map((step) => ({ ...step, path: rename(step.path) })),
  }));
  const after = discoverSpecialistPortfolio(
    map,
    COMMIT_B,
    SPECIALIST_FIXTURE_TRACKED_FILES.map(rename),
  );
  assert.ok(before.specialists.some((s) => s.specialist_id === "specialist-billing"));
  const renamed = after.specialists.find((s) => s.specialist_id === "specialist-billing");
  assert.ok(renamed, "the concern keeps its identity when its code moves");
  assert.ok(renamed.context_paths.includes("src/payments/index.ts"));
  assert.notEqual(before.source_map_digest, after.source_map_digest);
});

// A concern is named in the repository's own words. No canonical vocabulary,
// no rewriting one domain name into another.
test("concern names are preserved exactly as the audit recorded them", () => {
  const map = makeSpecialistFixtureMap();
  map.concern_evidence!.concerns[1]!.concern = "payments";
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A, SPECIALIST_FIXTURE_TRACKED_FILES);
  assert.ok(portfolio.specialists.some((s) => s.specialist_id === "specialist-payments"));
  assert.ok(portfolio.specialists.every((s) => s.specialist_id !== "specialist-billing"));
  assert.equal(
    portfolio.specialists.find((s) => s.specialist_id === "specialist-payments")?.concern,
    "payments",
  );
});

test("a pre-concern map still installs, with capped confidence and an honest warning", () => {
  const portfolio = discoverSpecialistPortfolio(
    makeLegacySpecialistFixtureMap(),
    COMMIT_A,
    ["src/billing/index.ts", "tests/billing.test.ts"],
  );
  const billing = portfolio.specialists.find((s) => s.specialist_id === "specialist-billing");
  assert.ok(billing);
  assert.deepEqual(billing.source_kinds, ["legacy_expert_evidence"]);
  assert.equal(billing.confidence, "low");
  assert.deepEqual(billing.flows, []);
  assert.ok(portfolio.warnings.some((warning) => warning.includes("pre-concern audit map")));
});

test("an audit that recorded no concerns says so instead of failing silently", () => {
  const map = makeSpecialistFixtureMap();
  map.concern_evidence = { concerns: [], not_concerns: [] };
  const portfolio = discoverSpecialistPortfolio(map, COMMIT_A, SPECIALIST_FIXTURE_TRACKED_FILES);
  assert.deepEqual(portfolio.specialists, []);
  assert.ok(portfolio.warnings.some((warning) =>
    warning.includes("recorded no repository concerns")
  ));
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

test("validation rejects a hand-built flow that is not an end-to-end trace", () => {
  const portfolio = portfolioFixture();
  const tampered = structuredClone(portfolio);
  tampered.specialists[0]!.flows[0]!.steps = [{ path: "src/auth/verify.ts", what_happens: "Everything." }];
  assert.throws(() => validateSpecialistPortfolio(tampered));
});
