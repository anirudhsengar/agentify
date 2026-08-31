import {
  acceptMemoryCandidate,
  createAgentIdentity,
  listAgentIdentities,
  listMemoryRecords,
  markMemoryStale,
  proposeMemoryCandidate,
  readAgentIdentity,
  readMemoryRecord,
  supersedeMemory,
  updateAgentIdentity,
} from "../memory/index.ts";
import {
  TeamMemoryError,
} from "../memory/contracts.ts";
import type {
  AgentIdentity,
  EvidenceReference,
  MemoryCandidateDraft,
  MemoryRecord,
} from "../memory/schema.ts";
import {
  canonicalJson,
  digestCanonical,
  sortedUniqueStrings,
} from "../memory/serialization.ts";
import {
  type MaterializedPortfolioResult,
  type MaterializeSpecialistPortfolioInput,
  type ProcedureDefinition,
  type SpecialistDefinition,
} from "./contracts.ts";
import {
  buildSpecialistEvidenceReference,
  readGitCommitTimestamp,
} from "./evidence.ts";
import { specialistSlug } from "./discovery.ts";
import { validateSpecialistPortfolio } from "./validation.ts";

const SPECIALIST_MEMORY_KINDS = [
  "codebase",
  "procedure",
  "episode",
  "specialist",
] as const;

function notFound(error: unknown): boolean {
  return error instanceof TeamMemoryError && error.code === "not_found";
}

function readIdentityOrNull(cwd: string, agentId: string): AgentIdentity | null {
  try {
    return readAgentIdentity(cwd, agentId);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

function stableMemoryId(prefix: string, stableId: string, value: unknown): string {
  const slug = specialistSlug(stableId).slice(0, 72);
  return `${prefix}-${slug}-${digestCanonical(value).slice(0, 16)}`.slice(0, 128);
}

function candidateId(value: unknown): string {
  return `candidate-${digestCanonical(value).slice(0, 32)}`;
}

function unretiredDraft(cwd: string, input: MemoryCandidateDraft): MemoryCandidateDraft {
  let draft = input;
  for (;;) {
    let existing: MemoryRecord;
    try { existing = readMemoryRecord(cwd, draft.memory_id); } catch (error) {
      if (notFound(error)) return draft;
      throw error;
    }
    if (existing.freshness === "current") return draft;
    // Returning to an earlier portfolio/command posture is new acceptance,
    // not resurrection of a superseded decision. Follow deterministic revisions
    // so repeated synchronization still resolves the same current record.
    const { candidate_id: _priorCandidateId, ...body } = draft;
    const next = {
      ...body,
      memory_id: stableMemoryId("renewed", input.memory_id, existing.content_digest),
    };
    draft = { ...next, candidate_id: candidateId(next) };
  }
}

function evidenceIds(evidence: ReadonlyArray<EvidenceReference>): string[] {
  return evidence.map((entry) => entry.evidence_id).sort((left, right) => left.localeCompare(right));
}

function identityMatches(
  identity: AgentIdentity,
  definition: SpecialistDefinition,
  evidence: ReadonlyArray<EvidenceReference>,
  supportingCommit: string,
): boolean {
  const expectedEvidence = new Set(evidenceIds(evidence));
  return identity.status === "active"
    && identity.display_name === definition.display_name
    && identity.domain === definition.concern
    && identity.supporting_commit === supportingCommit
    && canonicalJson(identity.memory_kinds) === canonicalJson([...SPECIALIST_MEMORY_KINDS].sort())
    && [...expectedEvidence].every((id) => identity.evidence.some((entry) => entry.evidence_id === id));
}

function evidenceForPaths(
  input: MaterializeSpecialistPortfolioInput,
  paths: ReadonlyArray<string>,
  observedAt: string,
  cache: Map<string, EvidenceReference>,
): EvidenceReference[] {
  const sourceType = input.source_type ?? "validated_bootstrap";
  const normalizedPaths = sortedUniqueStrings(paths).slice(0, 32);
  if (normalizedPaths.length === 0) {
    throw new TeamMemoryError(
      "invalid_input",
      "specialist or procedure materialization requires at least one concrete evidence path",
    );
  }
  return normalizedPaths.map((repositoryPath) => {
    const cacheKey = `${input.portfolio.supporting_commit}|${sourceType}|${repositoryPath}`;
    const existing = cache.get(cacheKey);
    if (existing) return existing;
    const reference = buildSpecialistEvidenceReference({
      cwd: input.cwd,
      supportingCommit: input.portfolio.supporting_commit,
      repositoryPath,
      sourceType,
      observedAt,
      actor: input.evidence_actor ?? null,
    });
    cache.set(cacheKey, reference);
    return reference;
  });
}

function syncSpecialistIdentity(
  input: MaterializeSpecialistPortfolioInput,
  definition: SpecialistDefinition,
  evidence: ReadonlyArray<EvidenceReference>,
): "created" | "updated" | "unchanged" {
  const existing = readIdentityOrNull(input.cwd, definition.specialist_id);
  if (!existing) {
    createAgentIdentity({
      cwd: input.cwd,
      agentId: definition.specialist_id,
      role: "specialist",
      displayName: definition.display_name,
      domain: definition.concern,
      memoryKinds: SPECIALIST_MEMORY_KINDS,
      supportingCommit: input.portfolio.supporting_commit,
      evidence,
      actor: input.actor,
      options: input.options,
    });
    return "created";
  }
  if (identityMatches(
    existing,
    definition,
    evidence,
    input.portfolio.supporting_commit,
  )) {
    return "unchanged";
  }
  updateAgentIdentity(input.cwd, definition.specialist_id, {
    displayName: definition.display_name,
    domain: definition.concern,
    status: "active",
    supportingCommit: input.portfolio.supporting_commit,
    evidence: [...evidence],
    actor: input.actor,
    reason: `refresh specialist identity from portfolio ${input.portfolio.source_map_digest}`,
    expectedRevision: existing.revision,
    options: input.options,
  });
  return "updated";
}

function specialistDraft(
  input: MaterializeSpecialistPortfolioInput,
  definition: SpecialistDefinition,
  evidence: ReadonlyArray<EvidenceReference>,
  observedAt: string,
): MemoryCandidateDraft {
  const payload = {
    specialist_id: definition.specialist_id,
    concern: definition.concern,
    one_line: definition.one_line,
    covers: definition.covers,
    excludes: definition.excludes,
    flows: definition.flows,
    touchpoints: definition.touchpoints,
    invariants: definition.invariants,
    pitfalls: definition.pitfalls,
    entry_questions: definition.entry_questions,
    context_paths: definition.context_paths,
    related_specialists: definition.related_specialists,
    validation_commands: definition.validation_commands,
  };
  const semanticValue = payload;
  const memoryId = stableMemoryId("specialist-profile", definition.specialist_id, semanticValue);
  const draftWithoutCandidateId = {
    schema_version: "1" as const,
    memory_id: memoryId,
    kind: "specialist" as const,
    proposed_by_agent_id: "orchestrator",
    owning_agent_id: definition.specialist_id,
    statement: definition.one_line,
    source_type: input.source_type ?? "validated_bootstrap",
    supporting_commit: definition.supporting_commit,
    evidence: [...evidence],
    confidence: definition.confidence,
    dependent_paths: definition.freshness_dependencies,
    invalidation_conditions: [
      "Revalidate when any specialist freshness dependency changes or disappears.",
    ],
    contradicts: [],
    human_attribution: null,
    tags: sortedUniqueStrings([
      "specialist-profile",
      `concern-${specialistSlug(definition.concern)}`,
    ]),
    proposed_at: observedAt,
    payload,
  };
  return {
    ...draftWithoutCandidateId,
    candidate_id: candidateId(draftWithoutCandidateId),
  };
}

function procedureDraft(
  input: MaterializeSpecialistPortfolioInput,
  definition: ProcedureDefinition,
  evidence: ReadonlyArray<EvidenceReference>,
  observedAt: string,
): MemoryCandidateDraft {
  const semanticValue = {
    procedure_id: definition.procedure_id,
    purpose: definition.purpose,
    owner_specialist_id: definition.owner_specialist_id,
    trigger_conditions: definition.trigger_conditions,
    required_context_paths: definition.required_context_paths,
    allowed_commands: definition.allowed_commands,
    expected_file_patterns: definition.expected_file_patterns,
    side_effects: definition.side_effects,
    validation_commands: definition.validation_commands,
    recovery_steps: definition.recovery_steps,
  };
  const memoryId = stableMemoryId("procedure", definition.procedure_id, semanticValue);
  const draftWithoutCandidateId = {
    schema_version: "1" as const,
    memory_id: memoryId,
    kind: "procedure" as const,
    proposed_by_agent_id: "orchestrator",
    owning_agent_id: definition.owner_specialist_id ?? "orchestrator",
    statement: definition.purpose,
    source_type: input.source_type ?? "validated_bootstrap",
    supporting_commit: definition.supporting_commit,
    evidence: [...evidence],
    confidence: definition.confidence,
    dependent_paths: definition.freshness_dependencies,
    invalidation_conditions: [
      "Revalidate when a required context path or authoritative validation command changes.",
    ],
    contradicts: [],
    human_attribution: null,
    tags: sortedUniqueStrings([
      "procedure",
      `procedure-${specialistSlug(definition.procedure_id)}`,
    ]),
    proposed_at: observedAt,
    payload: {
      name: specialistSlug(definition.procedure_id),
      trigger_conditions: definition.trigger_conditions,
      required_context_paths: definition.required_context_paths,
      allowed_commands: definition.allowed_commands,
      expected_file_patterns: definition.expected_file_patterns,
      side_effects: definition.side_effects,
      validation_commands: definition.validation_commands,
      recovery_steps: definition.recovery_steps,
    },
  };
  return {
    ...draftWithoutCandidateId,
    candidate_id: candidateId(draftWithoutCandidateId),
  };
}

function supersedePriorCurrentRecords(
  input: MaterializeSpecialistPortfolioInput,
  newRecord: MemoryRecord,
  priorRecords: ReadonlyArray<MemoryRecord>,
  evidence: ReadonlyArray<EvidenceReference>,
): void {
  for (const prior of priorRecords) {
    if (prior.memory_id === newRecord.memory_id || prior.freshness !== "current") continue;
    supersedeMemory(input.cwd, prior.memory_id, newRecord.memory_id, {
      actor: input.actor,
      expectedRevision: prior.revision,
      evidence,
      supportingCommit: input.portfolio.supporting_commit,
      reason: `superseded by portfolio ${input.portfolio.source_map_digest}`,
      options: input.options,
    });
  }
}

function materializeSpecialistMemory(
  input: MaterializeSpecialistPortfolioInput,
  definition: SpecialistDefinition,
  evidence: ReadonlyArray<EvidenceReference>,
  observedAt: string,
): MemoryRecord {
  const prior = listMemoryRecords(input.cwd, {
    kind: "specialist",
    owningAgentId: definition.specialist_id,
    freshness: "current",
  });
  const record = acceptMemoryCandidate(
    input.cwd,
    proposeMemoryCandidate(unretiredDraft(input.cwd, specialistDraft(input, definition, evidence, observedAt))),
    input.actor,
    `accept specialist portfolio ${input.portfolio.source_map_digest}`,
    input.options,
  );
  supersedePriorCurrentRecords(input, record, prior, evidence);
  return record;
}

function materializeProcedureMemory(
  input: MaterializeSpecialistPortfolioInput,
  definition: ProcedureDefinition,
  evidence: ReadonlyArray<EvidenceReference>,
  observedAt: string,
): MemoryRecord {
  const stableTag = `procedure-${specialistSlug(definition.procedure_id)}`;
  const prior = listMemoryRecords(input.cwd, {
    kind: "procedure",
    tag: stableTag,
    freshness: "current",
  });
  const record = acceptMemoryCandidate(
    input.cwd,
    proposeMemoryCandidate(unretiredDraft(input.cwd, procedureDraft(input, definition, evidence, observedAt))),
    input.actor,
    `accept procedure portfolio ${input.portfolio.source_map_digest}`,
    input.options,
  );
  supersedePriorCurrentRecords(input, record, prior, evidence);
  return record;
}

function staleMissingProcedureMemory(
  input: MaterializeSpecialistPortfolioInput,
  activeProcedureIds: ReadonlySet<string>,
  fallbackEvidence: ReadonlyArray<EvidenceReference>,
): string[] {
  if (fallbackEvidence.length === 0) return [];
  const staleIds: string[] = [];
  for (const record of listMemoryRecords(input.cwd, {
    kind: "procedure",
    freshness: "current",
  })) {
    const generatedTag = record.tags.find((tag) => tag.startsWith("procedure-") && tag !== "procedure");
    if (generatedTag === undefined) continue;
    const stableProcedureId = generatedTag.slice("procedure-".length);
    if (activeProcedureIds.has(stableProcedureId)) continue;
    const stale = markMemoryStale(input.cwd, record.memory_id, {
      actor: input.actor,
      expectedRevision: record.revision,
      evidence: fallbackEvidence,
      supportingCommit: input.portfolio.supporting_commit,
      reason: `procedure ${stableProcedureId} is absent from portfolio ${input.portfolio.source_map_digest}`,
      options: input.options,
    });
    staleIds.push(stale.memory_id);
  }
  return staleIds.sort((left, right) => left.localeCompare(right));
}

function retireMissingSpecialists(
  input: MaterializeSpecialistPortfolioInput,
  activeIds: ReadonlySet<string>,
  fallbackEvidence: ReadonlyArray<EvidenceReference>,
): string[] {
  if (fallbackEvidence.length === 0) return [];
  const retired: string[] = [];
  for (const identity of listAgentIdentities(input.cwd)) {
    if (
      identity.role !== "specialist"
      || identity.status !== "active"
      || activeIds.has(identity.agent_id)
    ) {
      continue;
    }
    updateAgentIdentity(input.cwd, identity.agent_id, {
      status: "retired",
      supportingCommit: input.portfolio.supporting_commit,
      evidence: fallbackEvidence,
      actor: input.actor,
      reason: `specialist absent from portfolio ${input.portfolio.source_map_digest}`,
      expectedRevision: identity.revision,
      options: input.options,
    });
    for (const record of listMemoryRecords(input.cwd, {
      owningAgentId: identity.agent_id,
      freshness: "current",
    })) {
      if (record.kind !== "specialist" && record.kind !== "procedure") continue;
      markMemoryStale(input.cwd, record.memory_id, {
        actor: input.actor,
        expectedRevision: record.revision,
        evidence: fallbackEvidence,
        supportingCommit: input.portfolio.supporting_commit,
        reason: `owning specialist ${identity.agent_id} was retired`,
        options: input.options,
      });
    }
    retired.push(identity.agent_id);
  }
  return retired.sort((left, right) => left.localeCompare(right));
}

export function materializeSpecialistPortfolio(
  input: MaterializeSpecialistPortfolioInput,
): MaterializedPortfolioResult {
  validateSpecialistPortfolio(input.portfolio);
  const observedAt = input.observed_at
    ?? readGitCommitTimestamp(input.cwd, input.portfolio.supporting_commit);
  const evidenceCache = new Map<string, EvidenceReference>();
  // Portfolio-level evidence is the provenance attached to retirements. A
  // portfolio with no specialists has none to cite, and that is a legitimate
  // outcome rather than a materialization failure, so resolve it only at the
  // point a retirement actually needs it.
  let portfolioEvidenceMemo: EvidenceReference[] | null = null;
  const portfolioEvidence = (): EvidenceReference[] => {
    portfolioEvidenceMemo ??= input.portfolio.evidence_paths.length === 0
      ? []
      : evidenceForPaths(input, input.portfolio.evidence_paths, observedAt, evidenceCache);
    return portfolioEvidenceMemo;
  };
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const specialistMemory: MemoryRecord[] = [];
  const procedureMemory: MemoryRecord[] = [];

  for (const definition of input.portfolio.specialists) {
    const evidence = evidenceForPaths(
      input,
      definition.evidence_paths,
      observedAt,
      evidenceCache,
    );
    const identityResult = syncSpecialistIdentity(input, definition, evidence);
    if (identityResult === "created") created.push(definition.specialist_id);
    else if (identityResult === "updated") updated.push(definition.specialist_id);
    else unchanged.push(definition.specialist_id);
    specialistMemory.push(
      materializeSpecialistMemory(input, definition, evidence, observedAt),
    );
  }

  for (const definition of input.portfolio.procedures) {
    const evidence = evidenceForPaths(
      input,
      definition.evidence_paths,
      observedAt,
      evidenceCache,
    );
    procedureMemory.push(
      materializeProcedureMemory(input, definition, evidence, observedAt),
    );
  }

  const retired = retireMissingSpecialists(
    input,
    new Set(input.portfolio.specialists.map((definition) => definition.specialist_id)),
    portfolioEvidence(),
  );
  const staleProcedureMemoryIds = staleMissingProcedureMemory(
    input,
    new Set(input.portfolio.procedures.map((definition) => definition.procedure_id)),
    portfolioEvidence(),
  );
  const allEvidence = [...evidenceCache.values()].sort((left, right) =>
    left.evidence_id.localeCompare(right.evidence_id)
  );

  return {
    created_specialist_ids: created.sort((left, right) => left.localeCompare(right)),
    updated_specialist_ids: updated.sort((left, right) => left.localeCompare(right)),
    unchanged_specialist_ids: unchanged.sort((left, right) => left.localeCompare(right)),
    retired_specialist_ids: retired,
    stale_procedure_memory_ids: staleProcedureMemoryIds,
    specialist_memory: specialistMemory.sort((left, right) =>
      left.memory_id.localeCompare(right.memory_id)
    ),
    procedure_memory: procedureMemory.sort((left, right) =>
      left.memory_id.localeCompare(right.memory_id)
    ),
    evidence: allEvidence,
  };
}
