import { Type, type Static, type TSchema } from "typebox";

const SAFE_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,127}$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";
const GIT_COMMIT_PATTERN = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";
const ISO_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const NON_EMPTY_TEXT = { minLength: 1, maxLength: 4_000 } as const;
const SHORT_TEXT = { minLength: 1, maxLength: 256 } as const;
const SAFE_ID = {
  pattern: SAFE_ID_PATTERN,
  minLength: 1,
  maxLength: 128,
} as const;
const SHA256 = { pattern: SHA256_PATTERN, minLength: 64, maxLength: 64 } as const;
const GIT_COMMIT = { pattern: GIT_COMMIT_PATTERN, minLength: 40, maxLength: 64 } as const;

export const TEAM_MEMORY_MANIFEST_TYPE = "agentify_team_memory" as const;
export const TEAM_MEMORY_MAX_MANIFEST_ENTRIES = 20_000;

export const MemoryTimestampSchema = Type.String({
  pattern: ISO_TIMESTAMP_PATTERN,
  description: "UTC ISO-8601 timestamp.",
});

export const MemorySourceTypeSchema = Type.Union([
  Type.Literal("validated_bootstrap"),
  Type.Literal("merged_code"),
  Type.Literal("passing_validation"),
  Type.Literal("accepted_review_feedback"),
  Type.Literal("maintainer_instruction"),
  Type.Literal("committed_documentation"),
  Type.Literal("architecture_decision"),
  Type.Literal("repeated_successful_pattern"),
], { description: "Trusted provenance class for durable Agentify knowledge." });

export const MemoryConfidenceSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("verified"),
]);

export const MemoryFreshnessSchema = Type.Union([
  Type.Literal("current"),
  Type.Literal("stale"),
  Type.Literal("superseded"),
  Type.Literal("invalid"),
]);

export const MemoryKindSchema = Type.Union([
  Type.Literal("codebase"),
  Type.Literal("procedure"),
  Type.Literal("episode"),
  Type.Literal("specialist"),
  Type.Literal("orchestrator"),
  Type.Literal("policy"),
]);

export const AgentRoleSchema = Type.Union([
  Type.Literal("orchestrator"),
  Type.Literal("specialist"),
  Type.Literal("builder"),
  Type.Literal("reviewer"),
  Type.Literal("knowledge_maintainer"),
]);

export const AgentWriteAuthoritySchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("knowledge"),
  Type.Literal("application_task"),
]);

export const EvidenceReferenceSchema = Type.Object({
  evidence_id: Type.String(SAFE_ID),
  source_type: MemorySourceTypeSchema,
  repository_path: Type.Union([
    Type.String({ minLength: 1, maxLength: 1_024 }),
    Type.Null(),
  ], { description: "Repository-relative evidence path when applicable." }),
  commit_sha: Type.String(GIT_COMMIT),
  /**
   * When the cited commit was authored. Distinct from `observed_at`: a source
   * commit time is not evidence that anything looked at it.
   */
  source_commit_time: Type.Optional(Type.Union([MemoryTimestampSchema, Type.Null()])),
  sha256: Type.Union([Type.String(SHA256), Type.Null()]),
  line_start: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  line_end: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  external_ref: Type.Union([
    Type.String({ minLength: 1, maxLength: 2_048 }),
    Type.Null(),
  ]),
  description: Type.String(NON_EMPTY_TEXT),
  observed_at: MemoryTimestampSchema,
  actor: Type.Union([
    Type.String({ minLength: 1, maxLength: 256 }),
    Type.Null(),
  ]),
}, {
  additionalProperties: false,
  description: "Bounded evidence supporting an identity, fact, procedure, or lesson.",
});

export const HumanAttributionSchema = Type.Object({
  actor: Type.String({ minLength: 1, maxLength: 256 }),
  source_ref: Type.String({ minLength: 1, maxLength: 2_048 }),
  accepted_at: MemoryTimestampSchema,
}, { additionalProperties: false });

export const AgentIdentitySchema = Type.Object({
  schema_version: Type.Literal("1"),
  agent_id: Type.String(SAFE_ID),
  revision: Type.Integer({ minimum: 1 }),
  role: AgentRoleSchema,
  display_name: Type.String(SHORT_TEXT),
  domain: Type.Union([Type.String(SHORT_TEXT), Type.Null()]),
  status: Type.Union([Type.Literal("active"), Type.Literal("retired")]),
  read_only: Type.Boolean(),
  write_authority: AgentWriteAuthoritySchema,
  github_write_authority: Type.Literal("none"),
  memory_kinds: Type.Array(MemoryKindSchema, { minItems: 0, maxItems: 6, uniqueItems: true }),
  supporting_commit: Type.String(GIT_COMMIT),
  evidence: Type.Array(EvidenceReferenceSchema, { minItems: 1, maxItems: 128 }),
  created_at: MemoryTimestampSchema,
  updated_at: MemoryTimestampSchema,
  content_digest: Type.String(SHA256),
}, {
  additionalProperties: false,
  description: "Persistent repository-scoped identity and immutable authority boundary for one Agentify role.",
});

export const CodebaseRelationshipSchema = Type.Object({
  from: Type.String(SHORT_TEXT),
  to: Type.String(SHORT_TEXT),
  kind: Type.Union([
    Type.Literal("imports"),
    Type.Literal("calls"),
    Type.Literal("owns"),
    Type.Literal("persists"),
    Type.Literal("publishes"),
    Type.Literal("validates"),
    Type.Literal("depends_on"),
  ]),
}, { additionalProperties: false });

export const CodebaseMemoryPayloadSchema = Type.Object({
  subject: Type.String(SHORT_TEXT),
  paths: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 1, maxItems: 256 }),
  symbols: Type.Array(Type.String(SHORT_TEXT), { minItems: 0, maxItems: 256 }),
  contracts: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 0, maxItems: 128 }),
  relationships: Type.Array(CodebaseRelationshipSchema, { minItems: 0, maxItems: 256 }),
  validation_commands: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { minItems: 0, maxItems: 64 }),
}, { additionalProperties: false });

export const ProcedureMemoryPayloadSchema = Type.Object({
  name: Type.String(SAFE_ID),
  trigger_conditions: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 1, maxItems: 64 }),
  required_context_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 0, maxItems: 256 }),
  allowed_commands: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { minItems: 0, maxItems: 64 }),
  expected_file_patterns: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 0, maxItems: 128 }),
  side_effects: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 0, maxItems: 64 }),
  validation_commands: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { minItems: 1, maxItems: 64 }),
  recovery_steps: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 1, maxItems: 64 }),
}, { additionalProperties: false });

export const EpisodeAttemptSchema = Type.Object({
  sequence: Type.Integer({ minimum: 1, maximum: 64 }),
  approach: Type.String(NON_EMPTY_TEXT),
  result: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  failure_category: Type.Union([Type.String(SHORT_TEXT), Type.Null()]),
  signal: Type.String(NON_EMPTY_TEXT),
  correction: Type.Union([Type.String(NON_EMPTY_TEXT), Type.Null()]),
}, { additionalProperties: false });

export const EpisodeMemoryPayloadSchema = Type.Object({
  task_id: Type.String(SAFE_ID),
  issue_number: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  outcome: Type.Union([
    Type.Literal("success"),
    Type.Literal("failure"),
    Type.Literal("cancelled"),
    Type.Literal("partial"),
  ]),
  attempts: Type.Array(EpisodeAttemptSchema, { minItems: 1, maxItems: 64 }),
  review_feedback: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 0, maxItems: 128 }),
  generalization: Type.Union([
    Type.Literal("task_local"),
    Type.Literal("candidate"),
    Type.Literal("generalized"),
  ]),
  cost_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  runtime_ms: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false });

export const SpecialistMemoryPayloadSchema = Type.Object({
  specialist_id: Type.String(SAFE_ID),
  domain: Type.String(SHORT_TEXT),
  owned_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 0, maxItems: 256 }),
  observed_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 1, maxItems: 512 }),
  contracts: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 0, maxItems: 128 }),
  patterns: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 0, maxItems: 128 }),
  pitfalls: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 0, maxItems: 128 }),
  related_specialists: Type.Array(Type.String(SAFE_ID), { minItems: 0, maxItems: 64 }),
  validation_commands: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { minItems: 0, maxItems: 64 }),
}, { additionalProperties: false });

export const OrchestratorMemoryPayloadSchema = Type.Object({
  routing_key: Type.String(SAFE_ID),
  issue_signals: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 1, maxItems: 128 }),
  selected_specialists: Type.Array(Type.String(SAFE_ID), { minItems: 0, maxItems: 64 }),
  risk_category: Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("critical"),
  ]),
  outcome: Type.Union([
    Type.Literal("successful"),
    Type.Literal("failed"),
    Type.Literal("escalated"),
    Type.Literal("cancelled"),
  ]),
  validation_policy: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 1, maxItems: 64 }),
  cost_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  runtime_ms: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false });

export const PolicyMemoryPayloadSchema = Type.Object({
  policy_key: Type.String(SAFE_ID),
  rule: Type.String(NON_EMPTY_TEXT),
  protected_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 0, maxItems: 256 }),
  allowed_tools: Type.Array(Type.String(SAFE_ID), { minItems: 0, maxItems: 128 }),
  forbidden_actions: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 0, maxItems: 128 }),
  approval_required: Type.Boolean(),
  numeric_limit: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  unit: Type.Union([Type.String(SHORT_TEXT), Type.Null()]),
}, { additionalProperties: false });

const MemoryCandidateBaseProperties = {
  schema_version: Type.Literal("1"),
  candidate_id: Type.String(SAFE_ID),
  memory_id: Type.String(SAFE_ID),
  proposed_by_agent_id: Type.String(SAFE_ID),
  owning_agent_id: Type.String(SAFE_ID),
  statement: Type.String(NON_EMPTY_TEXT),
  source_type: MemorySourceTypeSchema,
  supporting_commit: Type.String(GIT_COMMIT),
  evidence: Type.Array(EvidenceReferenceSchema, { minItems: 1, maxItems: 128 }),
  confidence: MemoryConfidenceSchema,
  dependent_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 0, maxItems: 256 }),
  invalidation_conditions: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 0, maxItems: 64 }),
  contradicts: Type.Array(Type.String(SAFE_ID), { minItems: 0, maxItems: 64 }),
  human_attribution: Type.Union([HumanAttributionSchema, Type.Null()]),
  tags: Type.Array(Type.String(SAFE_ID), { minItems: 0, maxItems: 64 }),
  proposed_at: MemoryTimestampSchema,
} as const;

const MemoryRecordBaseProperties = {
  schema_version: Type.Literal("1"),
  memory_id: Type.String(SAFE_ID),
  revision: Type.Integer({ minimum: 1 }),
  owning_agent_id: Type.String(SAFE_ID),
  statement: Type.String(NON_EMPTY_TEXT),
  source_type: MemorySourceTypeSchema,
  supporting_commit: Type.String(GIT_COMMIT),
  evidence: Type.Array(EvidenceReferenceSchema, { minItems: 1, maxItems: 128 }),
  confidence: MemoryConfidenceSchema,
  freshness: MemoryFreshnessSchema,
  dependent_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 0, maxItems: 256 }),
  invalidation_conditions: Type.Array(Type.String(NON_EMPTY_TEXT), { minItems: 0, maxItems: 64 }),
  superseded_by: Type.Union([Type.String(SAFE_ID), Type.Null()]),
  contradicts: Type.Array(Type.String(SAFE_ID), { minItems: 0, maxItems: 64 }),
  human_attribution: Type.Union([HumanAttributionSchema, Type.Null()]),
  tags: Type.Array(Type.String(SAFE_ID), { minItems: 0, maxItems: 64 }),
  accepted_candidate_ids: Type.Array(Type.String(SAFE_ID), { minItems: 1, maxItems: 256, uniqueItems: true }),
  created_at: MemoryTimestampSchema,
  updated_at: MemoryTimestampSchema,
  semantic_digest: Type.String(SHA256),
  content_digest: Type.String(SHA256),
} as const;

function candidateSchema<TKind extends string, TPayload extends TSchema>(
  kind: TKind,
  payload: TPayload,
  description: string,
) {
  return Type.Object({
    ...MemoryCandidateBaseProperties,
    kind: Type.Literal(kind),
    payload,
    candidate_digest: Type.String(SHA256),
  }, { additionalProperties: false, description });
}

function recordSchema<TKind extends string, TPayload extends TSchema>(
  kind: TKind,
  payload: TPayload,
  description: string,
) {
  return Type.Object({
    ...MemoryRecordBaseProperties,
    kind: Type.Literal(kind),
    payload,
  }, { additionalProperties: false, description });
}

export const CodebaseMemoryCandidateSchema = candidateSchema(
  "codebase", CodebaseMemoryPayloadSchema, "Candidate repository fact or relationship.",
);
export const ProcedureMemoryCandidateSchema = candidateSchema(
  "procedure", ProcedureMemoryPayloadSchema, "Candidate repository-specific procedure.",
);
export const EpisodeMemoryCandidateSchema = candidateSchema(
  "episode", EpisodeMemoryPayloadSchema, "Candidate task episode and bounded mistake history.",
);
export const SpecialistMemoryCandidateSchema = candidateSchema(
  "specialist", SpecialistMemoryPayloadSchema, "Candidate specialist expertise.",
);
export const OrchestratorMemoryCandidateSchema = candidateSchema(
  "orchestrator", OrchestratorMemoryPayloadSchema, "Candidate orchestration and routing lesson.",
);
export const PolicyMemoryCandidateSchema = candidateSchema(
  "policy", PolicyMemoryPayloadSchema, "Candidate maintainer-controlled policy record.",
);

export const MemoryCandidateSchema = Type.Union([
  CodebaseMemoryCandidateSchema,
  ProcedureMemoryCandidateSchema,
  EpisodeMemoryCandidateSchema,
  SpecialistMemoryCandidateSchema,
  OrchestratorMemoryCandidateSchema,
  PolicyMemoryCandidateSchema,
]);

export const CodebaseMemoryRecordSchema = recordSchema(
  "codebase", CodebaseMemoryPayloadSchema, "Durable repository fact or relationship.",
);
export const ProcedureMemoryRecordSchema = recordSchema(
  "procedure", ProcedureMemoryPayloadSchema, "Durable repository-specific procedure.",
);
export const EpisodeMemoryRecordSchema = recordSchema(
  "episode", EpisodeMemoryPayloadSchema, "Durable bounded task episode.",
);
export const SpecialistMemoryRecordSchema = recordSchema(
  "specialist", SpecialistMemoryPayloadSchema, "Durable specialist expertise.",
);
export const OrchestratorMemoryRecordSchema = recordSchema(
  "orchestrator", OrchestratorMemoryPayloadSchema, "Durable routing and orchestration lesson.",
);
export const PolicyMemoryRecordSchema = recordSchema(
  "policy", PolicyMemoryPayloadSchema, "Durable maintainer-controlled policy record.",
);

export const MemoryRecordSchema = Type.Union([
  CodebaseMemoryRecordSchema,
  ProcedureMemoryRecordSchema,
  EpisodeMemoryRecordSchema,
  SpecialistMemoryRecordSchema,
  OrchestratorMemoryRecordSchema,
  PolicyMemoryRecordSchema,
]);

export const TeamMemoryManifestEntrySchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 2_048 }),
  kind: Type.Union([
    Type.Literal("agent_identity"),
    Type.Literal("memory_record"),
    Type.Literal("history_event"),
    Type.Literal("candidate_decision"),
    Type.Literal("ignore_rules"),
  ]),
  sha256: Type.String(SHA256),
  bytes: Type.Integer({ minimum: 0, maximum: 262_144 }),
}, { additionalProperties: false });

export const TeamMemoryCanonicalMapSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 512 }),
  sha256: Type.String(SHA256),
  bytes: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

/**
 * Whether the installation that produced this memory was ever promoted. An
 * installation that refused to activate still has to build its analysis, which
 * requires active identities, so the honest signal is recorded here rather than
 * by mislabelling the identities the analysis was built with.
 */
export const TeamMemoryActivationSchema = Type.Object({
  state: Type.Union([Type.Literal("promoted"), Type.Literal("analysis_only")]),
  disposition: Type.String({ minLength: 1, maxLength: 64 }),
  promoted_at: Type.Union([MemoryTimestampSchema, Type.Null()]),
}, { additionalProperties: false });

export const TeamMemoryManifestSchema = Type.Object({
  format: Type.Literal(TEAM_MEMORY_MANIFEST_TYPE),
  schema_version: Type.Literal("1"),
  revision: Type.Integer({ minimum: 1 }),
  root: Type.Literal(".agentify"),
  repository_id: Type.String({ minLength: 1, maxLength: 512 }),
  created_at: MemoryTimestampSchema,
  updated_at: MemoryTimestampSchema,
  entries: Type.Array(TeamMemoryManifestEntrySchema, {
    minItems: 0,
    maxItems: TEAM_MEMORY_MAX_MANIFEST_ENTRIES,
  }),
  root_digest: Type.String(SHA256),
  canonical_map: Type.Optional(Type.Union([TeamMemoryCanonicalMapSchema, Type.Null()])),
  installation_report: Type.Optional(Type.Union([TeamMemoryCanonicalMapSchema, Type.Null()])),
  activation: Type.Optional(TeamMemoryActivationSchema),
}, { additionalProperties: false });

export const TeamMemoryInitializationJournalSchema = Type.Object({
  format: Type.Literal("agentify_team_memory_initialization"),
  schema_version: Type.Literal("1"),
  repository_id: Type.String({ minLength: 1, maxLength: 512 }),
  supporting_commit: Type.String(GIT_COMMIT),
  evidence: Type.Array(EvidenceReferenceSchema, { minItems: 1, maxItems: 128 }),
  actor: Type.String({ minLength: 1, maxLength: 256 }),
  created_at: MemoryTimestampSchema,
  journal_digest: Type.String(SHA256),
}, {
  additionalProperties: false,
  description: "Recoverable journal for first-time persistent team-memory initialization.",
});

export const MemoryMutationOperationSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("update"),
  Type.Literal("accept"),
  Type.Literal("merge_evidence"),
  Type.Literal("mark_stale"),
  Type.Literal("revalidate"),
  Type.Literal("supersede"),
  Type.Literal("invalidate"),
  Type.Literal("compact"),
]);

export const MemoryMutationEventSchema = Type.Object({
  schema_version: Type.Literal("1"),
  event_type: Type.Literal("entity_mutation"),
  entity_type: Type.Union([Type.Literal("agent_identity"), Type.Literal("memory_record")]),
  entity_id: Type.String(SAFE_ID),
  revision: Type.Integer({ minimum: 1 }),
  operation: MemoryMutationOperationSchema,
  actor: Type.String({ minLength: 1, maxLength: 256 }),
  reason: Type.String(NON_EMPTY_TEXT),
  occurred_at: MemoryTimestampSchema,
  before_digest: Type.Union([Type.String(SHA256), Type.Null()]),
  after_digest: Type.String(SHA256),
  after: Type.Union([AgentIdentitySchema, MemoryRecordSchema]),
  event_digest: Type.String(SHA256),
}, { additionalProperties: false });

export const CandidateDecisionEventSchema = Type.Object({
  schema_version: Type.Literal("1"),
  event_type: Type.Literal("candidate_decision"),
  candidate_id: Type.String(SAFE_ID),
  memory_id: Type.String(SAFE_ID),
  candidate: MemoryCandidateSchema,
  decision: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]),
  actor: Type.String({ minLength: 1, maxLength: 256 }),
  reason: Type.String(NON_EMPTY_TEXT),
  occurred_at: MemoryTimestampSchema,
  candidate_digest: Type.String(SHA256),
  resulting_memory_id: Type.Union([Type.String(SAFE_ID), Type.Null()]),
  event_digest: Type.String(SHA256),
}, { additionalProperties: false });

export type MemorySourceType = Static<typeof MemorySourceTypeSchema>;
export type MemoryConfidence = Static<typeof MemoryConfidenceSchema>;
export type MemoryFreshness = Static<typeof MemoryFreshnessSchema>;
export type MemoryKind = Static<typeof MemoryKindSchema>;
export type AgentRole = Static<typeof AgentRoleSchema>;
export type EvidenceReference = Static<typeof EvidenceReferenceSchema>;
export type HumanAttribution = Static<typeof HumanAttributionSchema>;
export type AgentIdentity = Static<typeof AgentIdentitySchema>;
export type CodebaseMemoryPayload = Static<typeof CodebaseMemoryPayloadSchema>;
export type ProcedureMemoryPayload = Static<typeof ProcedureMemoryPayloadSchema>;
export type EpisodeMemoryPayload = Static<typeof EpisodeMemoryPayloadSchema>;
export type SpecialistMemoryPayload = Static<typeof SpecialistMemoryPayloadSchema>;
export type OrchestratorMemoryPayload = Static<typeof OrchestratorMemoryPayloadSchema>;
export type PolicyMemoryPayload = Static<typeof PolicyMemoryPayloadSchema>;
export type MemoryCandidate = Static<typeof MemoryCandidateSchema>;
export type MemoryRecord = Static<typeof MemoryRecordSchema>;
export type TeamMemoryActivation = Static<typeof TeamMemoryActivationSchema>;
export type TeamMemoryCanonicalMap = Static<typeof TeamMemoryCanonicalMapSchema>;
export type TeamMemoryManifestEntry = Static<typeof TeamMemoryManifestEntrySchema>;
export type TeamMemoryManifest = Static<typeof TeamMemoryManifestSchema>;
export type TeamMemoryInitializationJournal = Static<typeof TeamMemoryInitializationJournalSchema>;
export type MemoryMutationOperation = Static<typeof MemoryMutationOperationSchema>;
export type MemoryMutationEvent = Static<typeof MemoryMutationEventSchema>;
export type CandidateDecisionEvent = Static<typeof CandidateDecisionEventSchema>;

export type MemoryCandidateDraft =
  | Omit<Static<typeof CodebaseMemoryCandidateSchema>, "candidate_digest">
  | Omit<Static<typeof ProcedureMemoryCandidateSchema>, "candidate_digest">
  | Omit<Static<typeof EpisodeMemoryCandidateSchema>, "candidate_digest">
  | Omit<Static<typeof SpecialistMemoryCandidateSchema>, "candidate_digest">
  | Omit<Static<typeof OrchestratorMemoryCandidateSchema>, "candidate_digest">
  | Omit<Static<typeof PolicyMemoryCandidateSchema>, "candidate_digest">;
