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
import { TeamMemoryError, type MemoryStoreOptions } from "../contracts.ts";
import {
  makeMutationEvent,
  validateIdentitySemantics,
  validateMutationEvent,
  validateRecordSemantics,
  validateSchema,
} from "../validation.ts";
import {
  historyRelativePath,
  persistVersionedEntityInternal as persistCompactedEntity,
  recoverEntityFromEvent as recoverCompactedEntity,
} from "./history-compact.ts";
import {
  historyEventFiles as physicalHistoryEventFiles,
  latestEventsByEntity as physicalLatestEventsByEntity,
} from "./history-base.ts";
import {
  errorCode,
  readRelativeJson,
  repositoryRoot,
  writeJsonAtomic,
} from "./files.ts";

export * from "./history-compact.ts";

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

function syntheticInitialEvent(entity: AgentIdentity | MemoryRecord): MemoryMutationEvent {
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
          "bootstrap recovery event",
        ),
      );
      if (event.revision !== 1 || event.before_digest !== null) {
        throw new TeamMemoryError(
          "corrupt_state",
          `bootstrap recovery event is not a revision-one baseline: ${relativePath}`,
        );
      }
      events.push(event);
    }
  }
  return events;
}

/**
 * Keep one ignored recovery capsule for compact revision-one state. It is not
 * committed or included in the visible manifest, but preserves the existing
 * repairable-current-snapshot guarantee in the installation that created it.
 */
function writeRecoveryEvent(
  cwd: string,
  event: MemoryMutationEvent,
  options?: MemoryStoreOptions,
): void {
  writeJsonAtomic(cwd, pendingInitialEventRelativePath(event.after), event, options);
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
  persistCompactedEntity(
    cwd,
    after,
    operation,
    actor,
    reason,
    occurredAt,
    beforeDigest,
    options,
  );
  if (compactInitialEntity(after)) {
    writeRecoveryEvent(
      cwd,
      makeMutationEvent(
        entityType(after),
        after,
        operation,
        actor,
        reason,
        occurredAt,
        beforeDigest,
      ),
      options,
    );
  } else if (after.revision > 1) {
    removePendingInitialEvent(cwd, after);
  }
}

/**
 * Prefer immutable visible history, then ignored bootstrap recovery capsules,
 * then synthesize a revision-one event from a valid current snapshot. Corrupt
 * current files are deliberately skipped here so visible history can repair
 * them instead of being pre-empted by a parse failure.
 */
export function latestEventsByEntity(cwd: string): Map<string, MemoryMutationEvent> {
  const latest = physicalLatestEventsByEntity(cwd);
  for (const pending of readPendingInitialEvents(cwd)) {
    const key = `${pending.entity_type}:${pending.entity_id}`;
    const existing = latest.get(key);
    if (existing !== undefined) {
      if (existing.revision === pending.revision && existing.after_digest !== pending.after_digest) {
        throw new TeamMemoryError(
          "corrupt_state",
          `bootstrap recovery event conflicts with visible history for ${key}`,
        );
      }
      continue;
    }
    latest.set(key, pending);
  }

  for (const relativePath of currentEntityPaths(cwd)) {
    let entity: AgentIdentity | MemoryRecord;
    try {
      entity = readEntityAtPath(cwd, relativePath);
    } catch (error) {
      if (error instanceof TeamMemoryError && error.code === "corrupt_state") continue;
      throw error;
    }
    const key = `${entityType(entity)}:${entityId(entity)}`;
    if (latest.has(key) || !compactInitialEntity(entity)) continue;
    latest.set(key, syntheticInitialEvent(entity));
  }
  return latest;
}

/** Include virtual revision-one paths while tolerating repairable current corruption. */
export function historyEventFiles(cwd: string, entityKind: "agents" | "memory"): string[] {
  const paths = new Set(physicalHistoryEventFiles(cwd, entityKind));
  for (const pending of readPendingInitialEvents(cwd)) {
    if ((pending.entity_type === "agent_identity" ? "agents" : "memory") === entityKind) {
      paths.add(historyRelativePath(pending.after));
    }
  }
  for (const relativePath of currentEntityPaths(cwd)) {
    let entity: AgentIdentity | MemoryRecord;
    try {
      entity = readEntityAtPath(cwd, relativePath);
    } catch (error) {
      if (error instanceof TeamMemoryError && error.code === "corrupt_state") continue;
      throw error;
    }
    if (!compactInitialEntity(entity)) continue;
    if (("agent_id" in entity ? "agents" : "memory") !== entityKind) continue;
    paths.add(historyRelativePath(entity));
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export function recoverEntityFromEvent(
  cwd: string,
  event: MemoryMutationEvent,
  options: MemoryStoreOptions | undefined,
  repaired: string[],
): void {
  recoverCompactedEntity(cwd, event, options, repaired);
  if (event.revision === 1 && compactInitialEntity(event.after)) {
    writeRecoveryEvent(cwd, event, options);
  } else if (event.revision > 1) {
    removePendingInitialEvent(cwd, event.after);
  }
}
