import {
  type MemoryStoreOptions,
  TeamMemoryError,
} from "../contracts.ts";
import {
  runtimeCandidateRelativePath,
} from "../paths.ts";
import {
  acquireStoreLock,
  assertCandidateAcceptanceCapacity,
  directoryEntriesIfPresent,
  MAX_PENDING_CANDIDATES,
  persistVersionedEntityInternal,
  readCandidateDecisionIfPresent,
  readRelativeJson,
  readTeamMemoryManifest,
  refreshManifestInternal,
  removeRuntimeCandidate,
  writeCandidateDecisionInternal,
  writeJsonImmutable,
} from "../persistence.ts";
import {
  validateEvidenceProvenance,
} from "../provenance.ts";
import {
  type CandidateDecisionEvent,
  type MemoryCandidate,
  type MemoryCandidateDraft,
  MemoryCandidateSchema,
  type MemoryRecord,
} from "../schema.ts";
import {
  canonicalJson,
  createMemoryCandidateValue,
  normalizeEvidence,
  semanticDigestForCandidate,
  sortedUniqueStrings,
} from "../serialization.ts";
import {
  assertCandidateMaterializedInRecord,
  confidenceRank,
  nowIso,
  recordFromCandidate,
  updatedRecord,
  validateCandidateSemantics,
  validateSchema,
} from "../validation.ts";
import {
  assertKnowledgeMaintainerAuthority,
  readAgentIdentity,
} from "./identities.ts";
import {
  assertRecordCapacity,
  listMemoryRecordsInternal,
  readMemoryRecord,
} from "./records.ts";
import {
  assertInitializedForMutation,
} from "./shared.ts";

export function assertCandidateAgentBindings(cwd: string, candidate: MemoryCandidate): void {
  const proposer = readAgentIdentity(cwd, candidate.proposed_by_agent_id);
  const owner = readAgentIdentity(cwd, candidate.owning_agent_id);
  if (proposer.status !== "active") {
    throw new TeamMemoryError(
      "policy_violation",
      `retired agent ${proposer.agent_id} cannot propose durable memory`,
    );
  }
  if (owner.status !== "active") {
    throw new TeamMemoryError(
      "policy_violation",
      `retired agent ${owner.agent_id} cannot own new durable memory`,
    );
  }
  if (!owner.memory_kinds.includes(candidate.kind)) {
    throw new TeamMemoryError(
      "policy_violation",
      `agent ${owner.agent_id} is not allowed to own ${candidate.kind} memory`,
    );
  }
  if (candidate.kind === "policy" && proposer.role !== "knowledge_maintainer") {
    throw new TeamMemoryError(
      "policy_violation",
      "policy memory may be proposed only through the knowledge-maintainer role",
    );
  }
}

export function proposeMemoryCandidate(input: MemoryCandidateDraft): MemoryCandidate {
  const candidate = createMemoryCandidateValue(input);
  validateSchema<MemoryCandidate>(MemoryCandidateSchema, candidate, "memory candidate");
  return validateCandidateSemantics(candidate);
}

export function ensureRuntimeCandidateInternal(
  cwd: string,
  candidate: MemoryCandidate,
): MemoryCandidate {
  const relativePath = runtimeCandidateRelativePath(candidate.candidate_id);
  try {
    const existing = readPersistedMemoryCandidate(cwd, candidate.candidate_id);
    if (canonicalJson(existing) === canonicalJson(candidate)) return existing;
    throw new TeamMemoryError(
      "already_exists",
      `candidate ID already exists with different content: ${candidate.candidate_id}`,
    );
  } catch (error) {
    if (!(error instanceof TeamMemoryError) || error.code !== "not_found") throw error;
  }
  const pending = directoryEntriesIfPresent(cwd, ".agentify/runtime/candidates");
  if (pending.length >= MAX_PENDING_CANDIDATES) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `team memory already contains the maximum ${MAX_PENDING_CANDIDATES} pending candidates`,
    );
  }
  writeJsonImmutable(cwd, relativePath, candidate);
  return candidate;
}

export function persistMemoryCandidate(
  cwd: string,
  draft: MemoryCandidateDraft,
  options?: MemoryStoreOptions,
): MemoryCandidate {
  const candidate = proposeMemoryCandidate(draft);
  assertInitializedForMutation(cwd);
  return acquireStoreLock(cwd, options, () => {
    readTeamMemoryManifest(cwd);
    assertCandidateAgentBindings(cwd, candidate);
    validateEvidenceProvenance(cwd, candidate.evidence, options);
    const decision = readCandidateDecisionIfPresent(cwd, candidate.candidate_id);
    if (decision) {
      throw new TeamMemoryError(
        "already_exists",
        `candidate ${candidate.candidate_id} already has a durable ${decision.decision} decision`,
      );
    }
    return ensureRuntimeCandidateInternal(cwd, candidate);
  });
}

export function readPersistedMemoryCandidate(cwd: string, candidateId: string): MemoryCandidate {
  const parsed = readRelativeJson(cwd, runtimeCandidateRelativePath(candidateId));
  return validateCandidateSemantics(
    validateSchema<MemoryCandidate>(MemoryCandidateSchema, parsed, "memory candidate"),
  );
}

export function acceptMemoryCandidate(
  cwd: string,
  input: MemoryCandidate | string,
  actor: string,
  reason: string,
  options?: MemoryStoreOptions,
): MemoryRecord {
  assertInitializedForMutation(cwd);
  return acquireStoreLock(cwd, options, () => {
    readTeamMemoryManifest(cwd);
    const decisionActor = assertKnowledgeMaintainerAuthority(cwd, actor);
    const candidate = typeof input === "string"
      ? readPersistedMemoryCandidate(cwd, input)
      : validateCandidateSemantics(
          validateSchema<MemoryCandidate>(MemoryCandidateSchema, input, "memory candidate"),
        );
    assertCandidateAgentBindings(cwd, candidate);
    validateEvidenceProvenance(cwd, candidate.evidence, options);
    const priorDecision = readCandidateDecisionIfPresent(cwd, candidate.candidate_id);
    if (priorDecision) {
      if (priorDecision.candidate_digest !== candidate.candidate_digest) {
        throw new TeamMemoryError(
          "corrupt_state",
          `candidate ${candidate.candidate_id} decision refers to different content`,
        );
      }
      removeRuntimeCandidate(cwd, candidate.candidate_id);
      if (priorDecision.decision === "rejected") {
        throw new TeamMemoryError(
          "policy_violation",
          `candidate ${candidate.candidate_id} was already rejected`,
        );
      }
      const record = readMemoryRecord(cwd, priorDecision.resulting_memory_id!);
      assertCandidateMaterializedInRecord(priorDecision.candidate, record);
      return record;
    }
    ensureRuntimeCandidateInternal(cwd, candidate);
    const timestamp = nowIso(options);
    const alreadyApplied = listMemoryRecordsInternal(cwd)
      .find((record) => record.accepted_candidate_ids.includes(candidate.candidate_id));
    if (alreadyApplied) {
      writeCandidateDecisionInternal(
        cwd,
        candidate,
        "accepted",
        decisionActor,
        `recovered prior acceptance: ${reason}`,
        alreadyApplied.memory_id,
        timestamp,
      );
      removeRuntimeCandidate(cwd, candidate.candidate_id);
      refreshManifestInternal(cwd, options);
      return alreadyApplied;
    }
    const semanticDigest = semanticDigestForCandidate(candidate);
    const duplicate = listMemoryRecordsInternal(cwd)
      .find((record) => record.semantic_digest === semanticDigest && record.freshness === "current");
    if (duplicate) {
      const mergedEvidence = normalizeEvidence([...duplicate.evidence, ...candidate.evidence]);
      const next = updatedRecord(duplicate, {
        evidence: mergedEvidence,
        confidence: confidenceRank(candidate.confidence) > confidenceRank(duplicate.confidence)
          ? candidate.confidence
          : duplicate.confidence,
        supporting_commit: candidate.supporting_commit,
        accepted_candidate_ids: sortedUniqueStrings([
          ...duplicate.accepted_candidate_ids,
          candidate.candidate_id,
        ]),
        invalidation_conditions: sortedUniqueStrings([
          ...duplicate.invalidation_conditions,
          ...candidate.invalidation_conditions,
        ]),
        contradicts: sortedUniqueStrings([
          ...duplicate.contradicts,
          ...candidate.contradicts,
        ]),
      }, timestamp);
      assertCandidateAcceptanceCapacity(
        cwd,
        next,
        "merge_evidence",
        decisionActor,
        reason,
        timestamp,
        duplicate.content_digest,
        candidate,
        options,
      );
      persistVersionedEntityInternal(
        cwd,
        next,
        "merge_evidence",
        decisionActor,
        reason,
        timestamp,
        duplicate.content_digest,
        options,
      );
      writeCandidateDecisionInternal(
        cwd,
        candidate,
        "accepted",
        decisionActor,
        reason,
        duplicate.memory_id,
        timestamp,
      );
      removeRuntimeCandidate(cwd, candidate.candidate_id);
      refreshManifestInternal(cwd, options);
      return next;
    }

    try {
      readMemoryRecord(cwd, candidate.memory_id);
      throw new TeamMemoryError(
        "already_exists",
        `memory ID already exists with different semantics: ${candidate.memory_id}`,
      );
    } catch (error) {
      if (!(error instanceof TeamMemoryError) || error.code !== "not_found") throw error;
    }
    assertRecordCapacity(cwd);
    const record = recordFromCandidate(candidate, timestamp);
    assertCandidateAcceptanceCapacity(
      cwd,
      record,
      "accept",
      decisionActor,
      reason,
      timestamp,
      null,
      candidate,
      options,
    );
    persistVersionedEntityInternal(
      cwd,
      record,
      "accept",
      decisionActor,
      reason,
      timestamp,
      null,
      options,
    );
    writeCandidateDecisionInternal(
      cwd,
      candidate,
      "accepted",
      decisionActor,
      reason,
      record.memory_id,
      timestamp,
    );
    removeRuntimeCandidate(cwd, candidate.candidate_id);
    refreshManifestInternal(cwd, options);
    return record;
  });
}

export function rejectMemoryCandidate(
  cwd: string,
  input: MemoryCandidate | string,
  actor: string,
  reason: string,
  options?: MemoryStoreOptions,
): CandidateDecisionEvent {
  assertInitializedForMutation(cwd);
  return acquireStoreLock(cwd, options, () => {
    readTeamMemoryManifest(cwd);
    const decisionActor = assertKnowledgeMaintainerAuthority(cwd, actor);
    const candidate = typeof input === "string"
      ? readPersistedMemoryCandidate(cwd, input)
      : validateCandidateSemantics(
          validateSchema<MemoryCandidate>(MemoryCandidateSchema, input, "memory candidate"),
        );
    assertCandidateAgentBindings(cwd, candidate);
    validateEvidenceProvenance(cwd, candidate.evidence, options);
    const priorDecision = readCandidateDecisionIfPresent(cwd, candidate.candidate_id);
    if (priorDecision) {
      if (priorDecision.candidate_digest !== candidate.candidate_digest) {
        throw new TeamMemoryError(
          "corrupt_state",
          `candidate ${candidate.candidate_id} decision refers to different content`,
        );
      }
      removeRuntimeCandidate(cwd, candidate.candidate_id);
      if (priorDecision.decision === "accepted") {
        throw new TeamMemoryError(
          "policy_violation",
          `candidate ${candidate.candidate_id} was already accepted`,
        );
      }
      return priorDecision;
    }
    ensureRuntimeCandidateInternal(cwd, candidate);
    const alreadyApplied = listMemoryRecordsInternal(cwd)
      .find((record) => record.accepted_candidate_ids.includes(candidate.candidate_id));
    if (alreadyApplied) {
      throw new TeamMemoryError(
        "policy_violation",
        `candidate ${candidate.candidate_id} is already present in memory ${alreadyApplied.memory_id}`,
      );
    }
    const timestamp = nowIso(options);
    const decision = writeCandidateDecisionInternal(
      cwd, candidate, "rejected", decisionActor, reason, null, timestamp,
    );
    removeRuntimeCandidate(cwd, candidate.candidate_id);
    refreshManifestInternal(cwd, options);
    return decision;
  });
}
