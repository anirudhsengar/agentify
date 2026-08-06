import {
  type AgentMemoryView,
  type CompactMemoryResult,
  type MemoryStoreOptions,
  TeamMemoryError,
} from "../contracts.ts";
import {
  acquireStoreLock,
  historyEventFiles,
  latestEventsByEntity,
  persistVersionedEntityInternal,
  readMutationEvent,
  readTeamMemoryManifest,
  refreshManifestInternal,
} from "../persistence.ts";
import {
  type AgentIdentity,
  type EvidenceReference,
  type MemoryMutationEvent,
  type MemoryRecord,
} from "../schema.ts";
import {
  normalizeEvidence,
  sortedUniqueStrings,
} from "../serialization.ts";
import {
  confidenceRank,
  nowIso,
  updatedRecord,
} from "../validation.ts";
import {
  assertKnowledgeMaintainerAuthority,
  readAgentIdentity,
} from "./identities.ts";
import {
  listMemoryRecordsInternal,
} from "./records.ts";
import {
  assertInitializedForMutation,
  validateWriteEvidence,
} from "./shared.ts";

export function eventsAsOf(
  cwd: string,
  asOf: string,
): Map<string, MemoryMutationEvent> {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) {
    throw new TeamMemoryError("invalid_input", `invalid point-in-time timestamp: ${asOf}`);
  }
  const latest = new Map<string, MemoryMutationEvent>();
  for (const relativePath of [
    ...historyEventFiles(cwd, "agents"),
    ...historyEventFiles(cwd, "memory"),
  ]) {
    const event = readMutationEvent(cwd, relativePath);
    if (Date.parse(event.occurred_at) > cutoff) continue;
    const key = `${event.entity_type}:${event.entity_id}`;
    const current = latest.get(key);
    if (!current || event.revision > current.revision) latest.set(key, event);
  }
  return latest;
}

export function readAgentMemoryView(
  cwd: string,
  agentId: string,
  options: { asOf?: string; includeInactive?: boolean } = {},
): AgentMemoryView {
  readTeamMemoryManifest(cwd);
  let identity: AgentIdentity;
  let records: MemoryRecord[];
  const asOf = options.asOf ?? new Date().toISOString();
  if (options.asOf === undefined) {
    identity = readAgentIdentity(cwd, agentId);
    records = listMemoryRecordsInternal(cwd);
  } else {
    latestEventsByEntity(cwd);
    const events = eventsAsOf(cwd, options.asOf);
    const identityEvent = events.get(`agent_identity:${agentId}`);
    if (!identityEvent || !("agent_id" in identityEvent.after)) {
      throw new TeamMemoryError("not_found", `agent identity did not exist at ${options.asOf}: ${agentId}`);
    }
    identity = identityEvent.after;
    records = [...events.values()]
      .filter((event) => event.entity_type === "memory_record")
      .map((event) => event.after)
      .filter((after): after is MemoryRecord => "memory_id" in after);
  }
  const visible = (() => {
    if (identity.role === "orchestrator" || identity.role === "knowledge_maintainer") {
      return records;
    }
    if (identity.role === "builder" || identity.role === "reviewer") {
      return records.filter((record) => record.kind !== "orchestrator");
    }
    return records.filter((record) =>
      record.owning_agent_id === agentId
      || record.kind === "codebase"
      || record.kind === "procedure"
      || record.kind === "policy"
    );
  })();
  return {
    as_of: asOf,
    identity,
    records: visible
      .filter((record) => options.includeInactive === true || record.freshness === "current")
      .sort((left, right) => left.memory_id.localeCompare(right.memory_id)),
  };
}

export function compactMemoryRecords(
  cwd: string,
  actor: string,
  supportingCommit: string,
  evidence: ReadonlyArray<EvidenceReference>,
  options?: MemoryStoreOptions,
): CompactMemoryResult {
  assertInitializedForMutation(cwd);
  return acquireStoreLock(cwd, options, () => {
    readTeamMemoryManifest(cwd);
    const decisionActor = assertKnowledgeMaintainerAuthority(cwd, actor);
    const groups = new Map<string, MemoryRecord[]>();
    for (const record of listMemoryRecordsInternal(cwd, { freshness: "current" })) {
      const group = groups.get(record.semantic_digest) ?? [];
      group.push(record);
      groups.set(record.semantic_digest, group);
    }
    const kept: string[] = [];
    const superseded: string[] = [];
    const timestamp = nowIso(options);
    const normalizedEvidence = validateWriteEvidence(
      cwd,
      evidence,
      supportingCommit,
      options,
      "memory compaction",
    );

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((left, right) => left.memory_id.localeCompare(right.memory_id));
      const keeper = group[0]!;
      const mergedEvidence = normalizeEvidence([
        ...group.flatMap((record) => record.evidence),
        ...normalizedEvidence,
      ]);
      const strongestConfidence = group.reduce(
        (strongest, record) => confidenceRank(record.confidence) > confidenceRank(strongest)
          ? record.confidence
          : strongest,
        keeper.confidence,
      );
      const mergedInvalidationConditions = sortedUniqueStrings(
        group.flatMap((record) => record.invalidation_conditions),
      );
      const mergedContradictions = sortedUniqueStrings(
        group.flatMap((record) => record.contradicts),
      );
      const updatedKeeper = updatedRecord(keeper, {
        evidence: mergedEvidence,
        confidence: strongestConfidence,
        invalidation_conditions: mergedInvalidationConditions,
        contradicts: mergedContradictions,
        supporting_commit: supportingCommit,
      }, timestamp);
      persistVersionedEntityInternal(
        cwd,
        updatedKeeper,
        "compact",
        decisionActor,
        `compact semantically equivalent memories into ${keeper.memory_id}`,
        timestamp,
        keeper.content_digest,
        options,
      );
      kept.push(keeper.memory_id);
      // Candidate IDs remain on their original records because immutable candidate
      // decisions are bound to the original resulting memory ID. Superseding the
      // duplicate retains that complete attribution without creating a second binding.
      for (const duplicate of group.slice(1)) {
        const next = updatedRecord(duplicate, {
          freshness: "superseded",
          superseded_by: keeper.memory_id,
          supporting_commit: supportingCommit,
          evidence: normalizeEvidence([...duplicate.evidence, ...normalizedEvidence]),
          invalidation_conditions: sortedUniqueStrings([
            ...duplicate.invalidation_conditions,
            `compacted into semantically equivalent memory ${keeper.memory_id}`,
          ]),
        }, timestamp);
        persistVersionedEntityInternal(
          cwd,
          next,
          "compact",
          decisionActor,
          `compact semantically equivalent memory into ${keeper.memory_id}`,
          timestamp,
          duplicate.content_digest,
          options,
        );
        superseded.push(duplicate.memory_id);
      }
    }
    refreshManifestInternal(cwd, options);
    return {
      kept: sortedUniqueStrings(kept),
      superseded: sortedUniqueStrings(superseded),
    };
  });
}
