import { Type, type Static } from "typebox";
import { EvalFailureCategorySchema } from "../failure-taxonomy.ts";
import { GraderResultSchema } from "./grader-result.ts";

const NullableReference = Type.Union([Type.String({ minLength: 1, maxLength: 2_000 }), Type.Null()]);
export const LiveShadowAttestationSchema = Type.Object({
  repository_identity: Type.String({ minLength: 1, maxLength: 2_000 }),
  github_repository: Type.String({ minLength: 3, maxLength: 300, pattern: "^[^/]+/[^/]+$" }),
  issue_number: Type.Integer({ minimum: 1 }), workflow_run_id: Type.String({ minLength: 1, maxLength: 128 }),
  github_run_attempt: Type.String({ minLength: 1, maxLength: 32 }), repository_commit_sha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  engagement_id: Type.String({ minLength: 1, maxLength: 128 }), eval_suite_id: Type.String({ minLength: 1, maxLength: 128 }),
  task_id: Type.String({ minLength: 1, maxLength: 128 }), trial_index: Type.Integer({ minimum: 0 }),
  agentify_version: Type.String({ minLength: 1, maxLength: 128 }), audit_version: Type.String({ minLength: 1, maxLength: 128 }),
  started_at: Type.String({ format: "date-time" }), ended_at: Type.String({ format: "date-time" }),
  execution_policy_version: Type.String({ minLength: 1, maxLength: 128 }),
  evidence_packet_digest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
}, { additionalProperties: false, description: "Runner-derived identity binding for supported GitHub shadow evidence; never populated from task or model inputs." });

// Local shadow attestation is the operator-attested local equivalent of the
// GitHub-hosted LiveShadowAttestation. It records the same run-time identity
// fields but uses explicit local values instead of GitHub Actions workflow
// environment variables. The GitHub workflow_run_id / github_run_attempt /
// artifact fields are intentionally absent: local execution does not pretend
// to be a hosted GitHub Actions run. Both fields are required (rather than
// optional) to keep the classification helper honest — a trial cannot
// claim local shadow provenance without naming its operator and run.
export const LocalShadowAttestationSchema = Type.Object({
  repository_identity: Type.String({ minLength: 1, maxLength: 2_000 }),
  github_repository: Type.String({ minLength: 3, maxLength: 300, pattern: "^[^/]+/[^/]+$" }),
  issue_number: Type.Integer({ minimum: 1 }),
  issue_url: Type.String({ pattern: "^https://github\\.com/" }),
  local_run_id: Type.String({ minLength: 1, maxLength: 128 }),
  github_operator_login: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  local_operator_identity: Type.String({ minLength: 1, maxLength: 128 }),
  github_authentication_status: Type.Union([Type.Literal("authenticated"), Type.Literal("anonymous_read"), Type.Literal("unavailable")]),
  repository_commit_sha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  engagement_id: Type.String({ minLength: 1, maxLength: 128 }),
  workflow_id: Type.String({ minLength: 1, maxLength: 128 }),
  eval_suite_id: Type.String({ minLength: 1, maxLength: 128 }),
  task_id: Type.String({ minLength: 1, maxLength: 128 }),
  trial_index: Type.Integer({ minimum: 0 }),
  agentify_version: Type.String({ minLength: 1, maxLength: 128 }),
  audit_version: Type.String({ minLength: 1, maxLength: 128 }),
  started_at: Type.String({ format: "date-time" }),
  ended_at: Type.String({ format: "date-time" }),
  monotonic_runtime_ms: Type.Integer({ minimum: 0 }),
  execution_policy_version: Type.String({ minLength: 1, maxLength: 128 }),
  evidence_packet_digest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
  issue_fetched_at: Type.String({ format: "date-time" }),
  workspace_reference: Type.String({ minLength: 1, maxLength: 512 }),
  source_repository_reference: Type.String({ minLength: 1, maxLength: 512 }),
  source_repository_commit: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  local_authentication_used_only_for_reads: Type.Literal(true),
}, { additionalProperties: false, description: "Operator-attested identity binding for supported local shadow evidence; never populated from issue text or model output." });
export const EvalTrialSchema = Type.Object({
  schema_version: Type.Literal("1"), run_id: Type.String({ minLength: 1, maxLength: 128 }),
  task_id: Type.String({ minLength: 1, maxLength: 128 }), trial_index: Type.Integer({ minimum: 0 }),
  started_at: Type.String({ format: "date-time" }), ended_at: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  status: Type.Union([Type.Literal("planned"), Type.Literal("running"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped"), Type.Literal("error")]),
  evidence_origin: Type.Union([
    Type.Literal("imported"),
    Type.Literal("no_execution"),
    Type.Literal("live_shadow"),
    Type.Literal("live_local_shadow"),
    Type.Literal("synthetic"),
  ]),
  live_shadow_attestation: Type.Optional(LiveShadowAttestationSchema),
  local_shadow_attestation: Type.Optional(LocalShadowAttestationSchema),
  inputs: Type.Record(Type.String(), Type.Unknown()), environment_reference: NullableReference,
  execution_reference: NullableReference, transcript_reference: NullableReference,
  cost_usd: Type.Number({ minimum: 0 }), runtime_ms: Type.Integer({ minimum: 0 }),
  output_references: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 500 }),
  error: Type.Union([Type.String({ minLength: 1, maxLength: 8_000 }), Type.Null()]),
  grader_results: Type.Array(GraderResultSchema, { maxItems: 100 }),
  passed: Type.Union([Type.Boolean(), Type.Null()]),
  failure_categories: Type.Array(EvalFailureCategorySchema, { uniqueItems: true }),
}, { additionalProperties: false });
export type EvalTrial = Static<typeof EvalTrialSchema>;
export type LocalShadowAttestation = Static<typeof LocalShadowAttestationSchema>;
