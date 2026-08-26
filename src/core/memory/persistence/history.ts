import * as fs from "node:fs";
import * as path from "node:path";
import {
  AgentIdentitySchema,
  CandidateDecisionEventSchema,
  MemoryMutationEventSchema,
  MemoryRecordSchema,
  type AgentIdentity,
  type CandidateDecisionEvent,
  type MemoryCandidate,
  type MemoryMutationEvent,
  type MemoryMutationOperation,
  type MemoryRecord,
} from "../schema.ts";
import {
  agentIdentityRelativePath,
  candidateDecisionRelativePath,
  identityHistoryRelativePath,
  isTeamMemoryOperationalPath,
  isTeamMemoryVisiblePath,
  memoryHistoryRelativePath,
  memoryRecordRelativePath,
  normalizeMemoryRepositoryPath,
  runtimeCandidateRelativePath,
  teamMemoryRoot,
  validateMemoryId,
} from "../paths.ts";
import { digestCanonical } from "../serialization.ts";
import { TeamMemoryError, type MemoryStoreOptions } from "../contracts.ts";
import {
  assertNonEmpty,
  makeMutationEvent,
  validateDecisionEvent,
  validateIdentitySemantics,
  validateMutationEvent,
  validateRecordSemantics,
  validateSchema,
} from "../validation.ts";
import {
  TEAM_IGNORE_CONTENT,
  errorCode,
  readJsonFile,
  readRelativeJson,
  repositoryRoot,
  writeJsonAtomic,
  writeJsonImmutable,
} from "./files.ts";
import {
  assertVisibleWriteCapacity,
  directoryEntriesIfPresent,
  readManifestIfPresent,
  type VisibleWriteProjection,
} from "./manifest.ts";

export function readCandidateDecisionIfPresent(
  cwd: string,
  candidateId: string,
): CandidateDecisionEvent | null {
  const relativePath = candidateDecisionRelativePath(candidateId);
  try {
    const event = validateDecisionEvent(
      validateSchema<CandidateDecisionEvent>(
        CandidateDecisionEventSchema,
        readRelativeJson(cwd, relativePath),
        "candidate decision event",
      ),
    );
    if (event.candidate_id !== candidateId) {
      throw new TeamMemoryError(
        "corrupt_state",
        `candidate decision path does not match ${candidateId}`,
      );
    }
    return event;
  } catch (error) {
    if (error instanceof TeamMemoryError && error.code === "not_found") return null;
    throw error;
  }
}

export function currentRelativePath(after: AgentIdentity | MemoryRecord): string {
  return "agent_id" in after
    ? agentIdentityRelativePath(after.role, after.agent_id)
    : memoryRecordRelativePath(after.kind, after.memory_id);
}

export function historyRelativePath(after: AgentIdentity | MemoryRecord): string {
  return "agent_id" in after
    ? identityHistoryRelativePath(after.agent_id, after.revision)
    : memoryHistoryRelativePath(after.memory_id, after.revision);
}

function snapshotV1HistoryEnabled(cwd: string, options?: MemoryStoreOptions): boolean {
  const manifest = readManifestIfPresent(cwd);
  if (manifest !== null) return manifest.history_mode === "snapshot-v1";
  return options?.deferInitialHistory === true;
}

function historyFileExists(cwd: string, relativePath: string): boolean {
  const absolute = path.join(repositoryRoot(cwd), ...relativePath.split("/"));
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TeamMemoryError("unsafe_path", `${relativePath} must be a regular immutable event`);
    }
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function readDeferredBaseline(
  cwd: string,
  after: AgentIdentity | MemoryRecord,
): AgentIdentity | MemoryRecord {
  const relativePath = currentRelativePath(after);
  const parsed = readRelativeJson(cwd, relativePath);
  const baseline = "agent_id" in after
    ? validateIdentitySemantics(
        validateSchema<AgentIdentity>(AgentIdentitySchema, parsed, "deferred identity baseline"),
      )
    : validateRecordSemantics(
        validateSchema<MemoryRecord>(MemoryRecordSchema, parsed, "deferred memory baseline"),
      );
  if (baseline.revision !== 1) {
    throw new TeamMemoryError(
      "corrupt_state",
      `${relativePath} cannot backfill revision one from current revision ${baseline.revision}`,
    );
  }
  if (
    ("agent_id" in after && (!("agent_id" in baseline) || baseline.agent_id !== after.agent_id))
    || (!("agent_id" in after) && ("agent_id" in baseline || baseline.memory_id !== after.memory_id))
  ) {
    throw new TeamMemoryError("corrupt_state", `${relativePath} does not match its deferred baseline entity`);
  }
  return baseline;
}

interface VersionedEntityWritePlan {
  currentPath: string;
  current: AgentIdentity | MemoryRecord;
  baselinePath: string | null;
  baselineEvent: MemoryMutationEvent | null;
  historyPath: string | null;
  event: MemoryMutationEvent | null;
}

function versionedEntityWritePlan(
  cwd: string,
  after: AgentIdentity | MemoryRecord,
  operation: MemoryMutationOperation,
  actor: string,
  reason: string,
  occurredAt: string,
  beforeDigest: string | null,
  options?: MemoryStoreOptions,
): VersionedEntityWritePlan {
  const currentPath = currentRelativePath(after);
  if (snapshotV1HistoryEnabled(cwd, options) && after.revision === 1) {
    return {
      currentPath,
      current: after,
      baselinePath: null,
      baselineEvent: null,
      historyPath: null,
      event: null,
    };
  }

  let baselinePath: string | null = null;
  let baselineEvent: MemoryMutationEvent | null = null;
  if (snapshotV1HistoryEnabled(cwd, options) && after.revision > 1) {
    const candidatePath = "agent_id" in after
      ? identityHistoryRelativePath(after.agent_id, 1)
      : memoryHistoryRelativePath(after.memory_id, 1);
    if (!historyFileExists(cwd, candidatePath)) {
      const baseline = readDeferredBaseline(cwd, after);
      baselinePath = candidatePath;
      baselineEvent = makeMutationEvent(
        "agent_id" in baseline ? "agent_identity" : "memory_record",
        baseline,
        "agent_id" in baseline ? "create" : "accept",
        "agent_id" in baseline && baseline.role !== "specialist"
          ? "agentify-installer"
          : "knowledge-maintainer",
        "materialize deferred revision-one bootstrap baseline",
        baseline.created_at,
        null,
      );
    }
  }

  const event = makeMutationEvent(
    "agent_id" in after ? "agent_identity" : "memory_record",
    after,
    operation,
    actor,
    reason,
    occurredAt,
    beforeDigest,
  );
  return {
    currentPath,
    current: after,
    baselinePath,
    baselineEvent,
    historyPath: historyRelativePath(after),
    event,
  };
}

export function versionedEntityWriteProjections(
  cwd: string,
  after: AgentIdentity | MemoryRecord,
  operation: MemoryMutationOperation,
  actor: string,
  reason: string,
  occurredAt: string,
  beforeDigest: string | null,
  options?: MemoryStoreOptions,
): VisibleWriteProjection[] {
  const plan = versionedEntityWritePlan(
    cwd,
    after,
    operation,
    actor,
    reason,
    occurredAt,
    beforeDigest,
    options,
  );
  const projections: VisibleWriteProjection[] = [];
  if (plan.baselinePath !== null && plan.baselineEvent !== null) {
    projections.push({ relativePath: plan.baselinePath, value: plan.baselineEvent });
  }
  if (plan.historyPath !== null && plan.event !== null) {
    projections.push({ relativePath: plan.historyPath, value: plan.event });
  }
  projections.push({ relativePath: plan.currentPath, value: plan.current });
  return projections;
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
  const plan = versionedEntityWritePlan(
    cwd,
    after,
    operation,
    actor,
    reason,
    occurredAt,
    beforeDigest,
    options,
  );
  assertVisibleWriteCapacity(
    cwd,
    versionedEntityWriteProjections(
      cwd,
      after,
      operation,
      actor,
      reason,
      occurredAt,
      beforeDigest,
      options,
    ),
  );
  if (plan.baselinePath !== null && plan.baselineEvent !== null) {
    writeJsonImmutable(cwd, plan.baselinePath, plan.baselineEvent);
  }
  if (plan.historyPath !== null && plan.event !== null) {
    writeJsonImmutable(cwd, plan.historyPath, plan.event);
    options?.afterHistoryWrite?.(
      path.join(repositoryRoot(cwd), ...plan.historyPath.split("/")),
      path.join(repositoryRoot(cwd), ...plan.currentPath.split("/")),
    );
  }
  writeJsonAtomic(cwd, plan.currentPath, plan.current, options);
}

export function recognizableVisibleStateExistsWithoutManifest(cwd: string): boolean {
  const root = teamMemoryRoot(cwd);
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const names = new Set(fs.readdirSync(root));
    if (!["agents", "knowledge", "policies", "history"].some((name) => names.has(name))) {
      return false;
    }
    const ignorePath = path.join(root, ".gitignore");
    const ignoreStat = fs.lstatSync(ignorePath);
    if (ignoreStat.isSymbolicLink() || !ignoreStat.isFile() || ignoreStat.size > 4_096) {
      return false;
    }
    return fs.readFileSync(ignorePath, "utf-8") === TEAM_IGNORE_CONTENT;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export function visibleStateExistsWithoutManifest(cwd: string): boolean {
  const root = teamMemoryRoot(cwd);
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (
        entry.name !== "runtime"
        && entry.name !== "state-transactions"
      ) return true;
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  return false;
}

export function cleanupUncommittedInitialization(cwd: string): void {
  const root = teamMemoryRoot(cwd);
  for (const entry of [
    "manifest.json",
    ".gitignore",
    "agents",
    "knowledge",
    "policies",
    "history",
  ]) {
    try {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    } catch {
      // Best effort. A subsequent recovery will fail closed on remaining partial state.
    }
  }
}

export function createCandidateDecisionEvent(
  candidate: MemoryCandidate,
  decision: "accepted" | "rejected",
  actor: string,
  reason: string,
  resultingMemoryId: string | null,
  occurredAt: string,
): CandidateDecisionEvent {
  const normalizedActor = assertNonEmpty(actor, "candidate decision actor");
  const normalizedReason = assertNonEmpty(reason, "candidate decision reason");
  const withoutDigest: Omit<CandidateDecisionEvent, "event_digest"> = {
    schema_version: "1",
    event_type: "candidate_decision",
    candidate_id: candidate.candidate_id,
    memory_id: candidate.memory_id,
    candidate,
    decision,
    actor: normalizedActor,
    reason: normalizedReason,
    occurred_at: occurredAt,
    candidate_digest: candidate.candidate_digest,
    resulting_memory_id: resultingMemoryId,
  };
  const event: CandidateDecisionEvent = {
    ...withoutDigest,
    event_digest: digestCanonical(withoutDigest),
  };
  validateSchema<CandidateDecisionEvent>(
    CandidateDecisionEventSchema,
    event,
    "candidate decision event",
  );
  return validateDecisionEvent(event);
}

export function assertCandidateAcceptanceCapacity(
  cwd: string,
  after: MemoryRecord,
  operation: Extract<MemoryMutationOperation, "accept" | "merge_evidence">,
  actor: string,
  reason: string,
  occurredAt: string,
  beforeDigest: string | null,
  candidate: MemoryCandidate,
  options?: MemoryStoreOptions,
): void {
  const decision = createCandidateDecisionEvent(
    candidate,
    "accepted",
    actor,
    reason,
    after.memory_id,
    occurredAt,
  );
  assertVisibleWriteCapacity(cwd, [
    ...versionedEntityWriteProjections(
      cwd,
      after,
      operation,
      actor,
      reason,
      occurredAt,
      beforeDigest,
      options,
    ),
    { relativePath: candidateDecisionRelativePath(candidate.candidate_id), value: decision },
  ]);
}

export function writeCandidateDecisionInternal(
  cwd: string,
  candidate: MemoryCandidate,
  decision: "accepted" | "rejected",
  actor: string,
  reason: string,
  resultingMemoryId: string | null,
  occurredAt: string,
): CandidateDecisionEvent {
  const event = createCandidateDecisionEvent(
    candidate,
    decision,
    actor,
    reason,
    resultingMemoryId,
    occurredAt,
  );
  const relativePath = candidateDecisionRelativePath(candidate.candidate_id);
  assertVisibleWriteCapacity(cwd, [{ relativePath, value: event }]);
  writeJsonImmutable(cwd, relativePath, event);
  return event;
}

export function removeRuntimeCandidate(cwd: string, candidateId: string): void {
  const absolute = path.join(repositoryRoot(cwd), ...runtimeCandidateRelativePath(candidateId).split("/"));
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TeamMemoryError("unsafe_path", `runtime memory candidate is not a regular file: ${candidateId}`);
    }
    fs.unlinkSync(absolute);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export function historyEventFiles(cwd: string, entityType: "agents" | "memory"): string[] {
  const base = `.agentify/history/${entityType}`;
  const root = path.join(repositoryRoot(cwd), ...base.split("/"));
  const files: string[] = [];
  let entities: fs.Dirent[];
  try {
    entities = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw new TeamMemoryError("corrupt_state", `cannot list ${base}`, { cause: error });
  }
  for (const entity of entities) {
    if (!entity.isDirectory()) {
      throw new TeamMemoryError("unsafe_path", `${base}/${entity.name} must be a directory`);
    }
    validateMemoryId(entity.name, "history entity ID");
    const entityDirectory = path.join(root, entity.name);
    for (const entry of fs.readdirSync(entityDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d{12}\.json$/.test(entry.name)) {
        throw new TeamMemoryError("unsafe_path", `${base}/${entity.name} contains invalid event ${entry.name}`);
      }
      const stat = fs.lstatSync(path.join(entityDirectory, entry.name));
      if (stat.isSymbolicLink()) {
        throw new TeamMemoryError("unsafe_path", `${base}/${entity.name}/${entry.name} is a symlink`);
      }
      files.push(`${base}/${entity.name}/${entry.name}`);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function candidateDecisionFiles(cwd: string): string[] {
  return directoryEntriesIfPresent(cwd, ".agentify/history/candidates")
    .map((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new TeamMemoryError(
          "unsafe_path",
          `.agentify/history/candidates contains unsupported entry ${entry.name}`,
        );
      }
      const candidateId = entry.name.slice(0, -".json".length);
      validateMemoryId(candidateId, "candidate ID");
      return `.agentify/history/candidates/${entry.name}`;
    });
}

export function readMutationEvent(cwd: string, relativePath: string): MemoryMutationEvent {
  const normalized = normalizeMemoryRepositoryPath(relativePath, "memory event path");
  const match = normalized.match(
    /^\.agentify\/history\/(agents|memory)\/([a-z0-9][a-z0-9._-]{0,127})\/(\d{12})\.json$/,
  );
  if (!match) {
    throw new TeamMemoryError("corrupt_state", `invalid memory event path: ${normalized}`);
  }
  const event = validateMutationEvent(
    validateSchema<MemoryMutationEvent>(
      MemoryMutationEventSchema,
      readRelativeJson(cwd, normalized),
      "memory mutation event",
    ),
  );
  const expectedEntityType = match[1] === "agents" ? "agent_identity" : "memory_record";
  const expectedEntityId = match[2]!;
  const expectedRevision = Number(match[3]);
  if (
    event.entity_type !== expectedEntityType
    || event.entity_id !== expectedEntityId
    || event.revision !== expectedRevision
  ) {
    throw new TeamMemoryError(
      "corrupt_state",
      `memory event path does not match its entity snapshot: ${normalized}`,
    );
  }
  return event;
}

export function recoverEntityFromEvent(
  cwd: string,
  event: MemoryMutationEvent,
  options: MemoryStoreOptions | undefined,
  repaired: string[],
): void {
  const relativeCurrent = currentRelativePath(event.after);
  const absoluteCurrent = path.join(repositoryRoot(cwd), ...relativeCurrent.split("/"));
  let current: AgentIdentity | MemoryRecord | null = null;
  try {
    const parsed = readJsonFile(absoluteCurrent, relativeCurrent);
    if ("agent_id" in event.after) {
      current = validateIdentitySemantics(
        validateSchema<AgentIdentity>(AgentIdentitySchema, parsed, "agent identity"),
      );
    } else {
      current = validateRecordSemantics(
        validateSchema<MemoryRecord>(MemoryRecordSchema, parsed, "memory record"),
      );
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && !(error instanceof TeamMemoryError)) throw error;
    current = null;
  }
  if (current && current.revision > event.revision) {
    throw new TeamMemoryError(
      "corrupt_state",
      `${relativeCurrent} is ahead of its immutable event history`,
    );
  }
  if (
    current
    && current.revision === event.revision
    && current.content_digest !== event.after_digest
  ) {
    throw new TeamMemoryError(
      "corrupt_state",
      `${relativeCurrent} conflicts with immutable event revision ${event.revision}`,
    );
  }
  if (!current || current.revision < event.revision) {
    writeJsonAtomic(cwd, relativeCurrent, event.after, options);
    repaired.push(relativeCurrent);
  }
}

export function latestEventsByEntity(cwd: string): Map<string, MemoryMutationEvent> {
  const grouped = new Map<string, MemoryMutationEvent[]>();
  for (const relativePath of [
    ...historyEventFiles(cwd, "agents"),
    ...historyEventFiles(cwd, "memory"),
  ]) {
    const event = readMutationEvent(cwd, relativePath);
    if (event.entity_type === "memory_record" && event.actor !== "knowledge-maintainer") {
      throw new TeamMemoryError(
        "policy_violation",
        `memory event ${event.entity_id}@${event.revision} was not written by the knowledge-maintainer role`,
      );
    }
    if (
      event.entity_type === "agent_identity"
      && "agent_id" in event.after
      && (event.after.role === "specialist" || event.revision > 1)
      && event.actor !== "knowledge-maintainer"
    ) {
      throw new TeamMemoryError(
        "policy_violation",
        `agent event ${event.entity_id}@${event.revision} was not written by the knowledge-maintainer role`,
      );
    }
    const key = `${event.entity_type}:${event.entity_id}`;
    const events = grouped.get(key) ?? [];
    events.push(event);
    grouped.set(key, events);
  }

  const latest = new Map<string, MemoryMutationEvent>();
  for (const [key, events] of grouped) {
    events.sort((left, right) => left.revision - right.revision);
    let previous: MemoryMutationEvent | null = null;
    for (const event of events) {
      if (previous === null) {
        if (event.revision !== 1 || event.before_digest !== null) {
          throw new TeamMemoryError(
            "corrupt_state",
            `${key} event history must begin at revision 1 with no before digest`,
          );
        }
        const allowedFirst = event.entity_type === "agent_identity"
          ? event.operation === "create"
          : event.operation === "accept";
        if (!allowedFirst) {
          throw new TeamMemoryError(
            "corrupt_state",
            `${key} history begins with invalid ${event.operation} operation`,
          );
        }
      } else {
        if (event.revision !== previous.revision + 1) {
          throw new TeamMemoryError(
            "corrupt_state",
            `${key} event history is not contiguous at revision ${event.revision}`,
          );
        }
        if (event.before_digest !== previous.after_digest) {
          throw new TeamMemoryError(
            "corrupt_state",
            `${key} event history digest chain breaks at revision ${event.revision}`,
          );
        }
        if (event.entity_type === "agent_identity") {
          if (!("agent_id" in previous.after) || !("agent_id" in event.after)) {
            throw new TeamMemoryError("corrupt_state", `${key} changes entity type across revisions`);
          }
          if (
            event.after.role !== previous.after.role
            || event.after.created_at !== previous.after.created_at
            || event.after.read_only !== previous.after.read_only
            || event.after.write_authority !== previous.after.write_authority
            || event.after.github_write_authority !== previous.after.github_write_authority
          ) {
            throw new TeamMemoryError(
              "corrupt_state",
              `${key} changes immutable identity fields at revision ${event.revision}`,
            );
          }
        } else {
          if (!("memory_id" in previous.after) || !("memory_id" in event.after)) {
            throw new TeamMemoryError("corrupt_state", `${key} changes entity type across revisions`);
          }
          if (
            event.after.kind !== previous.after.kind
            || event.after.owning_agent_id !== previous.after.owning_agent_id
            || event.after.created_at !== previous.after.created_at
            || event.after.semantic_digest !== previous.after.semantic_digest
          ) {
            throw new TeamMemoryError(
              "corrupt_state",
              `${key} changes immutable memory semantics at revision ${event.revision}`,
            );
          }
        }
        if (Date.parse(event.occurred_at) < Date.parse(previous.occurred_at)) {
          throw new TeamMemoryError(
            "corrupt_state",
            `${key} event timestamps move backwards at revision ${event.revision}`,
          );
        }
        if (event.operation === "create" || event.operation === "accept") {
          throw new TeamMemoryError(
            "corrupt_state",
            `${key} repeats initial operation ${event.operation} at revision ${event.revision}`,
          );
        }
      }
      previous = event;
    }
    latest.set(key, events[events.length - 1]!);
  }
  return latest;
}

export function isTeamMemoryManagedPath(relativePath: string): boolean {
  const normalized = normalizeMemoryRepositoryPath(relativePath);
  return isTeamMemoryVisiblePath(normalized) || isTeamMemoryOperationalPath(normalized);
}
