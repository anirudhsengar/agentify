import * as path from "node:path";
import type { AgentIdentity, AgentRole, MemoryKind } from "./schema.ts";

export const TEAM_MEMORY_ROOT_RELATIVE = ".agentify";
export const TEAM_MEMORY_MANIFEST_RELATIVE = ".agentify/manifest.json";
export const TEAM_MEMORY_IGNORE_RELATIVE = ".agentify/.gitignore";
export const TEAM_MEMORY_RUNTIME_RELATIVE = ".agentify/runtime";
export const TEAM_MEMORY_HISTORY_RELATIVE = ".agentify/history";
export const TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE =
  ".agentify/state-transactions/team-memory-initialization.json";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function validateMemoryId(value: string, label = "memory ID"): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`${label} is not valid URI text: ${value}`);
  }
  if (
    !SAFE_ID.test(value)
    || decoded !== value
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || path.isAbsolute(value)
  ) {
    throw new Error(
      `${label} must be 1-128 lowercase ASCII letters, numbers, dots, underscores, or hyphens without path syntax`,
    );
  }
  return value;
}

export function normalizeMemoryRepositoryPath(value: string, label = "repository path"): string {
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must be repository-relative: ${value}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} cannot contain control characters`);
  }
  const slashNormalized = value.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashNormalized);
  if (
    normalized === ""
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || normalized.startsWith("/")
  ) {
    throw new Error(`${label} escapes the repository: ${value}`);
  }
  return normalized;
}

export function teamMemoryRoot(cwd: string): string {
  return path.join(path.resolve(cwd), TEAM_MEMORY_ROOT_RELATIVE);
}

export function teamMemoryManifestPath(cwd: string): string {
  return path.join(path.resolve(cwd), TEAM_MEMORY_MANIFEST_RELATIVE);
}

export function teamMemoryIgnorePath(cwd: string): string {
  return path.join(path.resolve(cwd), TEAM_MEMORY_IGNORE_RELATIVE);
}

export function teamMemoryRuntimePath(cwd: string, ...segments: string[]): string {
  return path.join(path.resolve(cwd), TEAM_MEMORY_RUNTIME_RELATIVE, ...segments);
}

export function teamMemoryHistoryPath(cwd: string, ...segments: string[]): string {
  return path.join(path.resolve(cwd), TEAM_MEMORY_HISTORY_RELATIVE, ...segments);
}

export function teamMemoryInitializationJournalPath(cwd: string): string {
  return path.join(path.resolve(cwd), TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE);
}

const FIXED_ROLE_AGENT_IDS: Readonly<Partial<Record<AgentRole, string>>> = {
  orchestrator: "orchestrator",
  builder: "builder",
  reviewer: "reviewer",
  knowledge_maintainer: "knowledge-maintainer",
};

export function agentIdentityRelativePath(
  role: AgentRole,
  agentId: string,
): string {
  validateMemoryId(agentId, "agent ID");
  const fixedId = FIXED_ROLE_AGENT_IDS[role];
  if (fixedId !== undefined && agentId !== fixedId) {
    throw new Error(`${role} identity must use the stable agent ID ${fixedId}`);
  }
  if (role === "specialist" && Object.values(FIXED_ROLE_AGENT_IDS).includes(agentId)) {
    throw new Error(`specialist identity cannot use reserved agent ID ${agentId}`);
  }
  if (role === "orchestrator") return ".agentify/agents/orchestrator.json";
  if (role === "specialist") return `.agentify/agents/specialists/${agentId}.json`;
  return `.agentify/agents/roles/${agentId}.json`;
}

export function agentIdentityPath(cwd: string, identity: Pick<AgentIdentity, "role" | "agent_id">): string {
  return path.join(path.resolve(cwd), agentIdentityRelativePath(identity.role, identity.agent_id));
}

const MEMORY_KIND_DIRECTORY: Readonly<Record<MemoryKind, string>> = {
  codebase: "knowledge/codebase",
  procedure: "knowledge/procedures",
  episode: "knowledge/episodes",
  specialist: "knowledge/specialists",
  orchestrator: "knowledge/orchestrator",
  policy: "policies",
};

export function memoryRecordRelativePath(kind: MemoryKind, memoryId: string): string {
  validateMemoryId(memoryId);
  return `.agentify/${MEMORY_KIND_DIRECTORY[kind]}/${memoryId}.json`;
}

export function memoryRecordPath(cwd: string, kind: MemoryKind, memoryId: string): string {
  return path.join(path.resolve(cwd), memoryRecordRelativePath(kind, memoryId));
}

function paddedRevision(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999_999_999_999) {
    throw new Error(`memory revision is outside the supported range: ${revision}`);
  }
  return revision.toString().padStart(12, "0");
}

export function identityHistoryRelativePath(agentId: string, revision: number): string {
  validateMemoryId(agentId, "agent ID");
  return `.agentify/history/agents/${agentId}/${paddedRevision(revision)}.json`;
}

export function memoryHistoryRelativePath(memoryId: string, revision: number): string {
  validateMemoryId(memoryId);
  return `.agentify/history/memory/${memoryId}/${paddedRevision(revision)}.json`;
}

export function candidateDecisionRelativePath(candidateId: string): string {
  validateMemoryId(candidateId, "candidate ID");
  return `.agentify/history/candidates/${candidateId}.json`;
}

export function runtimeCandidateRelativePath(candidateId: string): string {
  validateMemoryId(candidateId, "candidate ID");
  return `.agentify/runtime/candidates/${candidateId}.json`;
}

export function storeLockRelativePath(): string {
  return ".agentify/runtime/locks/store.lock";
}

export function isTeamMemoryVisiblePath(relativePath: string): boolean {
  const normalized = normalizeMemoryRepositoryPath(relativePath);
  return normalized === TEAM_MEMORY_IGNORE_RELATIVE
    || normalized === TEAM_MEMORY_MANIFEST_RELATIVE
    || normalized.startsWith(".agentify/agents/")
    || normalized.startsWith(".agentify/knowledge/")
    || normalized.startsWith(".agentify/policies/")
    || normalized.startsWith(".agentify/history/");
}

export function isTeamMemoryOperationalPath(relativePath: string): boolean {
  const normalized = normalizeMemoryRepositoryPath(relativePath);
  return normalized.startsWith(".agentify/runtime/")
    || normalized.startsWith(".agentify/state-transactions/");
}

export const TEAM_MEMORY_ROOT_ALLOWED_ENTRIES = new Set([
  ".gitignore",
  "manifest.json",
  "agents",
  "knowledge",
  "policies",
  "history",
  "runtime",
  "state-transactions",
]);
