import {
  type MemoryStoreOptions,
  TeamMemoryError,
} from "../contracts.ts";
import {
  readManifestIfPresent,
} from "../persistence.ts";
import {
  validateEvidenceProvenance,
} from "../provenance.ts";
import {
  type AgentRole,
  type EvidenceReference,
  type MemoryKind,
  type TeamMemoryManifest,
} from "../schema.ts";
import {
  normalizeEvidence,
} from "../serialization.ts";
import {
  assertEvidenceSemantics,
} from "../validation.ts";

export const KNOWLEDGE_MAINTAINER_ID = "knowledge-maintainer";

export const DEFAULT_IDENTITIES: ReadonlyArray<{
  agentId: string;
  role: AgentRole;
  displayName: string;
  domain: string | null;
  memoryKinds: MemoryKind[];
}> = [
  {
    agentId: "orchestrator",
    role: "orchestrator",
    displayName: "Repository Orchestrator",
    domain: null,
    memoryKinds: ["codebase", "procedure", "episode", "specialist", "orchestrator", "policy"],
  },
  {
    agentId: "builder",
    role: "builder",
    displayName: "Task Builder",
    domain: null,
    memoryKinds: ["codebase", "procedure", "episode", "specialist", "policy"],
  },
  {
    agentId: "reviewer",
    role: "reviewer",
    displayName: "Automated Read-only Reviewer",
    domain: null,
    memoryKinds: ["codebase", "procedure", "episode", "specialist", "policy"],
  },
  {
    agentId: "knowledge-maintainer",
    role: "knowledge_maintainer",
    displayName: "Knowledge Maintainer",
    domain: null,
    memoryKinds: ["codebase", "procedure", "episode", "specialist", "orchestrator", "policy"],
  },
];

export function validateWriteEvidence(
  cwd: string,
  evidenceInput: ReadonlyArray<EvidenceReference>,
  supportingCommit: string,
  options: MemoryStoreOptions | undefined,
  label: string,
): EvidenceReference[] {
  const evidence = normalizeEvidence(evidenceInput);
  assertEvidenceSemantics(evidence, label);
  if (!evidence.some((entry) => entry.commit_sha === supportingCommit)) {
    throw new TeamMemoryError(
      "invalid_input",
      `${label} must include evidence for supporting commit ${supportingCommit}`,
    );
  }
  validateEvidenceProvenance(cwd, evidence, options);
  return evidence;
}

export function assertInitializedForMutation(cwd: string): TeamMemoryManifest {
  const manifest = readManifestIfPresent(cwd);
  if (manifest === null) {
    throw new TeamMemoryError("not_initialized", "team memory is not initialized");
  }
  return manifest;
}
