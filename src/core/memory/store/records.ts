import {
  type MemoryMutationInput,
  type MemoryQuery,
  TeamMemoryError,
} from "../contracts.ts";
import {
  memoryRecordRelativePath,
  normalizeMemoryRepositoryPath,
  validateMemoryId,
} from "../paths.ts";
import {
  acquireStoreLock,
  errorCode,
  MAX_MEMORY_RECORDS,
  persistVersionedEntityInternal,
  readRelativeJson,
  readTeamMemoryManifest,
  refreshManifestInternal,
  repositoryRoot,
} from "../persistence.ts";
import {
  type MemoryFreshness,
  type MemoryMutationOperation,
  type MemoryRecord,
  MemoryRecordSchema,
} from "../schema.ts";
import {
  normalizeEvidence,
  recordPaths,
  sortedUniqueStrings,
} from "../serialization.ts";
import {
  assertExpectedRevision,
  nowIso,
  updatedRecord,
  validateRecordSemantics,
  validateSchema,
} from "../validation.ts";
import {
  assertCurrentEntityMatchesImmutableHistory,
  assertKnowledgeMaintainerAuthority,
} from "./identities.ts";
import {
  assertInitializedForMutation,
  validateWriteEvidence,
} from "./shared.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export function readMemoryRecordAtPath(cwd: string, relativePath: string): MemoryRecord {
  const record = validateSchema<MemoryRecord>(
    MemoryRecordSchema,
    readRelativeJson(cwd, relativePath),
    "memory record",
  );
  if (memoryRecordRelativePath(record.kind, record.memory_id) !== relativePath) {
    throw new TeamMemoryError("corrupt_state", `memory record path does not match ${record.memory_id}`);
  }
  const validated = validateRecordSemantics(record);
  assertCurrentEntityMatchesImmutableHistory(cwd, validated);
  return validated;
}

export function currentMemoryRecordPaths(cwd: string): string[] {
  const paths: string[] = [];
  const root = repositoryRoot(cwd);
  for (const directory of [
    ".agentify/knowledge/codebase",
    ".agentify/knowledge/procedures",
    ".agentify/knowledge/episodes",
    ".agentify/knowledge/specialists",
    ".agentify/knowledge/orchestrator",
    ".agentify/policies",
  ]) {
    const absolute = path.join(root, ...directory.split("/"));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw new TeamMemoryError("corrupt_state", `cannot list ${directory}`, { cause: error });
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new TeamMemoryError("unsafe_path", `${directory} contains unsupported entry ${entry.name}`);
      }
      const stat = fs.lstatSync(path.join(absolute, entry.name));
      if (stat.isSymbolicLink()) {
        throw new TeamMemoryError("unsafe_path", `${directory}/${entry.name} is a symlink`);
      }
      paths.push(`${directory}/${entry.name}`);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

export function readMemoryRecord(cwd: string, memoryId: string): MemoryRecord {
  validateMemoryId(memoryId);
  const matches = currentMemoryRecordPaths(cwd)
    .filter((relativePath) => path.posix.basename(relativePath) === `${memoryId}.json`);
  if (matches.length === 0) {
    throw new TeamMemoryError("not_found", `memory record not found: ${memoryId}`);
  }
  if (matches.length > 1) {
    throw new TeamMemoryError("corrupt_state", `memory ID exists in multiple kind directories: ${memoryId}`);
  }
  return readMemoryRecordAtPath(cwd, matches[0]!);
}

export function listMemoryRecordsInternal(cwd: string, query: MemoryQuery = {}): MemoryRecord[] {
  const normalizedPath = query.path === undefined
    ? undefined
    : normalizeMemoryRepositoryPath(query.path, "memory query path");
  return currentMemoryRecordPaths(cwd)
    .map((relativePath) => readMemoryRecordAtPath(cwd, relativePath))
    .filter((record) => query.kind === undefined || record.kind === query.kind)
    .filter((record) => query.owningAgentId === undefined || record.owning_agent_id === query.owningAgentId)
    .filter((record) => query.freshness === undefined || record.freshness === query.freshness)
    .filter((record) => query.tag === undefined || record.tags.includes(query.tag))
    .filter((record) => query.evidenceId === undefined
      || record.evidence.some((entry) => entry.evidence_id === query.evidenceId))
    .filter((record) => query.domain === undefined
      || (record.kind === "specialist" && record.payload.concern === query.domain))
    .filter((record) => query.taskId === undefined
      || (record.kind === "episode" && record.payload.task_id === query.taskId)
      || (record.kind === "orchestrator" && record.payload.routing_key === query.taskId))
    .filter((record) => normalizedPath === undefined || recordPaths(record).some((candidatePath) =>
      candidatePath === normalizedPath
      || candidatePath.startsWith(`${normalizedPath}/`)
      || normalizedPath.startsWith(`${candidatePath}/`)
    ))
    .sort((left, right) => left.memory_id.localeCompare(right.memory_id));
}

export function listMemoryRecords(cwd: string, query: MemoryQuery = {}): MemoryRecord[] {
  readTeamMemoryManifest(cwd);
  return listMemoryRecordsInternal(cwd, query);
}

export function assertRecordCapacity(cwd: string): void {
  if (currentMemoryRecordPaths(cwd).length >= MAX_MEMORY_RECORDS) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `team memory already contains the maximum ${MAX_MEMORY_RECORDS} current records`,
    );
  }
}

export function mergeMemoryEvidence(
  cwd: string,
  memoryId: string,
  input: MemoryMutationInput,
): MemoryRecord {
  assertInitializedForMutation(cwd);
  return acquireStoreLock(cwd, input.options, () => {
    readTeamMemoryManifest(cwd);
    const actor = assertKnowledgeMaintainerAuthority(cwd, input.actor);
    const current = readMemoryRecord(cwd, memoryId);
    assertExpectedRevision(current, input.expectedRevision);
    const newEvidence = validateWriteEvidence(
      cwd,
      input.evidence,
      input.supportingCommit,
      input.options,
      `memory ${memoryId} evidence merge`,
    );
    const evidence = normalizeEvidence([...current.evidence, ...newEvidence]);
    const timestamp = nowIso(input.options);
    const next = updatedRecord(current, {
      evidence,
      supporting_commit: input.supportingCommit,
    }, timestamp);
    persistVersionedEntityInternal(
      cwd,
      next,
      "merge_evidence",
      actor,
      input.reason,
      timestamp,
      current.content_digest,
      input.options,
    );
    refreshManifestInternal(cwd, input.options);
    return next;
  });
}

export function transitionMemory(
  cwd: string,
  memoryId: string,
  target: MemoryFreshness,
  replacementId: string | null,
  operation: MemoryMutationOperation,
  input: MemoryMutationInput,
): MemoryRecord {
  assertInitializedForMutation(cwd);
  return acquireStoreLock(cwd, input.options, () => {
    readTeamMemoryManifest(cwd);
    const actor = assertKnowledgeMaintainerAuthority(cwd, input.actor);
    const current = readMemoryRecord(cwd, memoryId);
    assertExpectedRevision(current, input.expectedRevision);
    if (operation === "revalidate" && current.freshness !== "stale" && current.freshness !== "invalid") {
      throw new TeamMemoryError(
        "policy_violation",
        `only stale or invalid memory can be revalidated: ${memoryId}`,
      );
    }
    if (current.freshness === "superseded") {
      throw new TeamMemoryError(
        "policy_violation",
        `superseded memory cannot transition again: ${memoryId}`,
      );
    }
    if (operation === "mark_stale" && current.freshness !== "current") {
      throw new TeamMemoryError(
        "policy_violation",
        `only current memory can be marked stale: ${memoryId}`,
      );
    }
    if (target === "superseded" && replacementId === null) {
      throw new TeamMemoryError("invalid_input", "superseding memory requires a replacement ID");
    }
    if (target !== "superseded" && replacementId !== null) {
      throw new TeamMemoryError("invalid_input", "only superseded memory may name a replacement");
    }
    if (replacementId !== null) {
      validateMemoryId(replacementId, "replacement memory ID");
      if (replacementId === memoryId) {
        throw new TeamMemoryError("invalid_input", "memory cannot supersede itself");
      }
      const replacement = readMemoryRecord(cwd, replacementId);
      if (replacement.freshness !== "current") {
        throw new TeamMemoryError(
          "policy_violation",
          `replacement memory must be current: ${replacementId}`,
        );
      }
      if (replacement.kind !== current.kind) {
        throw new TeamMemoryError(
          "invalid_input",
          `replacement memory kind ${replacement.kind} does not match ${current.kind}`,
        );
      }
    }
    const newEvidence = validateWriteEvidence(
      cwd,
      input.evidence,
      input.supportingCommit,
      input.options,
      `memory ${memoryId} ${operation}`,
    );
    const evidence = normalizeEvidence([...current.evidence, ...newEvidence]);
    const timestamp = nowIso(input.options);
    const next = updatedRecord(current, {
      freshness: target,
      superseded_by: replacementId,
      supporting_commit: input.supportingCommit,
      evidence,
      invalidation_conditions: operation === "revalidate"
        ? current.invalidation_conditions
        : sortedUniqueStrings([
            ...current.invalidation_conditions,
            input.reason,
          ]),
    }, timestamp);
    persistVersionedEntityInternal(
      cwd,
      next,
      operation,
      actor,
      input.reason,
      timestamp,
      current.content_digest,
      input.options,
    );
    refreshManifestInternal(cwd, input.options);
    return next;
  });
}

export function markMemoryStale(
  cwd: string,
  memoryId: string,
  input: MemoryMutationInput,
): MemoryRecord {
  return transitionMemory(cwd, memoryId, "stale", null, "mark_stale", input);
}

export function invalidateMemory(
  cwd: string,
  memoryId: string,
  input: MemoryMutationInput,
): MemoryRecord {
  return transitionMemory(cwd, memoryId, "invalid", null, "invalidate", input);
}

export function supersedeMemory(
  cwd: string,
  memoryId: string,
  replacementId: string,
  input: MemoryMutationInput,
): MemoryRecord {
  return transitionMemory(cwd, memoryId, "superseded", replacementId, "supersede", input);
}

export function revalidateMemory(
  cwd: string,
  memoryId: string,
  input: MemoryMutationInput,
): MemoryRecord {
  return transitionMemory(cwd, memoryId, "current", null, "revalidate", input);
}
