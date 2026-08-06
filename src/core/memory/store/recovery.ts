import {
  type MemoryStoreOptions,
  TeamMemoryError,
  type TeamMemoryRecoveryResult,
} from "../contracts.ts";
import {
  TEAM_MEMORY_IGNORE_RELATIVE,
  TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE,
  TEAM_MEMORY_MANIFEST_RELATIVE,
} from "../paths.ts";
import {
  acquireStoreLock,
  assertRootEntriesSafe,
  assertVisibleLayout,
  candidateDecisionFiles,
  directoryEntriesIfPresent,
  errorCode,
  latestEventsByEntity,
  readCandidateDecisionIfPresent,
  readInitializationJournalIfPresent,
  readManifestIfPresent,
  readRelativeJson,
  readTeamMemoryManifest,
  recognizableVisibleStateExistsWithoutManifest,
  recoverEntityFromEvent,
  refreshManifestInternal,
  removeInitializationJournal,
  removeRuntimeCandidate,
  repositoryRoot,
  resolveExistingSafeFile,
  LEGACY_TEAM_IGNORE_CONTENT,
  TEAM_IGNORE_CONTENT,
  writeCandidateDecisionInternal,
  writeTextAtomic,
} from "../persistence.ts";
import {
  validateEvidenceProvenance,
} from "../provenance.ts";
import {
  type AgentIdentity,
  AgentIdentitySchema,
  type AgentRole,
  type CandidateDecisionEvent,
  type MemoryMutationEvent,
  type MemoryRecord,
} from "../schema.ts";
import {
  sha256Hex,
  sortedUniqueStrings,
} from "../serialization.ts";
import {
  assertCandidateMaterializedInRecord,
  validateIdentitySemantics,
  validateSchema,
} from "../validation.ts";
import {
  readPersistedMemoryCandidate,
} from "./candidates.ts";
import {
  listAgentIdentities,
} from "./identities.ts";
import {
  materializeTeamMemoryInitialization,
} from "./initialization.ts";
import {
  currentMemoryRecordPaths,
  listMemoryRecordsInternal,
  readMemoryRecordAtPath,
} from "./records.ts";
import {
  KNOWLEDGE_MAINTAINER_ID,
} from "./shared.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export function validateCandidateDecisionState(
  cwd: string,
  latest: ReadonlyMap<string, MemoryMutationEvent>,
  options?: MemoryStoreOptions,
): void {
  const records = listMemoryRecordsInternal(cwd);
  const bindings = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    for (const candidateId of record.accepted_candidate_ids) {
      const containing = bindings.get(candidateId) ?? [];
      containing.push(record);
      bindings.set(candidateId, containing);
    }
  }
  for (const [candidateId, containing] of bindings) {
    if (containing.length !== 1) {
      throw new TeamMemoryError(
        "corrupt_state",
        `accepted candidate ${candidateId} is bound to multiple memory records: ${containing.map((record) => record.memory_id).sort().join(", ")}`,
      );
    }
  }

  const decisions = new Map<string, CandidateDecisionEvent>();
  for (const relativePath of candidateDecisionFiles(cwd)) {
    const candidateId = path.posix.basename(relativePath, ".json");
    const event = readCandidateDecisionIfPresent(cwd, candidateId);
    if (!event) {
      throw new TeamMemoryError("corrupt_state", `candidate decision disappeared: ${candidateId}`);
    }
    if (event.actor !== KNOWLEDGE_MAINTAINER_ID) {
      throw new TeamMemoryError(
        "policy_violation",
        `candidate decision ${candidateId} was not made by the knowledge-maintainer role`,
      );
    }
    decisions.set(candidateId, event);
    const containing = bindings.get(candidateId) ?? [];
    if (event.decision === "accepted") {
      if (containing.length !== 1 || containing[0]!.memory_id !== event.resulting_memory_id) {
        throw new TeamMemoryError(
          "corrupt_state",
          `accepted candidate ${candidateId} is not bound to its resulting memory`,
        );
      }
      assertCandidateMaterializedInRecord(event.candidate, containing[0]!);
    } else if (containing.length > 0) {
      throw new TeamMemoryError(
        "corrupt_state",
        `rejected candidate ${candidateId} appears in memory ${containing[0]!.memory_id}`,
      );
    }
    try {
      const candidate = readPersistedMemoryCandidate(cwd, candidateId);
      if (candidate.candidate_digest !== event.candidate_digest) {
        throw new TeamMemoryError(
          "corrupt_state",
          `runtime candidate ${candidateId} differs from its durable decision`,
        );
      }
      removeRuntimeCandidate(cwd, candidateId);
    } catch (error) {
      if (!(error instanceof TeamMemoryError) || error.code !== "not_found") throw error;
    }
  }

  for (const entry of directoryEntriesIfPresent(cwd, ".agentify/runtime/candidates")) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new TeamMemoryError(
        "unsafe_path",
        `.agentify/runtime/candidates contains unsupported entry ${entry.name}`,
      );
    }
    const candidateId = entry.name.slice(0, -".json".length);
    if (decisions.has(candidateId)) continue;
    const candidate = readPersistedMemoryCandidate(cwd, candidateId);
    validateEvidenceProvenance(cwd, candidate.evidence, options);
    const containing = bindings.get(candidateId) ?? [];
    if (containing.length === 0) continue;
    if (containing.length !== 1) {
      throw new TeamMemoryError(
        "corrupt_state",
        `accepted candidate ${candidateId} is bound to multiple memory records`,
      );
    }
    const record = containing[0]!;
    const mutation = latest.get(`memory_record:${record.memory_id}`);
    if (!mutation) {
      throw new TeamMemoryError(
        "corrupt_state",
        `accepted candidate ${candidateId} has no immutable memory mutation`,
      );
    }
    if (mutation.actor !== KNOWLEDGE_MAINTAINER_ID) {
      throw new TeamMemoryError(
        "policy_violation",
        `accepted candidate ${candidateId} was not applied by the knowledge-maintainer role`,
      );
    }
    const decision = writeCandidateDecisionInternal(
      cwd,
      candidate,
      "accepted",
      mutation.actor,
      `recovered interrupted candidate decision: ${mutation.reason}`,
      record.memory_id,
      mutation.occurred_at,
    );
    decisions.set(candidateId, decision);
    removeRuntimeCandidate(cwd, candidateId);
  }

  for (const [candidateId, containing] of bindings) {
    const decision = decisions.get(candidateId)
      ?? readCandidateDecisionIfPresent(cwd, candidateId);
    if (!decision) {
      throw new TeamMemoryError(
        "corrupt_state",
        `memory ${containing[0]!.memory_id} retains accepted candidate ${candidateId} without an immutable decision`,
      );
    }
    if (
      decision.decision !== "accepted"
      || decision.resulting_memory_id !== containing[0]!.memory_id
    ) {
      throw new TeamMemoryError(
        "corrupt_state",
        `accepted candidate ${candidateId} decision does not match memory ${containing[0]!.memory_id}`,
      );
    }
  }
}

export function validateCurrentEntitiesHaveHistory(
  cwd: string,
  latest: ReadonlyMap<string, MemoryMutationEvent>,
): void {
  for (const relativePath of currentMemoryRecordPaths(cwd)) {
    const record = readMemoryRecordAtPath(cwd, relativePath);
    const event = latest.get(`memory_record:${record.memory_id}`);
    if (!event || event.revision !== record.revision || event.after_digest !== record.content_digest) {
      throw new TeamMemoryError(
        "corrupt_state",
        `memory ${record.memory_id} is not backed by matching immutable history`,
      );
    }
  }
  for (const relativePath of [
    ".agentify/agents/orchestrator.json",
    ".agentify/agents/roles",
    ".agentify/agents/specialists",
  ]) {
    const absolute = path.join(repositoryRoot(cwd), ...relativePath.split("/"));
    let files: string[] = [];
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new TeamMemoryError("unsafe_path", `${relativePath} is a symlink`);
      if (stat.isFile()) files = [relativePath];
      else if (stat.isDirectory()) {
        files = fs.readdirSync(absolute, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => `${relativePath}/${entry.name}`);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      const identity = validateIdentitySemantics(
        validateSchema<AgentIdentity>(
          AgentIdentitySchema,
          readRelativeJson(cwd, file),
          "agent identity",
        ),
      );
      const event = latest.get(`agent_identity:${identity.agent_id}`);
      if (!event || event.revision !== identity.revision || event.after_digest !== identity.content_digest) {
        throw new TeamMemoryError(
          "corrupt_state",
          `agent identity ${identity.agent_id} is not backed by matching immutable history`,
        );
      }
    }
  }
}

export function validateRequiredTeamState(cwd: string): void {
  let ignore: string;
  try {
    ignore = fs.readFileSync(resolveExistingSafeFile(cwd, TEAM_MEMORY_IGNORE_RELATIVE), "utf-8");
  } catch (error) {
    if (error instanceof TeamMemoryError && error.code === "not_found") {
      throw new TeamMemoryError(
        "corrupt_state",
        `${TEAM_MEMORY_IGNORE_RELATIVE} is missing`,
      );
    }
    throw error;
  }
  if (ignore !== TEAM_IGNORE_CONTENT) {
    throw new TeamMemoryError(
      "corrupt_state",
      `${TEAM_MEMORY_IGNORE_RELATIVE} does not contain canonical exclusions`,
    );
  }
  const required: ReadonlyArray<readonly [string, AgentRole]> = [
    ["orchestrator", "orchestrator"],
    ["builder", "builder"],
    ["reviewer", "reviewer"],
    ["knowledge-maintainer", "knowledge_maintainer"],
  ];
  const identities = listAgentIdentities(cwd);
  const byId = new Map(identities.map((identity) => [identity.agent_id, identity]));
  for (const [agentId, role] of required) {
    const identity = byId.get(agentId);
    if (!identity || identity.role !== role || identity.status !== "active") {
      throw new TeamMemoryError(
        "corrupt_state",
        `team memory is missing active required ${role} identity ${agentId}`,
      );
    }
  }
  for (const record of listMemoryRecordsInternal(cwd)) {
    const owner = byId.get(record.owning_agent_id);
    if (!owner) {
      throw new TeamMemoryError(
        "corrupt_state",
        `memory ${record.memory_id} refers to missing owner ${record.owning_agent_id}`,
      );
    }
    if (!owner.memory_kinds.includes(record.kind)) {
      throw new TeamMemoryError(
        "policy_violation",
        `memory ${record.memory_id} kind ${record.kind} is outside owner ${owner.agent_id} policy`,
      );
    }
  }
}

export function recoverTeamMemoryStoreInternal(
  cwd: string,
  options?: MemoryStoreOptions,
): TeamMemoryRecoveryResult {
  const manifest = readTeamMemoryManifest(cwd);
  const repaired: string[] = [];
  const ignorePath = resolveExistingSafeFile(cwd, TEAM_MEMORY_IGNORE_RELATIVE);
  const ignore = fs.readFileSync(ignorePath, "utf-8");
  if (ignore === LEGACY_TEAM_IGNORE_CONTENT) {
    const entry = manifest.entries.find((candidate) => candidate.path === TEAM_MEMORY_IGNORE_RELATIVE);
    const legacyBytes = Buffer.byteLength(LEGACY_TEAM_IGNORE_CONTENT, "utf-8");
    if (
      entry?.kind !== "ignore_rules"
      || entry.bytes !== legacyBytes
      || entry.sha256 !== sha256Hex(LEGACY_TEAM_IGNORE_CONTENT)
    ) {
      throw new TeamMemoryError(
        "corrupt_state",
        "legacy Agentify ignore rules are not attested by the memory manifest",
      );
    }
    writeTextAtomic(cwd, TEAM_MEMORY_IGNORE_RELATIVE, TEAM_IGNORE_CONTENT, options);
    repaired.push(TEAM_MEMORY_IGNORE_RELATIVE);
  }
  assertVisibleLayout(cwd);
  const latest = latestEventsByEntity(cwd);
  for (const event of latest.values()) {
    recoverEntityFromEvent(cwd, event, options, repaired);
  }
  validateCurrentEntitiesHaveHistory(cwd, latest);
  validateRequiredTeamState(cwd);
  validateCandidateDecisionState(cwd, latest, options);
  const initializationJournal = readInitializationJournalIfPresent(cwd);
  if (initializationJournal) {
    if (initializationJournal.repository_id !== manifest.repository_id) {
      throw new TeamMemoryError(
        "corrupt_state",
        "team-memory initialization journal repository does not match the committed manifest",
      );
    }
    removeInitializationJournal(cwd);
    repaired.push(TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE);
  }
  const refreshed = refreshManifestInternal(cwd, options);
  if (refreshed.revision !== manifest.revision) repaired.push(TEAM_MEMORY_MANIFEST_RELATIVE);
  return {
    status: repaired.length > 0 ? "recovered" : "valid",
    repaired: sortedUniqueStrings(repaired),
    manifest: refreshed,
  };
}

export function recoverTeamMemoryStore(
  cwd: string,
  options?: MemoryStoreOptions,
): TeamMemoryRecoveryResult {
  const manifest = readManifestIfPresent(cwd);
  if (!manifest) {
    const pending = readInitializationJournalIfPresent(cwd);
    if (pending) {
      return acquireStoreLock(cwd, options, () => {
        const currentManifest = readManifestIfPresent(cwd);
        if (currentManifest) {
          removeInitializationJournal(cwd);
          return recoverTeamMemoryStoreInternal(cwd, options);
        }
        const currentJournal = readInitializationJournalIfPresent(cwd);
        if (!currentJournal) {
          throw new TeamMemoryError(
            "corrupt_state",
            "team-memory initialization journal disappeared during recovery",
          );
        }
        const recoveredManifest = materializeTeamMemoryInitialization(
          cwd,
          currentJournal,
          options,
        );
        return {
          status: "recovered",
          repaired: [
            TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE,
            TEAM_MEMORY_MANIFEST_RELATIVE,
          ],
          manifest: recoveredManifest,
        };
      });
    }
    if (recognizableVisibleStateExistsWithoutManifest(cwd)) {
      throw new TeamMemoryError(
        "corrupt_state",
        ".agentify contains recognizable team memory state without a valid manifest",
      );
    }
    return { status: "absent", repaired: [], manifest: null };
  }
  assertRootEntriesSafe(cwd);
  return acquireStoreLock(cwd, options, () => recoverTeamMemoryStoreInternal(cwd, options));
}
