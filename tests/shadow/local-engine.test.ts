import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  analyseShadow,
  digestObject,
  evaluateGraders,
  stableStringify,
} from "../../src/core/shadow/engine.ts";
import { redactSecret } from "../../src/core/shadow/redaction.ts";
import { normalizeOrigin } from "../../src/core/shadow/identity.ts";
import {
  LocalShadowAttestationSchema,
  EvalTrialSchema,
  type LocalShadowAttestation,
} from "../../src/core/evals/schema/trial.ts";
import { classifyLocalShadowTrial } from "../../src/core/evals/runner.ts";
import type { EvalTrial } from "../../src/core/evals/schema/trial.ts";
import type { GraderResult } from "../../src/core/evals/schema/grader-result.ts";

function makeAttestation(overrides: Partial<LocalShadowAttestation> = {}): LocalShadowAttestation {
  return {
    repository_identity: "R_local",
    github_repository: "owner/repo",
    issue_number: 42,
    issue_url: "https://github.com/owner/repo/issues/42",
    local_run_id: "local-abc",
    github_operator_login: "operator",
    local_operator_identity: "local-user",
    github_authentication_status: "authenticated",
    repository_commit_sha: "a".repeat(40),
    engagement_id: "eng",
    workflow_id: "eng",
    eval_suite_id: "suite",
    task_id: "task",
    trial_index: 0,
    agentify_version: "0.2.1",
    audit_version: "1",
    started_at: "2026-07-22T00:00:00.000Z",
    ended_at: "2026-07-22T00:01:00.000Z",
    monotonic_runtime_ms: 60_000,
    execution_policy_version: "local-shadow-v1",
    evidence_packet_digest: `sha256:${"c".repeat(64)}`,
    issue_fetched_at: "2026-07-22T00:00:00.000Z",
    workspace_reference: "workspace:repo",
    source_repository_reference: `github:owner/repo@${"a".repeat(40)}`,
    source_repository_commit: "a".repeat(40),
    local_authentication_used_only_for_reads: true,
    ...overrides,
  };
}

const graderPass: GraderResult = {
  schema_version: "1",
  run_id: "local-local-abc",
  task_id: "task",
  trial_index: 0,
  grader_id: "candidate_file_quality",
  grader_version: "shadow-v1",
  status: "pass",
  passed: true,
  score: 1,
  reason: "ok",
  failure_categories: [],
  evidence_references: ["evidence-packet.json"],
  error: null,
  duration_ms: 0,
  confidence: 1,
};

function trial(overrides: Partial<EvalTrial> = {}): EvalTrial {
  return {
    schema_version: "1",
    run_id: "local-local-abc",
    task_id: "task",
    trial_index: 0,
    started_at: "2026-07-22T00:00:00.000Z",
    ended_at: "2026-07-22T00:01:00.000Z",
    status: "passed",
    evidence_origin: "live_local_shadow",
    local_shadow_attestation: makeAttestation(),
    inputs: {},
    environment_reference: "local:abc",
    execution_reference: "local-packet:abc",
    transcript_reference: null,
    cost_usd: 0,
    runtime_ms: 60_000,
    output_references: ["evidence-packet.json"],
    error: null,
    grader_results: [graderPass],
    passed: true,
    failure_categories: [],
    ...overrides,
  };
}

test("redactSecret caps length and strips GitHub PATs", () => {
  const long = "x".repeat(20_000);
  const out = redactSecret(long);
  assert.equal(out.length, 8_000);
  const out2 = redactSecret("token ghp_abcDEF1234567890abcdefghij");
  assert.match(out2, /\[REDACTED\]/);
});

test("redactSecret redacts API keys, tokens, and PEM blocks", () => {
  assert.match(redactSecret("sk-abcdefghijklmnop1234"), /\[REDACTED\]/);
  assert.match(redactSecret("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"), /\[REDACTED\]/);
});

test("normalizeOrigin accepts exact GitHub remotes and rejects unsafe forms", () => {
  assert.equal(normalizeOrigin("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(normalizeOrigin("git@github.com:Owner/Repo.git"), "owner/repo");
  assert.equal(normalizeOrigin("ssh://git@github.com/Owner/Repo.git"), "owner/repo");
  assert.throws(() => normalizeOrigin("/local/path/repo"), /supported GitHub URL/);
  assert.throws(() => normalizeOrigin("https://user:token@github.com/owner/repo.git"), /credentials/);
  assert.throws(() => normalizeOrigin("https://github.com/extra/owner/repo.git"), /exactly owner\/repository/);
  assert.throws(() => normalizeOrigin("https://github.com.example/owner/repo.git"), /github.com/);
});

test("analyseShadow classifies a clear ready issue as ready", () => {
  const result = analyseShadow(
    {
      number: 1,
      title: "Fix cache invalidation",
      body: "Acceptance criteria: when a record is updated the cache must be evicted. Add a focused test. Owner: backend team.",
    },
    { files: ["src/cache/index.ts", "src/cache/evict.ts"], auditPath: "/audit" },
    "1",
  );
  assert.equal(result.readiness, "ready");
  assert.ok(result.candidateFiles.includes("src/cache/index.ts"));
  assert.ok(result.proposedTests.length > 0);
});

test("analyseShadow flags missing acceptance criteria as needs_information", () => {
  const result = analyseShadow({ number: 1, title: "Tweak", body: "Tweak something." }, { files: ["src/x.ts"], auditPath: null }, "missing");
  assert.ok(result.flags.missing_acceptance_criteria);
  assert.equal(result.readiness, "needs_information");
});

test("analyseShadow flags forbidden-action requests as rejected", () => {
  const result = analyseShadow(
    { number: 1, title: "Fix", body: "Acceptance criteria: add test. Owner: team. Also force-push a branch." },
    { files: ["src/x.ts"], auditPath: null },
    "1",
  );
  assert.equal(result.readiness, "rejected");
  assert.ok(result.flags.conflicts_with_forbidden_actions);
});

test("evaluateGraders fails cost and runtime when policy is exceeded", () => {
  const analysis = analyseShadow({ number: 1, title: "ok", body: "Acceptance criteria: add test. Owner: me." }, { files: ["src/a.ts"], auditPath: null }, "1");
  const outcomes = evaluateGraders({
    analysis,
    trialIndex: 0,
    config: {
      maximumRuntimeMs: 100,
      maximumCostUsd: 1,
      forbiddenPaths: [],
      evalSuiteId: "suite",
      taskId: "task",
    },
    costUsd: 5,
    runtimeMs: 5_000,
    expectedFilesFromTask: [],
  });
  const cost = outcomes.find((o) => o.graderId === "cost")!;
  const runtime = outcomes.find((o) => o.graderId === "runtime")!;
  assert.equal(cost.pass, false);
  assert.ok(cost.failureCategories.includes("excessive_cost"));
  assert.equal(runtime.pass, false);
  assert.ok(runtime.failureCategories.includes("timeout"));
});

test("stableStringify sorts object keys for stable digest", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test("digestObject returns a sha256 prefixed digest", () => {
  const d = digestObject({ a: 1 });
  assert.match(d, /^sha256:[0-9a-f]{64}$/);
});

test("LocalShadowAttestationSchema rejects missing fields", () => {
  assert.equal(Value.Check(LocalShadowAttestationSchema, makeAttestation()), true);
  assert.equal(JSON.stringify(makeAttestation()).includes("/tmp/"), false);
  assert.equal(Value.Check(LocalShadowAttestationSchema, makeAttestation({ local_authentication_used_only_for_reads: false as never })), false);
  const broken = makeAttestation();
  delete (broken as Record<string, unknown>).github_operator_login;
  assert.equal(Value.Check(LocalShadowAttestationSchema, broken), false);
});

test("classifyLocalShadowTrial returns valid only when fully attested and passed", () => {
  assert.equal(classifyLocalShadowTrial(trial()), "valid_live_local_shadow_evidence");
  assert.equal(classifyLocalShadowTrial(trial({ local_shadow_attestation: undefined })), "invalid_live_local_shadow_evidence");
  assert.equal(classifyLocalShadowTrial(trial({ passed: false, status: "failed" })), "incomplete_live_local_shadow_evidence");
  assert.equal(
    classifyLocalShadowTrial(trial({ passed: false, status: "failed", failure_categories: ["unsafe_action"] })),
    "invalid_live_local_shadow_evidence",
  );
  assert.equal(
    classifyLocalShadowTrial(trial({ local_shadow_attestation: makeAttestation({ github_operator_login: null, github_authentication_status: "anonymous_read" }) })),
    "invalid_live_local_shadow_evidence",
  );
  assert.equal(
    classifyLocalShadowTrial(trial({ local_shadow_attestation: makeAttestation({ github_operator_login: null, github_authentication_status: "unavailable" }) })),
    "invalid_live_local_shadow_evidence",
  );
});

test("EvalTrialSchema accepts live_local_shadow trials with full attestation", () => {
  const t = trial();
  assert.equal(Value.Check(EvalTrialSchema, t), true);
});

test("EvalTrialSchema accepts synthetic trials without local attestation", () => {
  const t = { ...trial(), evidence_origin: "synthetic" as const, local_shadow_attestation: undefined };
  assert.equal(Value.Check(EvalTrialSchema, t), true);
});