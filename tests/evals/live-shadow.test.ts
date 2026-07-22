import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { classifyLiveShadowTrial, EvalTrialSchema, type EvalTrial } from "../../src/core/evals/index.ts";

const timestamp = "2026-07-22T00:00:00.000Z";
const attestation = {
  repository_identity: "R_1", github_repository: "owner/repo", issue_number: 42,
  workflow_run_id: "900", github_run_attempt: "1", repository_commit_sha: "a".repeat(40),
  engagement_id: "eng", eval_suite_id: "suite", task_id: "task", trial_index: 0,
  agentify_version: "0.2.1", audit_version: "7", started_at: timestamp, ended_at: timestamp,
  execution_policy_version: "github-shadow-v1", evidence_packet_digest: `sha256:${"b".repeat(64)}`,
};
const grader = { schema_version: "1" as const, run_id: "shadow-900-1", task_id: "task", trial_index: 0, grader_id: "required_evidence", grader_version: "shadow-v1", status: "pass" as const, passed: true, score: 1, reason: "passed", failure_categories: [], evidence_references: ["evidence-packet.json"], error: null, duration_ms: 0, confidence: 1 };
function trial(overrides: Partial<EvalTrial> = {}): EvalTrial {
  return { schema_version: "1", run_id: "shadow-900-1", task_id: "task", trial_index: 0, started_at: timestamp, ended_at: timestamp, status: "passed", evidence_origin: "live_shadow", live_shadow_attestation: attestation, inputs: {}, environment_reference: "github-actions:900:1", execution_reference: `shadow-packet:sha256:${"b".repeat(64)}`, transcript_reference: null, cost_usd: 0, runtime_ms: 12, output_references: ["evidence-packet.json"], error: null, grader_results: [grader], passed: true, failure_categories: [], ...overrides };
}

test("live shadow trial schema records the complete controlled-runtime identity binding", () => {
  assert.equal(Value.Check(EvalTrialSchema, trial()), true);
  assert.equal(Value.Check(EvalTrialSchema, trial({ live_shadow_attestation: { ...attestation, repository_commit_sha: "from-issue" } })), false);
});

test("shadow evidence classification never treats incomplete or unsafe analysis as valid", () => {
  assert.equal(classifyLiveShadowTrial(trial()), "valid_live_shadow_evidence");
  assert.equal(classifyLiveShadowTrial(trial({ live_shadow_attestation: undefined })), "invalid_live_shadow_evidence");
  assert.equal(classifyLiveShadowTrial(trial({ passed: false, status: "failed" })), "incomplete_live_shadow_evidence");
  assert.equal(classifyLiveShadowTrial(trial({ passed: false, status: "failed", failure_categories: ["unsafe_action"] })), "invalid_live_shadow_evidence");
});
