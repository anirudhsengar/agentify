import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  assessCoverageClosure,
  CodebaseMapSchema,
  compileSpecialistEvidence,
  type CodebaseMap,
} from "../../src/core/audit/schema.ts";
import { assessExplorerReceiptAttestation } from "../../src/core/audit/explorer-receipts.ts";
import { writeCanonicalMap } from "../../src/core/audit/map-storage.ts";
import { detectRestrictiveRepositoryPolicy } from "../../src/core/installer/repository-policy.ts";
import {
  createRepositoryValidationApproval,
  DEFAULT_INSTALLER_PROCESS_RUNNER,
  finalizeOneTimeInstallation,
  prepareOneTimeInstallationState,
  readRepositoryTaskPolicyConfiguration,
  type InstallerProcessRunner,
  type RepositoryInstallationPreflight,
} from "../../src/core/installer/index.ts";
import {
  synchronizeRepositorySpecialists,
} from "../../src/core/specialists/index.ts";
import { attestCodebaseMap, makeValidCodebaseMap } from "../fixtures/codebase-map.ts";
import {
  STABILIZATION_PORTFOLIOS,
  type StabilizationConcernFixture,
  type StabilizationPortfolioFixture,
} from "../fixtures/stabilization-portfolios.ts";

interface CorpusCase {
  repository: string;
  target_commit: string;
  fixture_kind: "reduced-deterministic" | "captured-policy-and-audit-replay";
  portfolio_fixture?: string;
  audit_events: string[];
  expected_core_ownership: string[];
  expected_rejected_candidates: string[];
  expected_unresolved_obligations: string[];
  expected_readiness: string;
  expected_installation_disposition: string;
  budgets: {
    runtime_ms: number;
    model_calls: number;
    turns: number;
    tokens: number;
    cost_usd: number;
    output_bytes: number;
  };
}

interface CorpusFixture {
  schema_version: "2";
  captured_at: string;
  cases: CorpusCase[];
}

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURE_PATH = path.join(ROOT, "tests/fixtures/stabilization-corpus.json");
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as CorpusFixture;
const MAP_CONTEXT = {
  stateDir: ".agentify/runtime/audit",
  mapFilename: "codebase_map.json",
};
const FIXTURE_VALIDATION_ARGV = ["node", "-e", "require('node:assert/strict').ok(require('node:fs').readFileSync('README.md','utf8').length > 0)"];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, repositoryPath: string, content = `${repositoryPath}\n`): void {
  const destination = path.join(cwd, repositoryPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function topLevel(repositoryPath: string): string {
  return repositoryPath.split("/")[0] ?? repositoryPath;
}

function makeConcern(fixture: StabilizationConcernFixture): NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number] {
  return {
    concern: fixture.name,
    one_line: `Owns ${fixture.covers.charAt(0).toLowerCase()}${fixture.covers.slice(1)}`,
    covers: fixture.covers,
    excludes: fixture.excludes,
    flows: [{
      name: fixture.flow.name,
      description: `Verified repository flow for ${fixture.name}.`,
      steps: fixture.flow.steps,
    }],
    touchpoints: fixture.core.map((touchpoint) => ({
      ...touchpoint,
      line_range: null,
      centrality: "core" as const,
    })),
    invariants: [{ ...fixture.invariant, reference: fixture.core[0]!.path }],
    pitfalls: [{
      risk: `Breaking ${fixture.invariant.rule}`,
      consequence: fixture.invariant.why,
      reference: fixture.core[0]!.path,
    }],
    entry_questions: [fixture.entry_question],
    validation: [],
    spans_subtrees: [...new Set(fixture.core.map((touchpoint) => topLevel(touchpoint.path)))],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-28T00:00:00.000Z",
  };
}

function makePortfolioRepository(
  repository: string,
  portfolio: StabilizationPortfolioFixture,
): { cwd: string; commit: string; map: CodebaseMap } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `agentify-corpus-${repository}-`));
  write(cwd, "README.md", `${repository}\n${portfolio.project_type}\n`);
  for (const repositoryPath of new Set(portfolio.concerns.flatMap((concern) => [
    ...concern.core.map((touchpoint) => touchpoint.path),
    ...concern.flow.steps.map((step) => step.path),
  ]))) write(cwd, repositoryPath, portfolio.sources?.[repositoryPath]);
  write(cwd, "Makefile", `# Reduced-fixture validation, not the historical build.\ntest:\n\tnode -e "${FIXTURE_VALIDATION_ARGV[2]}"\n`);
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Corpus");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "deterministic portfolio fixture");
  const commit = git(cwd, "rev-parse", "HEAD");
  const base = makeValidCodebaseMap();
  const map = attestCodebaseMap(makeValidCodebaseMap({
    generated_at: "2026-08-28T00:00:00.000Z",
    meta: {
      ...base.meta,
      project_type: portfolio.project_type,
      languages: portfolio.languages,
      domain_hypothesis: `Repository-specific specialist portfolio for ${repository}.`,
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: [...new Set(portfolio.concerns.flatMap((concern) => (
        concern.core.map((touchpoint) => topLevel(touchpoint.path))
      )))].sort(),
      entry_points: portfolio.concerns.map((concern) => ({
        path: concern.flow.steps[0]!.path,
        role: concern.flow.name,
        language: portfolio.languages[0]!,
        run_command: "not available in deterministic fixture",
      })),
      first_5_files_for_fresh_agent: portfolio.concerns.slice(0, 5).map((concern) => ({
        path: concern.flow.steps[0]!.path,
        why: `Entry to ${concern.name}.`,
      })),
    },
    module_graph: {
      ...base.module_graph,
      edges: portfolio.concerns.flatMap((concern) => concern.flow.steps.slice(1).map((step, index) => ({
        from: concern.flow.steps[index]!.path,
        to: step.path,
        kind: "behavioral flow",
      }))),
    },
    pitfalls: portfolio.concerns.map((concern) => ({
      module: concern.core[0]!.path,
      what: `Breaking ${concern.invariant.rule}`,
      consequence: concern.invariant.why,
      line_ref: 1,
    })),
    concern_evidence: {
      concerns: portfolio.concerns.map(makeConcern),
      not_concerns: [
        ...portfolio.rejected.map(({ candidate, why }) => ({ candidate, why_rejected: why })),
        { candidate: "README documentation", why_rejected: "Repository documentation supports every concern but is not core behavioral ownership." },
      ],
    },
    expert_evidence: undefined,
  }), commit, `corpus-${repository}`);
  return { cwd, commit, map };
}

test("the stabilization corpus declares executable portfolio fixtures", () => {
  assert.equal(FIXTURE.schema_version, "2");
  assert.equal(FIXTURE.cases.length, 9);
  assert.equal(new Set(FIXTURE.cases.map((entry) => entry.repository)).size, 9);
  assert.deepEqual(
    FIXTURE.cases.map((entry) => entry.repository).sort(),
    ["aqa-tests", "axum", "click", "cobra", "commander.js", "gin", "hono", "lobsters", "spring-petclinic"],
  );
  for (const entry of FIXTURE.cases) {
    assert.match(entry.target_commit, /^[0-9a-f]{40}$/);
    assert.ok(entry.audit_events.length > 0, `${entry.repository}: no audit events`);
    assert.ok(entry.expected_readiness.length > 0, `${entry.repository}: no readiness outcome`);
    assert.ok(entry.expected_installation_disposition.length > 0, `${entry.repository}: no installation outcome`);
    assert.ok(entry.budgets.runtime_ms > 0, `${entry.repository}: no runtime budget`);
    assert.equal(entry.budgets.model_calls, 0, `${entry.repository}: deterministic replay must make no model calls`);
    assert.equal(entry.budgets.turns, 0);
    assert.equal(entry.budgets.tokens, 0);
    assert.equal(entry.budgets.cost_usd, 0);
    if (entry.repository === "lobsters") {
      assert.equal(entry.portfolio_fixture, undefined);
    } else {
      assert.equal(entry.portfolio_fixture, entry.repository);
      assert.ok(STABILIZATION_PORTFOLIOS[entry.portfolio_fixture!]);
    }
  }
});

for (const entry of FIXTURE.cases.filter((candidate) => candidate.repository !== "lobsters")) {
  test(`${entry.repository}: evidence compiles and installs the expected portfolio`, () => {
    const startedAt = Date.now();
    const portfolioFixture = STABILIZATION_PORTFOLIOS[entry.portfolio_fixture!];
    assert.ok(portfolioFixture);
    const { cwd, commit, map } = makePortfolioRepository(entry.repository, portfolioFixture);
    try {
      const compilation = compileSpecialistEvidence(map, { cwd });
      assert.equal(compilation.status, "compiled", compilation.reasons.join("; "));
      assert.equal(compilation.complete, true);
      assert.deepEqual(compilation.reasons, entry.expected_unresolved_obligations);
      assert.equal(compilation.map.meta.project_type, portfolioFixture.project_type);
      assert.deepEqual(compilation.map.meta.languages, portfolioFixture.languages);
      assert.deepEqual(assessCoverageClosure(compilation.map, { cwd }).unresolved, []);
      assert.equal(assessExplorerReceiptAttestation(compilation.map, cwd).complete, true);
      assert.equal(fs.existsSync(path.join(cwd, ".agentify")), false, "compilation must not contaminate repository evidence");

      const repeated = compileSpecialistEvidence(compilation.map, { cwd });
      assert.equal(repeated.status, "compiled", repeated.reasons.join("; "));
      assert.deepEqual(repeated.map, compilation.map, "normalization must be idempotent");
      assert.equal(
        Value.Check(CodebaseMapSchema, compilation.map),
        true,
        [...Value.Errors(CodebaseMapSchema, compilation.map)].slice(0, 5).map((error) => `${(error as { path?: string }).path ?? "?"}: ${error.message}`).join("; "),
      );

      // Only external GitHub operations are replayed. Fixture validation and
      // the compiler, scaffold, readiness canaries, and transaction run for real.
      const validationArgv = FIXTURE_VALIDATION_ARGV;
      const runner: InstallerProcessRunner = {
        run(request) {
          if (request.program === "node") {
            assert.deepEqual([request.program, ...request.args], validationArgv);
            return DEFAULT_INSTALLER_PROCESS_RUNNER.run(request);
          }
          assert.equal(request.program, "gh", "corpus must not invoke an unclassified command");
          assert.ok(["api", "variable", "label"].includes(request.args[0]!));
          const stdout = request.args[0] === "api" && request.args[1] !== "--method"
            ? JSON.stringify({ default_workflow_permissions: "read" })
            : request.args[1] === "list" ? "[]" : "";
          return { status: 0, stdout, stderr: "", timedOut: false, errorMessage: null };
        },
      };
      const initialValidation = runner.run({
        program: validationArgv[0]!, args: validationArgv.slice(1), cwd, timeoutMs: 5_000,
      });
      assert.equal(initialValidation.status, 0, initialValidation.stderr);
      const preflight: RepositoryInstallationPreflight = {
        disposition: "ready", analysis_allowed: true, blockers: [],
        identity: {
          repository_id: `corpus-${entry.repository}`, full_name: `corpus/${entry.repository}`,
          current_commit: commit, default_branch: "main", current_branch: git(cwd, "branch", "--show-current"),
          origin_url: `https://github.com/corpus/${entry.repository}.git`,
          actor_login: "corpus", actor_permission: "admin", default_branch_policy: "unprotected",
        },
        commands: [{
          command_id: "test-corpus-fixture", kind: "test", argv: validationArgv,
          cwd: ".", timeout_ms: 5_000, required: true, assessment: "verified",
          exit_code: initialValidation.status, output_digest: null,
          detail: "Executable reduced-fixture validation; not the historical repository test suite.",
        }],
        allowed_write_paths: portfolioFixture.concerns.flatMap((concern) => concern.core.map((touchpoint) => touchpoint.path)),
        protected_paths: [".github/workflows", ".agentify"],
      };
      const approval = createRepositoryValidationApproval({
        cwd, preflight, approvedBy: "corpus", approvedAt: "2026-08-30T00:00:00.000Z",
      });
      prepareOneTimeInstallationState(cwd, preflight);
      writeCanonicalMap(cwd, compilation.map, MAP_CONTEXT);
      const refused = finalizeOneTimeInstallation({
        cwd, preflight, validationApproval: approval,
        provider: "fixture", model: "deterministic-replay", providerVerified: true, agentifyVersion: "1.1.0",
        runner: { run(request) {
          assert.equal(request.program, "node", "failed validation must stop before GitHub configuration");
          return { status: 1, stdout: "", stderr: "replayed validation failure", timedOut: false, errorMessage: null };
        } },
      });
      assert.equal(refused.disposition, "analyzable-only");
      assert.equal(refused.specialists_installed, 0);
      assert.equal(refused.github_issue_intake_enabled, false);
      assert.ok(refused.blockers.some((blocker) => blocker.code === "validation_failed"));
      for (const relative of [".agentify/agents", ".agentify/manifest.json", "AGENTS.md", ".github/workflows/agentify-issue.yml", ".github/workflows/agentify-learn.yml"]) {
        assert.equal(fs.existsSync(path.join(cwd, relative)), false, `${relative}: partial installation survived`);
      }
      prepareOneTimeInstallationState(cwd, preflight);
      writeCanonicalMap(cwd, compilation.map, MAP_CONTEXT);
      const installed = finalizeOneTimeInstallation({
        cwd, preflight, validationApproval: approval, runner,
        agentifyVersion: "1.1.0", provider: "fixture", model: "deterministic-replay", providerVerified: true,
      });
      assert.equal(installed.disposition, entry.expected_readiness, JSON.stringify(installed.blockers));
      assert.equal(installed.specialists_installed, portfolioFixture.concerns.length);
      assert.equal(installed.github_issue_intake_enabled, true);
      assert.equal(readRepositoryTaskPolicyConfiguration(cwd)?.configured, true);
      assert.equal(fs.existsSync(path.join(cwd, ".agentify/manifest.json")), true);
      assert.equal(fs.existsSync(path.join(cwd, ".github/workflows/agentify-issue.yml")), true);
      assert.equal(installed.disposition === "ready" ? "install" : "no-installation", entry.expected_installation_disposition);
      const synchronized = synchronizeRepositorySpecialists(cwd);
      assert.equal(synchronized.status, "synchronized");
      if (synchronized.status !== "synchronized") return;

      const specialists = synchronized.portfolio.specialists;
      assert.deepEqual(specialists.map((specialist) => specialist.concern).sort(), [...entry.expected_core_ownership].sort());
      assert.equal(specialists.length, compilation.map.concern_evidence!.concerns.length);
      assert.equal(installed.specialists_installed, specialists.length);

      for (const expected of portfolioFixture.concerns) {
        const specialist = specialists.find((candidate) => candidate.concern === expected.name);
        assert.ok(specialist, `missing specialist ${expected.name}`);
        assert.equal(specialist.excludes, expected.excludes);
        assert.deepEqual(
          specialist.touchpoints.filter((touchpoint) => touchpoint.centrality === "core").map(({ path: repositoryPath, symbol, role }) => ({ path: repositoryPath, symbol, role })).sort((left, right) => left.path.localeCompare(right.path)),
          [...expected.core].sort((left, right) => left.path.localeCompare(right.path)),
        );
        assert.deepEqual(specialist.flows[0]!.steps, expected.flow.steps);
        assert.equal(specialist.invariants[0]!.rule, expected.invariant.rule);
        assert.deepEqual(specialist.entry_questions, [expected.entry_question]);
      }

      for (const repositoryPath of portfolioFixture.concerns.flatMap((concern) => concern.core.map((touchpoint) => touchpoint.path))) {
        assert.equal(
          specialists.filter((specialist) => specialist.touchpoints.some((touchpoint) => (
            touchpoint.path === repositoryPath && touchpoint.centrality === "core"
          ))).length,
          1,
          `${repositoryPath}: expected exactly one core owner`,
        );
      }
      assert.deepEqual(
        compilation.map.concern_evidence!.not_concerns
          .filter((candidate) => candidate.candidate !== "README documentation")
          .map((candidate) => candidate.candidate),
        entry.expected_rejected_candidates,
      );
      const outputBytes = specialists.map((specialist) => specialist.specialist_id).reduce((total, specialistId) => (
        total + fs.statSync(path.join(cwd, ".agentify/agents/specialists", `${specialistId}.json`)).size
      ), 0);
      assert.ok(outputBytes <= entry.budgets.output_bytes, `${entry.repository}: specialist output budget exceeded`);
      assert.ok(Date.now() - startedAt <= entry.budgets.runtime_ms, `${entry.repository}: runtime budget exceeded`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("lobsters: restrictive tracked policy blocks before persistent mutation", () => {
  const entry = FIXTURE.cases.find((candidate) => candidate.repository === "lobsters")!;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-corpus-lobsters-"));
  try {
    write(cwd, "AGENTS.md", "LLM-generated contributions are prohibited. Do not use AI for code, documentation, tests, or patches.\n");
    write(cwd, "README.md", "Lobsters fixture\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Corpus");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "restrictive policy fixture");
    const policy = detectRestrictiveRepositoryPolicy(cwd, ["AGENTS.md", "README.md"]);
    assert.equal(policy?.path, "AGENTS.md");
    assert.deepEqual(entry.expected_unresolved_obligations, ["repository policy prohibits installation"]);
    assert.equal(entry.expected_readiness, "blocked-before-mutation");
    assert.equal(entry.expected_installation_disposition, "no-installation");
    assert.equal(fs.existsSync(path.join(cwd, ".agentify")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
