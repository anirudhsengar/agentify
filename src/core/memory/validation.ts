import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
  AgentIdentitySchema,
  MemoryMutationEventSchema,
  MemoryRecordSchema,
  type AgentIdentity,
  type AgentRole,
  type CandidateDecisionEvent,
  type EvidenceReference,
  type MemoryCandidate,
  type MemoryConfidence,
  type MemoryKind,
  type MemoryMutationEvent,
  type MemoryMutationOperation,
  type MemoryRecord,
} from "./schema.ts";
import { agentIdentityRelativePath, validateMemoryId } from "./paths.ts";
import {
  assertNoPersistedSecrets,
  canonicalJson,
  contentDigestForIdentity,
  contentDigestForRecord,
  createMemoryCandidateValue,
  digestCanonical,
  normalizeEvidence,
  semanticDigestForCandidate,
  semanticDigestForRecord,
  sortedUniqueStrings,
} from "./serialization.ts";
import {
  TeamMemoryError,
  type MemoryStoreOptions,
} from "./contracts.ts";

export function nowIso(options?: MemoryStoreOptions): string {
  return (options?.now ?? (() => new Date()))().toISOString();
}

export function schemaErrors(schema: TSchema, value: unknown): string {
  return [...Value.Errors(schema, value)]
    .slice(0, 12)
    .map((error) => {
      const detail = error as { path?: string; instancePath?: string; message: string };
      return `${detail.path || detail.instancePath || "(root)"}: ${detail.message}`;
    })
    .join("; ");
}

export function validateSchema<T>(schema: TSchema, value: unknown, label: string): T {
  if (!Value.Check(schema, value)) {
    throw new TeamMemoryError(
      "invalid_input",
      `${label} failed schema validation: ${schemaErrors(schema, value)}`,
    );
  }
  return value as T;
}

export function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TeamMemoryError("invalid_input", `${label} cannot be empty`);
  return normalized;
}

export function assertTimestampOrder(createdAt: string, updatedAt: string, label: string): void {
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new TeamMemoryError("corrupt_state", `${label} updated_at precedes created_at`);
  }
}

export function assertEvidenceSemantics(evidence: ReadonlyArray<EvidenceReference>, label: string): void {
  for (const entry of evidence) {
    const hasRepositoryPath = entry.repository_path !== null;
    const hasExternalReference = entry.external_ref !== null;
    if (!hasRepositoryPath && !hasExternalReference) {
      throw new TeamMemoryError(
        "invalid_input",
        `${label} evidence ${entry.evidence_id} must identify a repository path or external reference`,
      );
    }
    if (hasRepositoryPath && entry.sha256 === null) {
      throw new TeamMemoryError(
        "invalid_input",
        `${label} repository evidence ${entry.evidence_id} requires a content digest`,
      );
    }
    if (!hasRepositoryPath && (entry.line_start !== null || entry.line_end !== null)) {
      throw new TeamMemoryError(
        "invalid_input",
        `${label} evidence ${entry.evidence_id} cannot use line references without a repository path`,
      );
    }
    if (entry.line_end !== null && entry.line_start === null) {
      throw new TeamMemoryError(
        "invalid_input",
        `${label} evidence ${entry.evidence_id} line_end requires line_start`,
      );
    }
    if (entry.line_start !== null && entry.line_end !== null && entry.line_end < entry.line_start) {
      throw new TeamMemoryError(
        "invalid_input",
        `${label} evidence ${entry.evidence_id} line_end precedes line_start`,
      );
    }
  }
}

const SPECIALIST_MEMORY_KINDS = new Set<MemoryKind>([
  "codebase",
  "procedure",
  "episode",
  "specialist",
]);

export function assertRoleMemoryKinds(
  role: AgentRole,
  memoryKinds: ReadonlyArray<MemoryKind>,
  label: string,
): void {
  if (role !== "specialist") return;
  const forbidden = memoryKinds.filter((kind) => !SPECIALIST_MEMORY_KINDS.has(kind));
  if (forbidden.length > 0) {
    throw new TeamMemoryError(
      "policy_violation",
      `${label} cannot own ${sortedUniqueStrings(forbidden).join(", ")} memory`,
    );
  }
}

export function roleAuthority(role: AgentRole): Pick<AgentIdentity, "read_only" | "write_authority" | "github_write_authority"> {
  switch (role) {
    case "orchestrator":
    case "specialist":
    case "reviewer":
      return { read_only: true, write_authority: "none", github_write_authority: "none" };
    case "builder":
      return { read_only: false, write_authority: "application_task", github_write_authority: "none" };
    case "knowledge_maintainer":
      return { read_only: false, write_authority: "knowledge", github_write_authority: "none" };
  }
}

export function validateIdentitySemantics(identity: AgentIdentity): AgentIdentity {
  const authority = roleAuthority(identity.role);
  agentIdentityRelativePath(identity.role, identity.agent_id);
  assertRoleMemoryKinds(identity.role, identity.memory_kinds, `agent ${identity.agent_id}`);
  assertEvidenceSemantics(identity.evidence, `agent ${identity.agent_id}`);
  if (!identity.evidence.some((entry) => entry.commit_sha === identity.supporting_commit)) {
    throw new TeamMemoryError(
      "corrupt_state",
      `agent ${identity.agent_id} has no evidence for supporting commit ${identity.supporting_commit}`,
    );
  }
  assertTimestampOrder(identity.created_at, identity.updated_at, `agent ${identity.agent_id}`);
  if (
    identity.display_name !== identity.display_name.trim()
    || (identity.domain !== null && identity.domain !== identity.domain.trim())
    || canonicalJson(normalizeEvidence(identity.evidence)) !== canonicalJson(identity.evidence)
    || canonicalJson(sortedUniqueStrings(identity.memory_kinds)) !== canonicalJson(identity.memory_kinds)
  ) {
    throw new TeamMemoryError(
      "corrupt_state",
      `agent identity is not deterministically normalized: ${identity.agent_id}`,
    );
  }
  if (
    identity.read_only !== authority.read_only
    || identity.write_authority !== authority.write_authority
    || identity.github_write_authority !== "none"
  ) {
    throw new TeamMemoryError(
      "policy_violation",
      `agent ${identity.agent_id} authority does not match the immutable ${identity.role} role boundary`,
    );
  }
  if (contentDigestForIdentity(
    (({ content_digest: _digest, ...rest }) => rest)(identity),
  ) !== identity.content_digest) {
    throw new TeamMemoryError("corrupt_state", `agent identity digest mismatch: ${identity.agent_id}`);
  }
  return identity;
}

export function assertMemoryPayloadSemantics(value: MemoryCandidate | MemoryRecord): void {
  switch (value.kind) {
    case "episode": {
      const attempts = value.payload.attempts;
      for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index]!;
        if (attempt.sequence !== index + 1) {
          throw new TeamMemoryError(
            "invalid_input",
            `${value.kind} memory attempts must use contiguous sequence numbers starting at 1`,
          );
        }
        if (attempt.result === "failed" && attempt.failure_category === null) {
          throw new TeamMemoryError(
            "invalid_input",
            `failed episode attempt ${attempt.sequence} requires a failure category`,
          );
        }
      }
      break;
    }
    case "specialist":
      if (value.payload.specialist_id !== value.owning_agent_id) {
        throw new TeamMemoryError(
          "invalid_input",
          `specialist memory owner ${value.owning_agent_id} does not match payload ${value.payload.specialist_id}`,
        );
      }
      break;
    case "orchestrator":
      if (value.owning_agent_id !== "orchestrator") {
        throw new TeamMemoryError(
          "policy_violation",
          "orchestrator memory must be owned by the persistent orchestrator",
        );
      }
      break;
    case "policy":
      if (value.owning_agent_id !== "knowledge-maintainer") {
        throw new TeamMemoryError(
          "policy_violation",
          "policy memory must be owned by the knowledge-maintainer role",
        );
      }
      break;
    case "codebase":
    case "procedure":
      break;
  }
}

export function validateCandidateSemantics(candidate: MemoryCandidate): MemoryCandidate {
  assertEvidenceSemantics(candidate.evidence, `candidate ${candidate.candidate_id}`);
  assertMemoryPayloadSemantics(candidate);
  const recomputed = createMemoryCandidateValue(
    (({ candidate_digest: _digest, ...draft }) => draft)(candidate),
  );
  if (canonicalJson(recomputed) !== canonicalJson(candidate)) {
    throw new TeamMemoryError("invalid_input", `candidate ${candidate.candidate_id} is not normalized or has an invalid digest`);
  }
  if (!candidate.evidence.some((entry) => entry.commit_sha === candidate.supporting_commit)) {
    throw new TeamMemoryError(
      "invalid_input",
      `candidate ${candidate.candidate_id} has no evidence bound to supporting commit ${candidate.supporting_commit}`,
    );
  }
  if (!candidate.evidence.some((entry) => entry.source_type === candidate.source_type)) {
    throw new TeamMemoryError(
      "invalid_input",
      `candidate ${candidate.candidate_id} source type is not represented in its evidence`,
    );
  }
  if (
    (candidate.source_type === "accepted_review_feedback"
      || candidate.source_type === "maintainer_instruction")
    && candidate.human_attribution === null
  ) {
    throw new TeamMemoryError(
      "invalid_input",
      `candidate ${candidate.candidate_id} requires human attribution for ${candidate.source_type}`,
    );
  }
  if (
    candidate.kind === "policy"
    && (
      (candidate.source_type !== "maintainer_instruction"
        && candidate.source_type !== "architecture_decision")
      || candidate.human_attribution === null
    )
  ) {
    throw new TeamMemoryError(
      "policy_violation",
      "policy memory requires attributed maintainer instruction or an architecture decision",
    );
  }
  assertNoPersistedSecrets(candidate);
  return candidate;
}

export function validateRecordSemantics(record: MemoryRecord): MemoryRecord {
  assertEvidenceSemantics(record.evidence, `memory ${record.memory_id}`);
  assertMemoryPayloadSemantics(record);
  assertTimestampOrder(record.created_at, record.updated_at, `memory ${record.memory_id}`);
  if (
    record.statement !== record.statement.trim()
    || canonicalJson(normalizeEvidence(record.evidence)) !== canonicalJson(record.evidence)
    || canonicalJson(sortedUniqueStrings(record.dependent_paths)) !== canonicalJson(record.dependent_paths)
    || canonicalJson(sortedUniqueStrings(record.invalidation_conditions)) !== canonicalJson(record.invalidation_conditions)
    || canonicalJson(sortedUniqueStrings(record.contradicts)) !== canonicalJson(record.contradicts)
    || canonicalJson(sortedUniqueStrings(record.tags)) !== canonicalJson(record.tags)
  ) {
    throw new TeamMemoryError(
      "corrupt_state",
      `memory record is not deterministically normalized: ${record.memory_id}`,
    );
  }
  if (canonicalJson(sortedUniqueStrings(record.accepted_candidate_ids)) !== canonicalJson(record.accepted_candidate_ids)) {
    throw new TeamMemoryError(
      "corrupt_state",
      `memory ${record.memory_id} accepted candidate IDs are not normalized`,
    );
  }
  if (semanticDigestForRecord(record) !== record.semantic_digest) {
    throw new TeamMemoryError(
      "corrupt_state",
      `memory semantic digest mismatch: ${record.memory_id}`,
    );
  }
  const { content_digest: _digest, ...withoutDigest } = record;
  if (contentDigestForRecord(withoutDigest) !== record.content_digest) {
    throw new TeamMemoryError("corrupt_state", `memory record digest mismatch: ${record.memory_id}`);
  }
  if (!record.evidence.some((entry) => entry.commit_sha === record.supporting_commit)) {
    throw new TeamMemoryError(
      "corrupt_state",
      `memory ${record.memory_id} has no evidence for supporting commit ${record.supporting_commit}`,
    );
  }
  if (!record.evidence.some((entry) => entry.source_type === record.source_type)) {
    throw new TeamMemoryError(
      "corrupt_state",
      `memory ${record.memory_id} source type is not represented in its evidence`,
    );
  }
  if (
    (record.source_type === "accepted_review_feedback"
      || record.source_type === "maintainer_instruction")
    && record.human_attribution === null
  ) {
    throw new TeamMemoryError(
      "corrupt_state",
      `memory ${record.memory_id} requires human attribution for ${record.source_type}`,
    );
  }
  if (record.freshness === "superseded" && record.superseded_by === null) {
    throw new TeamMemoryError("corrupt_state", `superseded memory ${record.memory_id} has no replacement`);
  }
  if (record.freshness !== "superseded" && record.superseded_by !== null) {
    throw new TeamMemoryError("corrupt_state", `active memory ${record.memory_id} unexpectedly names a replacement`);
  }
  if (
    record.kind === "policy"
    && (
      (record.source_type !== "maintainer_instruction"
        && record.source_type !== "architecture_decision")
      || record.human_attribution === null
    )
  ) {
    throw new TeamMemoryError("policy_violation", `policy memory ${record.memory_id} is not maintainer-authorized`);
  }
  assertNoPersistedSecrets(record);
  return record;
}

export function validateMutationEvent(event: MemoryMutationEvent): MemoryMutationEvent {
  const { event_digest: _eventDigest, ...withoutDigest } = event;
  if (digestCanonical(withoutDigest) !== event.event_digest) {
    throw new TeamMemoryError("corrupt_state", `memory event digest mismatch: ${event.entity_id}@${event.revision}`);
  }
  if ("agent_id" in event.after) {
    if (event.entity_type !== "agent_identity" || event.entity_id !== event.after.agent_id) {
      throw new TeamMemoryError(
        "corrupt_state",
        `memory event identity binding does not match its snapshot: ${event.entity_id}@${event.revision}`,
      );
    }
    validateIdentitySemantics(event.after);
  } else {
    if (event.entity_type !== "memory_record" || event.entity_id !== event.after.memory_id) {
      throw new TeamMemoryError(
        "corrupt_state",
        `memory event record binding does not match its snapshot: ${event.entity_id}@${event.revision}`,
      );
    }
    validateRecordSemantics(event.after);
  }
  if (event.revision !== event.after.revision || event.after_digest !== event.after.content_digest) {
    throw new TeamMemoryError("corrupt_state", `memory event revision or digest does not match its snapshot`);
  }
  return event;
}

export function validateDecisionEvent(event: CandidateDecisionEvent): CandidateDecisionEvent {
  const { event_digest: _eventDigest, ...withoutDigest } = event;
  if (digestCanonical(withoutDigest) !== event.event_digest) {
    throw new TeamMemoryError("corrupt_state", `candidate decision digest mismatch: ${event.candidate_id}`);
  }
  validateCandidateSemantics(event.candidate);
  if (
    event.candidate_id !== event.candidate.candidate_id
    || event.memory_id !== event.candidate.memory_id
    || event.candidate_digest !== event.candidate.candidate_digest
  ) {
    throw new TeamMemoryError(
      "corrupt_state",
      `candidate decision does not match its retained candidate snapshot: ${event.candidate_id}`,
    );
  }
  if (event.decision === "accepted" && event.resulting_memory_id === null) {
    throw new TeamMemoryError(
      "corrupt_state",
      `accepted candidate ${event.candidate_id} does not identify resulting memory`,
    );
  }
  if (event.decision === "rejected" && event.resulting_memory_id !== null) {
    throw new TeamMemoryError(
      "corrupt_state",
      `rejected candidate ${event.candidate_id} unexpectedly identifies resulting memory`,
    );
  }
  return event;
}

interface NewAgentIdentityDefinition {
  agentId: string;
  role: AgentRole;
  displayName: string;
  domain?: string | null;
  memoryKinds: ReadonlyArray<MemoryKind>;
  supportingCommit: string;
  evidence: ReadonlyArray<EvidenceReference>;
}

export function makeIdentity(
  input: NewAgentIdentityDefinition,
  timestamp: string,
): AgentIdentity {
  validateMemoryId(input.agentId, "agent ID");
  const authority = roleAuthority(input.role);
  const withoutDigest: Omit<AgentIdentity, "content_digest"> = {
    schema_version: "1",
    agent_id: input.agentId,
    revision: 1,
    role: input.role,
    display_name: input.displayName.trim(),
    domain: input.domain?.trim() || null,
    status: "active",
    ...authority,
    memory_kinds: sortedUniqueStrings(input.memoryKinds) as MemoryKind[],
    supporting_commit: input.supportingCommit,
    evidence: normalizeEvidence(input.evidence),
    created_at: timestamp,
    updated_at: timestamp,
  };
  const identity: AgentIdentity = {
    ...withoutDigest,
    content_digest: contentDigestForIdentity(withoutDigest),
  };
  validateSchema<AgentIdentity>(AgentIdentitySchema, identity, "agent identity");
  return validateIdentitySemantics(identity);
}

export function makeMutationEvent(
  entityType: "agent_identity" | "memory_record",
  after: AgentIdentity | MemoryRecord,
  operation: MemoryMutationOperation,
  actor: string,
  reason: string,
  occurredAt: string,
  beforeDigest: string | null,
): MemoryMutationEvent {
  const normalizedActor = assertNonEmpty(actor, "memory mutation actor");
  const normalizedReason = assertNonEmpty(reason, "memory mutation reason");
  const withoutDigest: Omit<MemoryMutationEvent, "event_digest"> = {
    schema_version: "1",
    event_type: "entity_mutation",
    entity_type: entityType,
    entity_id: "agent_id" in after ? after.agent_id : after.memory_id,
    revision: after.revision,
    operation,
    actor: normalizedActor,
    reason: normalizedReason,
    occurred_at: occurredAt,
    before_digest: beforeDigest,
    after_digest: after.content_digest,
    after,
  };
  const event: MemoryMutationEvent = {
    ...withoutDigest,
    event_digest: digestCanonical(withoutDigest),
  };
  validateSchema<MemoryMutationEvent>(MemoryMutationEventSchema, event, "memory mutation event");
  return validateMutationEvent(event);
}

export function confidenceRank(value: MemoryConfidence): number {
  switch (value) {
    case "low": return 0;
    case "medium": return 1;
    case "high": return 2;
    case "verified": return 3;
  }
}

export function assertCandidateMaterializedInRecord(
  candidate: MemoryCandidate,
  record: MemoryRecord,
): void {
  if (record.semantic_digest !== semanticDigestForCandidate(candidate)) {
    throw new TeamMemoryError(
      "corrupt_state",
      `accepted candidate ${candidate.candidate_id} does not match memory ${record.memory_id} semantics`,
    );
  }
  if (!record.accepted_candidate_ids.includes(candidate.candidate_id)) {
    throw new TeamMemoryError(
      "corrupt_state",
      `memory ${record.memory_id} does not retain accepted candidate ${candidate.candidate_id}`,
    );
  }
  if (confidenceRank(record.confidence) < confidenceRank(candidate.confidence)) {
    throw new TeamMemoryError(
      "corrupt_state",
      `memory ${record.memory_id} weakens candidate ${candidate.candidate_id} confidence`,
    );
  }

  const recordEvidence = new Map(
    record.evidence.map((entry) => [entry.evidence_id, canonicalJson(entry)] as const),
  );
  for (const entry of candidate.evidence) {
    if (recordEvidence.get(entry.evidence_id) !== canonicalJson(entry)) {
      throw new TeamMemoryError(
        "corrupt_state",
        `memory ${record.memory_id} does not retain evidence ${entry.evidence_id} from candidate ${candidate.candidate_id}`,
      );
    }
  }
  for (const condition of candidate.invalidation_conditions) {
    if (!record.invalidation_conditions.includes(condition)) {
      throw new TeamMemoryError(
        "corrupt_state",
        `memory ${record.memory_id} drops an invalidation condition from candidate ${candidate.candidate_id}`,
      );
    }
  }
  for (const contradiction of candidate.contradicts) {
    if (!record.contradicts.includes(contradiction)) {
      throw new TeamMemoryError(
        "corrupt_state",
        `memory ${record.memory_id} drops contradiction ${contradiction} from candidate ${candidate.candidate_id}`,
      );
    }
  }
}

export function recordFromCandidate(
  candidate: MemoryCandidate,
  timestamp: string,
): MemoryRecord {
  const withoutDigest = {
    schema_version: "1" as const,
    memory_id: candidate.memory_id,
    revision: 1,
    kind: candidate.kind,
    owning_agent_id: candidate.owning_agent_id,
    statement: candidate.statement,
    source_type: candidate.source_type,
    supporting_commit: candidate.supporting_commit,
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    freshness: "current" as const,
    dependent_paths: candidate.dependent_paths,
    invalidation_conditions: candidate.invalidation_conditions,
    superseded_by: null,
    contradicts: candidate.contradicts,
    human_attribution: candidate.human_attribution,
    tags: candidate.tags,
    accepted_candidate_ids: [candidate.candidate_id],
    created_at: timestamp,
    updated_at: timestamp,
    semantic_digest: semanticDigestForCandidate(candidate),
    payload: candidate.payload,
  };
  const record = {
    ...withoutDigest,
    content_digest: contentDigestForRecord(withoutDigest as Omit<MemoryRecord, "content_digest">),
  } as MemoryRecord;
  validateSchema<MemoryRecord>(MemoryRecordSchema, record, "memory record");
  return validateRecordSemantics(record);
}

export function updatedRecord(
  current: MemoryRecord,
  patch: Partial<Omit<MemoryRecord, "schema_version" | "memory_id" | "revision" | "kind" | "created_at" | "content_digest">>,
  timestamp: string,
): MemoryRecord {
  const withoutDigest = {
    ...current,
    ...patch,
    revision: current.revision + 1,
    updated_at: timestamp,
  };
  const { content_digest: _oldDigest, ...digestInput } = withoutDigest;
  const next = {
    ...digestInput,
    content_digest: contentDigestForRecord(digestInput),
  } as MemoryRecord;
  validateSchema<MemoryRecord>(MemoryRecordSchema, next, "memory record");
  return validateRecordSemantics(next);
}

export function assertExpectedRevision(record: MemoryRecord, expectedRevision: number): void {
  if (record.revision !== expectedRevision) {
    throw new TeamMemoryError(
      "revision_conflict",
      `memory ${record.memory_id} revision conflict: expected ${expectedRevision}, found ${record.revision}`,
    );
  }
}
