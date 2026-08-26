import {
  type CreateAgentIdentityInput,
  TeamMemoryError,
  type UpdateAgentIdentityInput,
} from "../contracts.ts";
import {
  agentIdentityPath,
  agentIdentityRelativePath,
  validateMemoryId,
} from "../paths.ts";
import {
  acquireStoreLock,
  errorCode,
  historyRelativePath,
  persistVersionedEntityInternal,
  readMutationEvent,
  readRelativeJson,
  readTeamMemoryManifest,
  refreshManifestInternal,
  repositoryRoot,
} from "../persistence.ts";
import {
  type AgentIdentity,
  AgentIdentitySchema,
  type MemoryKind,
  type MemoryMutationEvent,
  type MemoryRecord,
} from "../schema.ts";
import {
  canonicalJson,
  contentDigestForIdentity,
  normalizeEvidence,
  sortedUniqueStrings,
} from "../serialization.ts";
import {
  assertNonEmpty,
  assertRoleMemoryKinds,
  makeIdentity,
  nowIso,
  validateIdentitySemantics,
  validateSchema,
} from "../validation.ts";
import {
  assertInitializedForMutation,
  KNOWLEDGE_MAINTAINER_ID,
  validateWriteEvidence,
} from "./shared.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export function assertKnowledgeMaintainerAuthority(cwd: string, actor: string): string {
  const normalizedActor = assertNonEmpty(actor, "memory mutation actor");
  if (normalizedActor !== KNOWLEDGE_MAINTAINER_ID) {
    throw new TeamMemoryError(
      "policy_violation",
      `durable memory decisions require the ${KNOWLEDGE_MAINTAINER_ID} role`,
    );
  }
  const identity = readAgentIdentity(cwd, KNOWLEDGE_MAINTAINER_ID);
  if (identity.role !== "knowledge_maintainer" || identity.status !== "active") {
    throw new TeamMemoryError(
      "policy_violation",
      "the knowledge-maintainer identity is not active",
    );
  }
  return normalizedActor;
}

export function createAgentIdentity(
  input: CreateAgentIdentityInput,
): AgentIdentity {
  assertInitializedForMutation(input.cwd);
  return acquireStoreLock(input.cwd, input.options, () => {
    readTeamMemoryManifest(input.cwd);
    const actor = assertKnowledgeMaintainerAuthority(input.cwd, input.actor);
    if (input.role !== "specialist") {
      throw new TeamMemoryError(
        "policy_violation",
        "fixed team roles are created only during trusted initialization; createAgentIdentity accepts specialists only",
      );
    }
    const evidence = validateWriteEvidence(
      input.cwd,
      input.evidence,
      input.supportingCommit,
      input.options,
      `agent ${input.agentId}`,
    );
    const timestamp = nowIso(input.options);
    const identity = makeIdentity({
      agentId: input.agentId,
      role: input.role,
      displayName: input.displayName,
      domain: input.domain,
      memoryKinds: input.memoryKinds,
      supportingCommit: input.supportingCommit,
      evidence,
    }, timestamp);
    const currentPath = agentIdentityPath(input.cwd, identity);
    if (fs.existsSync(currentPath)) {
      throw new TeamMemoryError("already_exists", `agent identity already exists: ${input.agentId}`);
    }
    persistVersionedEntityInternal(
      input.cwd,
      identity,
      "create",
      actor,
      `create persistent ${input.role} identity`,
      timestamp,
      null,
      input.options,
    );
    refreshManifestInternal(input.cwd, input.options);
    return identity;
  });
}

export function candidateIdentityPaths(cwd: string, agentId: string): string[] {
  validateMemoryId(agentId, "agent ID");
  const possible = agentId === "orchestrator"
    ? [".agentify/agents/orchestrator.json"]
    : [
        `.agentify/agents/roles/${agentId}.json`,
        `.agentify/agents/specialists/${agentId}.json`,
      ];
  return possible.filter((relativePath) =>
    fs.existsSync(path.join(repositoryRoot(cwd), ...relativePath.split("/")))
  );
}

export function assertCurrentEntityMatchesImmutableHistory(
  cwd: string,
  entity: AgentIdentity | MemoryRecord,
): void {
  let event: MemoryMutationEvent;
  try {
    event = readMutationEvent(cwd, historyRelativePath(entity));
  } catch (error) {
    if (
      error instanceof TeamMemoryError
      && error.code === "not_found"
      && entity.revision === 1
      && readTeamMemoryManifest(cwd).history_mode === "snapshot-v1"
    ) return;
    throw error;
  }
  const entityType = "agent_id" in entity ? "agent_identity" : "memory_record";
  const entityId = "agent_id" in entity ? entity.agent_id : entity.memory_id;
  if (
    event.entity_type !== entityType
    || event.entity_id !== entityId
    || event.revision !== entity.revision
    || event.after_digest !== entity.content_digest
    || canonicalJson(event.after) !== canonicalJson(entity)
  ) {
    throw new TeamMemoryError(
      "corrupt_state",
      `${entityType} ${entityId} is not backed by its immutable revision ${entity.revision}`,
    );
  }
}

export function readAgentIdentity(cwd: string, agentId: string): AgentIdentity {
  const candidates = candidateIdentityPaths(cwd, agentId);
  if (candidates.length === 0) {
    throw new TeamMemoryError("not_found", `agent identity not found: ${agentId}`);
  }
  if (candidates.length > 1) {
    throw new TeamMemoryError("corrupt_state", `agent identity exists at multiple paths: ${agentId}`);
  }
  const parsed = readRelativeJson(cwd, candidates[0]!);
  const identity = validateSchema<AgentIdentity>(AgentIdentitySchema, parsed, "agent identity");
  if (identity.agent_id !== agentId) {
    throw new TeamMemoryError("corrupt_state", `agent identity path does not match ${agentId}`);
  }
  const validated = validateIdentitySemantics(identity);
  assertCurrentEntityMatchesImmutableHistory(cwd, validated);
  return validated;
}

export function listAgentIdentities(cwd: string): AgentIdentity[] {
  readTeamMemoryManifest(cwd);
  const paths: string[] = [];
  const orchestratorPath = ".agentify/agents/orchestrator.json";
  if (fs.existsSync(path.join(repositoryRoot(cwd), ...orchestratorPath.split("/")))) {
    paths.push(orchestratorPath);
  }
  for (const directory of [".agentify/agents/roles", ".agentify/agents/specialists"]) {
    const absolute = path.join(repositoryRoot(cwd), ...directory.split("/"));
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
      paths.push(`${directory}/${entry.name}`);
    }
  }
  return paths
    .sort((left, right) => left.localeCompare(right))
    .map((relativePath) => {
      const parsed = validateSchema<AgentIdentity>(
        AgentIdentitySchema,
        readRelativeJson(cwd, relativePath),
        "agent identity",
      );
      if (agentIdentityRelativePath(parsed.role, parsed.agent_id) !== relativePath) {
        throw new TeamMemoryError(
          "corrupt_state",
          `agent identity path does not match ${parsed.agent_id}`,
        );
      }
      const identity = validateIdentitySemantics(parsed);
      assertCurrentEntityMatchesImmutableHistory(cwd, identity);
      return identity;
    });
}

export function updateAgentIdentity(
  cwd: string,
  agentId: string,
  input: UpdateAgentIdentityInput,
): AgentIdentity {
  assertInitializedForMutation(cwd);
  return acquireStoreLock(cwd, input.options, () => {
    readTeamMemoryManifest(cwd);
    const actor = assertKnowledgeMaintainerAuthority(cwd, input.actor);
    const current = readAgentIdentity(cwd, agentId);
    if (current.revision !== input.expectedRevision) {
      throw new TeamMemoryError(
        "revision_conflict",
        `agent ${agentId} revision conflict: expected ${input.expectedRevision}, found ${current.revision}`,
      );
    }
    if (input.status === "retired" && current.role !== "specialist") {
      throw new TeamMemoryError(
        "policy_violation",
        `fixed ${current.role} identity ${current.agent_id} cannot be retired`,
      );
    }
    if (input.memoryKinds !== undefined && current.role !== "specialist") {
      throw new TeamMemoryError(
        "policy_violation",
        `fixed ${current.role} identity ${current.agent_id} memory ownership cannot be changed`,
      );
    }
    if (input.memoryKinds !== undefined) {
      assertRoleMemoryKinds(current.role, input.memoryKinds, `agent ${current.agent_id}`);
    }
    const newEvidence = validateWriteEvidence(
      cwd,
      input.evidence,
      input.supportingCommit,
      input.options,
      `agent ${agentId} update`,
    );
    if (input.memoryKinds !== undefined) {
      const requestedKinds = sortedUniqueStrings(input.memoryKinds) as MemoryKind[];
      if (canonicalJson(requestedKinds) !== canonicalJson(current.memory_kinds)) {
        if (current.role !== "specialist") {
          throw new TeamMemoryError(
            "policy_violation",
            `fixed ${current.role} identity memory ownership cannot be changed`,
          );
        }
        const attributedPolicyEvidence = newEvidence.some((entry) =>
          (entry.source_type === "maintainer_instruction"
            || entry.source_type === "architecture_decision")
          && entry.actor !== null
        );
        if (!attributedPolicyEvidence) {
          throw new TeamMemoryError(
            "policy_violation",
            "changing specialist memory kinds requires attributed maintainer or architecture evidence",
          );
        }
      }
    }
    const timestamp = nowIso(input.options);
    const { content_digest: _currentDigest, ...currentWithoutDigest } = current;
    const withoutDigest: Omit<AgentIdentity, "content_digest"> = {
      ...currentWithoutDigest,
      revision: current.revision + 1,
      display_name: input.displayName?.trim() ?? current.display_name,
      domain: input.domain === undefined ? current.domain : input.domain?.trim() || null,
      status: input.status ?? current.status,
      memory_kinds: input.memoryKinds
        ? sortedUniqueStrings(input.memoryKinds) as MemoryKind[]
        : current.memory_kinds,
      supporting_commit: input.supportingCommit,
      evidence: normalizeEvidence([...current.evidence, ...newEvidence]),
      updated_at: timestamp,
    };
    const next: AgentIdentity = {
      ...withoutDigest,
      content_digest: contentDigestForIdentity(withoutDigest),
    };
    validateSchema<AgentIdentity>(AgentIdentitySchema, next, "agent identity");
    validateIdentitySemantics(next);
    persistVersionedEntityInternal(
      cwd,
      next,
      "update",
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
