import * as fs from "node:fs";
import * as path from "node:path";
import {
  AgentIdentitySchema,
  MemoryMutationEventSchema,
  MemoryRecordSchema,
  type AgentIdentity,
  type MemoryMutationEvent,
  type MemoryMutationOperation,
  type MemoryRecord,
} from "../schema.ts";
import {
  normalizeMemoryRepositoryPath,
} from "../paths.ts";
import { TeamMemoryError, type MemoryStoreOptions } from "../contracts.ts";
import {
  makeMutationEvent,
  validateIdentitySemantics,
  validateMutationEvent,
  validateRecordSemantics,
  validateSchema,
} from "../validation.ts";
import {
  assertVisibleWriteCapacity,
} from "./manifest.ts";
import {
  currentRelativePath,
  historyEventFiles as historyEventFilesBase,
  historyRelativePath,
  latestEventsByEntity as latestEventsByEntityBase,
  persistVersionedEntityInternal as persistVersionedEntityInternalBase,
  readMutationEvent as readMutationEventBase,
  recoverEntityFromEvent as recoverEntityFromEventBase,
} from "./history-base.ts";
import {
  errorCode,
  readRelativeJson,
  repositoryRoot,
  writeJsonAtomic,
  writeJsonImmutable,
} from "./files.ts";

export {
  assertCandidateAcceptanceCapacity,
  candidateDecisionFiles,
  cleanupUncommittedInitialization,
  createCandidateDecisionEvent,
  currentRelativePath,
  historyRelativePath,
  isTeamMemoryManagedPath,
  readCandidateDecisionIfPresent,
  recognizableVisibleStateExistsWithoutManifest,
  removeRuntimeCandidate,
  visibleStateExistsWithoutManifest,
  writeCandidateDecisionInternal,
} from "./history-base.ts";

const CURRENT_MEMORY_DIRECTORIES = [
  ".agentify/knowledge/codebase",
  ".agentify/knowledge/procedures",
  ".agentify/knowledge/episodes",
  ".agentify/knowledge/specialists",
  ".agentify/knowledge/orchestrator",
  ".agentify/policies",
] as const;
const CURRENT_AGENT_DIRECTORIES = [
  ".agentify/agents/roles",
  ".agentify/agents/specialists",
] as const;
const COMPACT_INITIAL_MEMORY_KINDS = new Set([
  "policy",
  "procedure",
  "specialist",
]);
const INITIAL_HISTORY_REASON =
  "Initial bootstrap state; immutable revision history begins with the first material change.";

function compactInitialEntity(entity: AgentIdentity | MemoryRecord): boolean {
  if (entity.revision !== 1) return false;
  return "agent_id" in entity || COMPACT_INITIAL_MEMORY_KINDS.has(entity.kind);
}

function entityType(entity: AgentIdentity | MemoryRecord): "agent_identity" | "memory_record" {
  return "agent_id" in entity ? "agent_identity" : "memory_record";
}

function entityId(entity: AgentIdentity | MemoryRecord): string {
  return "agent_id" in entity ? entity.agent_id : entity.memory_id;
}

function initialOperation(entity: AgentIdentity | MemoryRecord): MemoryMutationOperation {
  return "agent_id" in entity ? "create" : "accept";
}

function initialActor(entity: AgentIdentity | MemoryRecord): string {
  if ("agent_id" in entity && entity.role !== "specialist") return "agentify-installer";
  return "knowledge-maintainer";
}

function initialEvent(entity: AgentIdentity | MemoryRecord): MemoryMutationEvent {
  return makeMutationEvent(
    entityType(entity),
    entity,
    initialOperation(entity),
    initialActor(entity),
    INITIAL_HISTORY_REASON,
    entity.created_at,
    null,
  );
}

function pendingInitialEventRelativePath(entity: AgentIdentity | MemoryRecord): string {
  const kind = "agent_id" in entity ? "agents" : "memory";
  return `.agentify/runtime/initial-history/${kind}/${entityId(entity)}.json`;
}

function pendingInitialEventAbsolutePath(
  cwd: string,
  entity: AgentIdentity | MemoryRecord,
): string {
  return path.join(
    repositoryRoot(cwd),
    ...pendingInitialEventRelativePath(entity).split("/"),
  );
}

function removePendingInitialEvent(cwd: string, entity: AgentIdentity | MemoryRecord): void {
  const absolute = pendingInitialEventAbsolutePath(cwd, entity);
  try {
    fs.unlinkSync(absolute);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  for (const directory of [path.dirname(absolute), path.dirname(path.dirname(absolute))]) {
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      if (!new Set(["ENOENT", "ENOTEMPTY"]).has(errorCode(error) ?? "")) throw error;
    }
  }
}

function readEntityAtPath(cwd: string, relativePath: string): AgentIdentity | MemoryRecord {
  const parsed = readRelativeJson(cwd, relativePath);
  if (typeof parsed === "object" && parsed !== null && "agent_id" in parsed) {
    return validateIdentitySemantics(
      validateSchema<AgentIdentity>(AgentIdentitySchema, parsed, "agent identity"),
    );
  }
  return validateRecordSemantics(
    validateSchema<MemoryRecord>(MemoryRecordSchema, parsed, "memory record"),
  );
}

function filesInDirectory(cwd: string, relativeDirectory: string): string[] {
  const absolute = path.join(repositoryRoot(cwd), ...relativeDirectory.split("/"));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => `${relativeDirectory}/${entry.name}`)
    .sort((left, right) => left.localeCompare(right));
}

function currentEntityPaths(cwd: string): string[] {
  const paths: string[] = [];
  const orchestrator = ".agentify/agents/orchestrator.json";
  if (fs.existsSync(path.join(repositoryRoot(cwd), ...orchestrator.split("/")))) {
    paths.push(orchestrator);
  }
  for (const directory of CURRENT_AGENT_DIRECTORIES) {
    paths.push(...filesInDirectory(cwd, directory));
  }
  for (const directory of CURRENT_MEMORY_DIRECTORIES) {
    paths.push(...filesInDirectory(cwd, directory));
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function currentEntityForHistoryPath(
  cwd: string,
  relativeHistoryPath: string,
): AgentIdentity | MemoryRecord | null {
  const normalized = normalizeMemoryRepositoryPath(relativeHistoryPath, "memory event path");
  const match = normalized.match(
    /^\.agentify\/history\/(agents|memory)\/([a-z0-9][a-z0-9._-]{0,127})\/(\d{12})\.json$/,
  );
  if (!match || Number(match[3]) !== 1) return null;
  const id = match[2]!;
  const candidates = match[1] === "agents"
    ? [
        id === "orchestrator" ? ".agentify/agents/orchestrator.json" : null,
        `.agentify/agents/roles/${id}.json`,
        `.agentify/agents/specialists/${id}.json`,
      ].filter((value): value is string => value !== null)
    : CURRENT_MEMORY_DIRECTORIES.map((directory) => `${directory}/${id}.json`);
  const existing = candidates.filter((candidate) =>
    fs.existsSync(path.join(repositoryRoot(cwd), ...candidate.split("/")))
  );
  if (existing.length === 0) return null;
  if (existing.length > 1) {
    throw new TeamMemoryError("corrupt_state", `entity ${id} exists at multiple current paths`);
  }
  const entity = readEntityAtPath(cwd, existing[0]!);
  if (entityId(entity) !== id || entity.revision !== 1 || !compactInitialEntity(entity)) return null;
  return entity;
}

function readPendingInitialEvents(cwd: string): MemoryMutationEvent[] {
  const events: MemoryMutationEvent[] = [];
  for (const directory of [
    ".agentify/runtime/initial-history/agents",
    ".agentify/runtime/initial-history/memory",
  ]) {
    for (const relativePath of filesInDirectory(cwd, directory)) {
      const event = validateMutationEvent(
        validateSchema<MemoryMutationEvent>(
          MemoryMutationEventSchema,
          readRelativeJson(cwd, relativePath),
          "pending initial memory mutation event",
        ),
      );
      if (event.revision !== 1 || event.before_digest !== null) {
        throw new TeamMemoryError(
          "corrupt_state",
          `pending initial event is not a revision-one baseline: ${relativePath}`,
        );
      }
      events.push(event);
    }
  }
  return events;
}

/**
 * Revision-one bootstrap snapshots are already integrity-bound by the current
 * record and manifest. Return a synthetic immutable event for readers without
 * committing a byte-for-byte duplicate history file.
 */
export function readMutationEvent(cwd: string, relativePath: string): MemoryMutationEvent {
  try {
    return readMutationEventBase(cwd, relativePath);
  } catch (error) {
    if (!(error instanceof TeamMemoryError) || error.code !== "not_found") throw error;
  }

  const normalized = normalizeMemoryRepositoryPath(relativePath, "memory event path");
  for (const pending of readPendingInitialEvents(cwd)) {
    if (historyRelativePath(pending.after) === normalized) return pending;
  }
  const entity = currentEntityForHistoryPath(cwd, normalized);
  if (entity === null) {
    throw new TeamMemoryError("not_found", `memory mutation event not found: ${normalized}`);
  }
  return initialEvent(entity);
}

/** Include virtual revision-one paths so point-in-time readers retain semantics. */
export function historyEventFiles(cwd: string, entityKind: "agents" | "memory"): string[] {
  const physical = new Set(
    historyEventFilesBase(cwd, entityKind),
  );
  for (const relativePath of currentEntityPaths(cwd)) {
    const entity = readEntityAtPath(cwd, relativePath);
    if (!compactInitialEntity(entity)) continue;
    if (("agent_id" in entity ? "agents" : "memory") !== entityKind) continue;
    physical.add(historyRelativePath(entity));
  }
  for (const event of readPendingInitialEvents(cwd)) {
    if ((event.entity_type === "agent_identity" ? "agents" : "memory") === entityKind) {
      physical.add(historyRelativePath(event.after));
    }
  }
  return [...physical].sort((left, right) => left.localeCompare(right));
}

export function persistVersionedEntityInternal(
  cwd: string,
  after: AgentIdentity | MemoryRecord,
  operation: MemoryMutationOperation,
  actor: string,
  reason: string,
  occurredAt: string,
  beforeDigest: string | null,
  options?: MemoryStoreOptions,
): void {
  const currentPath = currentRelativePath(after);
  if (compactInitialEntity(after)) {
    const event = makeMutationEvent(
      entityType(after),
      after,
      operation,
      actor,
      reason,
      occurredAt,
      beforeDigest,
    );
    const pendingPath = pendingInitialEventRelativePath(after);
    assertVisibleWriteCapacity(cwd, [{ relativePath: currentPath, value: after }]);
    writeJsonAtomic(cwd, pendingPath, event, options);
    options?.afterHistoryWrite?.(
      path.join(repositoryRoot(cwd), ...pendingPath.split("/")),
      path.join(repositoryRoot(cwd), ...currentPath.split("/")),
    );
    writeJsonAtomic(cwd, currentPath, after, options);
    removePendingInitialEvent(cwd, after);
    return;
  }

  if (after.revision === 2) {
    const current = readEntityAtPath(cwd, currentPath);
    const baselinePath = historyRelativePath(current);
    const baselineAbsolute = path.join(repositoryRoot(cwd), ...baselinePath.split("/"));
    if (
      compactInitialEntity(current)
      && current.revision === 1
      && current.content_digest === beforeDigest
      && !fs.existsSync(baselineAbsolute)
    ) {
      const baseline = initialEvent(current);
      const event = makeMutationEvent(
        entityType(after),
        after,
        operation,
        actor,
        reason,
        occurredAt,
        beforeDigest,
      );
      const eventPath = historyRelativePath(after);
      assertVisibleWriteCapacity(cwd, [
        { relativePath: baselinePath, value: baseline },
        { relativePath: eventPath, value: event },
        { relativePath: currentPath, value: after },
      ]);
      writeJsonImmutable(cwd, baselinePath, baseline);
      writeJsonImmutable(cwd, eventPath, event);
      options?.afterHistoryWrite?.(
        path.join(repositoryRoot(cwd), ...eventPath.split("/")),
        path.join(repositoryRoot(cwd), ...currentPath.split("/")),
      );
      writeJsonAtomic(cwd, currentPath, after, options);
      return;
    }
  }

  // Preserve the existing event-first behavior for ordinary memory and every
  // revision after the first material change.
  persistVersionedEntityInternalBase(
    cwd,
    after,
    operation,
    actor,
    reason,
    occurredAt,
    beforeDigest,
    options,
  );
}

export function recoverEntityFromEvent(
  cwd: string,
  event: MemoryMutationEvent,
  options: MemoryStoreOptions | undefined,
  repaired: string[],
): void {
  recoverEntityFromEventBase(cwd, event, options, repaired);
  if (event.revision === 1 && compactInitialEntity(event.after)) {
    removePendingInitialEvent(cwd, event.after);
  }
}

export function latestEventsByEntity(cwd: string): Map<string, MemoryMutationEvent> {
  const latest = latestEventsByEntityBase(cwd);
  for (const pending of readPendingInitialEvents(cwd)) {
    const key = `${pending.entity_type}:${pending.entity_id}`;
    const existing = latest.get(key);
    if (existing && existing.after_digest !== pending.after_digest) {
      throw new TeamMemoryError(
        "corrupt_state",
        `pending initial event conflicts with visible history for ${key}`,
      );
    }
    if (!existing) latest.set(key, pending);
  }
  for (const relativePath of currentEntityPaths(cwd)) {
    const entity = readEntityAtPath(cwd, relativePath);
    const key = `${entityType(entity)}:${entityId(entity)}`;
    if (latest.has(key)) continue;
    if (!compactInitialEntity(entity)) continue;
    latest.set(key, initialEvent(entity));
  }
  return latest;
}
