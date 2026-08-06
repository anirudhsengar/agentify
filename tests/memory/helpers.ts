import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initializeTeamMemoryStore,
  type EvidenceReference,
  type MemoryCandidateDraft,
  type MemorySourceType,
  type MemoryStoreOptions,
} from "../../src/core/memory/index.ts";

export const TEST_PROVENANCE_VERIFIER: NonNullable<MemoryStoreOptions["provenanceVerifier"]> = () => {};

export function testMemoryOptions(
  overrides: MemoryStoreOptions = {},
): MemoryStoreOptions {
  return { provenanceVerifier: TEST_PROVENANCE_VERIFIER, ...overrides };
}

export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);
export const DIGEST_A = "c".repeat(64);
export const DIGEST_B = "d".repeat(64);

export function evidence(
  id: string,
  commit = COMMIT_A,
  source: MemorySourceType = "validated_bootstrap",
): EvidenceReference {
  return {
    evidence_id: id,
    source_type: source,
    repository_path: `src/${id}.ts`,
    commit_sha: commit,
    sha256: commit === COMMIT_A ? DIGEST_A : DIGEST_B,
    line_start: 1,
    line_end: 2,
    external_ref: null,
    description: `Evidence for ${id}`,
    observed_at: "2026-07-30T00:00:00.000Z",
    actor: "maintainer",
  };
}

export function tempRepo(prefix: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  return cwd;
}

export function initialize(cwd: string): void {
  initializeTeamMemoryStore({
    cwd,
    repositoryId: "owner/repo",
    supportingCommit: COMMIT_A,
    evidence: [evidence("bootstrap")],
    options: testMemoryOptions({ now: () => new Date("2026-07-30T00:00:00.000Z") }),
  });
}

export type CodebaseMemoryCandidateDraft = Extract<MemoryCandidateDraft, { kind: "codebase" }>;
export type PolicyMemoryCandidateDraft = Extract<MemoryCandidateDraft, { kind: "policy" }>;

export function codebaseCandidate(
  candidateId: string,
  memoryId: string,
  commit = COMMIT_A,
): CodebaseMemoryCandidateDraft {
  return {
    schema_version: "1",
    candidate_id: candidateId,
    memory_id: memoryId,
    kind: "codebase",
    proposed_by_agent_id: "orchestrator",
    owning_agent_id: "orchestrator",
    statement: `${memoryId} statement`,
    source_type: "validated_bootstrap",
    supporting_commit: commit,
    evidence: [evidence(candidateId, commit)],
    confidence: "verified",
    dependent_paths: [`src/${memoryId}.ts`],
    invalidation_conditions: [`src/${memoryId}.ts changes`],
    contradicts: [],
    human_attribution: null,
    tags: ["codebase"],
    proposed_at: "2026-07-30T00:01:00.000Z",
    payload: {
      subject: memoryId,
      paths: [`src/${memoryId}.ts`],
      symbols: [memoryId],
      contracts: [`${memoryId} contract`],
      relationships: [],
      validation_commands: ["npm test"],
    },
  };
}

export function policyCandidate(candidateId: string, memoryId: string): PolicyMemoryCandidateDraft {
  return {
    schema_version: "1",
    candidate_id: candidateId,
    memory_id: memoryId,
    kind: "policy",
    proposed_by_agent_id: "knowledge-maintainer",
    owning_agent_id: "knowledge-maintainer",
    statement: "Production dependencies require explicit maintainer approval.",
    source_type: "maintainer_instruction",
    supporting_commit: COMMIT_A,
    evidence: [evidence(candidateId, COMMIT_A, "maintainer_instruction")],
    confidence: "verified",
    dependent_paths: ["package.json"],
    invalidation_conditions: ["maintainer policy changes"],
    contradicts: [],
    human_attribution: {
      actor: "maintainer",
      source_ref: "issue:149",
      accepted_at: "2026-07-30T03:00:00.000Z",
    },
    tags: ["dependency", "policy"],
    proposed_at: "2026-07-30T03:00:00.000Z",
    payload: {
      policy_key: "dependency-approval",
      rule: "Production dependencies require explicit maintainer approval.",
      protected_paths: ["package.json", "package-lock.json"],
      allowed_tools: [],
      forbidden_actions: ["silent dependency installation"],
      approval_required: true,
      numeric_limit: null,
      unit: null,
    },
  };
}
