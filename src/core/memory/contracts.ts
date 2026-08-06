import type {
  AgentIdentity,
  EvidenceReference,
  MemoryFreshness,
  MemoryKind,
  MemoryRecord,
  TeamMemoryManifest,
} from "./schema.ts";

export type TeamMemoryErrorCode =
  | "not_initialized"
  | "invalid_input"
  | "unsafe_path"
  | "already_exists"
  | "not_found"
  | "revision_conflict"
  | "lock_conflict"
  | "corrupt_state"
  | "capacity_exceeded"
  | "policy_violation"
  | "persistence_failed";

export class TeamMemoryError extends Error {
  readonly code: TeamMemoryErrorCode;

  constructor(code: TeamMemoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TeamMemoryError";
    this.code = code;
  }
}

export interface EvidenceProvenanceContext {
  cwd: string;
  evidence: ReadonlyArray<EvidenceReference>;
}

export interface MemoryStoreOptions {
  now?: () => Date;
  staleLockMs?: number;
  /** Test seam invoked after the initialization journal is durable. */
  afterInitializationJournalWrite?: (journalPath: string) => void;
  /** Test seam invoked after an immutable history event is durable. */
  afterHistoryWrite?: (eventPath: string, currentPath: string) => void;
  /** Test seam invoked after the temporary current file is durable and before rename. */
  beforeCurrentRename?: (temporaryPath: string, currentPath: string) => void;
  /** Test-only seam. Production callers must use the default Git provenance verifier. */
  provenanceVerifier?: (context: EvidenceProvenanceContext) => void;
}

export interface InitializeTeamMemoryInput {
  cwd: string;
  repositoryId: string;
  supportingCommit: string;
  evidence: ReadonlyArray<EvidenceReference>;
  actor?: string;
  options?: MemoryStoreOptions;
}

export interface CreateAgentIdentityInput {
  cwd: string;
  agentId: string;
  role: "specialist";
  displayName: string;
  domain?: string | null;
  memoryKinds: ReadonlyArray<MemoryKind>;
  supportingCommit: string;
  evidence: ReadonlyArray<EvidenceReference>;
  actor: string;
  options?: MemoryStoreOptions;
}

export interface UpdateAgentIdentityInput {
  displayName?: string;
  domain?: string | null;
  status?: "active" | "retired";
  memoryKinds?: ReadonlyArray<MemoryKind>;
  supportingCommit: string;
  evidence: ReadonlyArray<EvidenceReference>;
  actor: string;
  reason: string;
  expectedRevision: number;
  options?: MemoryStoreOptions;
}

export interface MemoryMutationInput {
  actor: string;
  expectedRevision: number;
  evidence: ReadonlyArray<EvidenceReference>;
  supportingCommit: string;
  reason: string;
  options?: MemoryStoreOptions;
}

export interface MemoryQuery {
  kind?: MemoryKind;
  owningAgentId?: string;
  path?: string;
  domain?: string;
  taskId?: string;
  evidenceId?: string;
  freshness?: MemoryFreshness;
  tag?: string;
}

export interface TeamMemoryRecoveryResult {
  status: "absent" | "valid" | "recovered";
  repaired: string[];
  manifest: TeamMemoryManifest | null;
}

export interface AgentMemoryView {
  as_of: string;
  identity: AgentIdentity;
  records: MemoryRecord[];
}

export interface CompactMemoryResult {
  kept: string[];
  superseded: string[];
}
