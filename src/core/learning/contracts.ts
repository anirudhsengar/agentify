import type {
  EvidenceReference,
  MemoryCandidateDraft,
  MemoryRecord,
} from "../memory/schema.ts";
import type { MemoryStoreOptions } from "../memory/contracts.ts";
import type {
  ExpertiseInvalidationReport,
  SpecialistPortfolio,
} from "../specialists/contracts.ts";

export const LEARNING_SCHEMA_VERSION = "1" as const;
export const MAX_LEARNING_CHANGED_FILES = 256;
export const MAX_LEARNING_CANDIDATES = 32;
export const MAX_LEARNING_ATTEMPTS = 16;
export const MAX_LEARNING_REVIEW_FEEDBACK = 32;
export const MAX_RECONCILIATION_COMMITS = 32;
export const DEFAULT_LEARNING_RUNTIME_MS = 5 * 60 * 1000;

export type AcceptedChangeAuthorKind = "agentify" | "human" | "unknown";
export type MergeChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied";
export type LearningRiskCategory = "low" | "medium" | "high" | "critical";

export interface AcceptedMergeEvent {
  schema_version: typeof LEARNING_SCHEMA_VERSION;
  repository_id: string;
  default_branch: string;
  accepted_commit: string;
  first_parent_commit: string;
  expected_repository_head: string;
  pull_request_number: number | null;
  issue_number: number | null;
  pull_request_url: string | null;
  actor: string;
  author_kind: AcceptedChangeAuthorKind;
  accepted_at: string;
}

export interface AcceptedMergeChange {
  status: MergeChangeStatus;
  path: string;
  previous_path: string | null;
}

export interface AcceptedValidationEvidence {
  commands: string[];
  passed: boolean;
  evidence_refs: string[];
}

export interface AcceptedReviewFeedback {
  actor: string;
  source_ref: string;
  accepted_at: string;
  statement: string;
}

export interface AcceptedTaskAttempt {
  sequence: number;
  approach: string;
  result: "succeeded" | "failed" | "cancelled";
  failure_category: string | null;
  signal: string;
  correction: string | null;
}

export interface AcceptedTaskEvidence {
  schema_version: typeof LEARNING_SCHEMA_VERSION;
  task_id: string;
  issue_number: number | null;
  pull_request_number: number | null;
  issue_url: string | null;
  plan_digest: string | null;
  selected_specialist_ids: string[];
  selected_procedure_ids: string[];
  risk_category: LearningRiskCategory;
  validation: AcceptedValidationEvidence;
  review_feedback: AcceptedReviewFeedback[];
  attempts: AcceptedTaskAttempt[];
  generalization: "task_local" | "candidate" | "generalized";
  cost_usd: number | null;
  runtime_ms: number | null;
  source_artifact_url: string | null;
}

export interface LearningPolicy {
  max_changed_files: number;
  max_candidates: number;
  max_attempts: number;
  max_review_feedback: number;
  max_runtime_ms: number;
}

export interface LearningRuntimeOptions {
  now?: () => Date;
  memory?: MemoryStoreOptions;
  /** Test seam invoked after one named learning phase completes. */
  afterPhase?: (phase: MergeLearningPhase) => void;
}

export type MergeLearningPhase =
  | "bound"
  | "assessed"
  | "invalidated"
  | "candidates-accepted"
  | "specialists-refreshed"
  | "recorded";

export interface ProcessAcceptedMergeInput {
  cwd: string;
  event: AcceptedMergeEvent;
  task_evidence?: AcceptedTaskEvidence | null;
  candidate_drafts?: ReadonlyArray<MemoryCandidateDraft>;
  policy?: Partial<LearningPolicy>;
  options?: LearningRuntimeOptions;
}

export interface LearningInvalidationResult {
  stale_memory_ids: string[];
  already_inactive_memory_ids: string[];
  expertise: ExpertiseInvalidationReport;
}

export interface AcceptedLearningCandidateResult {
  candidate_id: string;
  memory_id: string;
  kind: MemoryRecord["kind"];
  owning_agent_id: string;
  status: "accepted" | "already-accepted";
}

export interface MergeLearningMetrics {
  changed_file_count: number;
  candidate_count: number;
  stale_memory_count: number;
  accepted_memory_count: number;
  elapsed_ms: number;
  cost_usd: number | null;
}

export interface MergeLearningReport {
  schema_version: typeof LEARNING_SCHEMA_VERSION;
  status: "processed" | "already-processed" | "knowledge-only";
  event_digest: string;
  accepted_commit: string;
  expected_repository_head: string;
  changes: AcceptedMergeChange[];
  invalidation: LearningInvalidationResult;
  candidates: AcceptedLearningCandidateResult[];
  specialist_sync: "not-requested" | "map-absent" | "memory-absent" | "synchronized";
  learning_run_memory_id: string;
  metrics: MergeLearningMetrics;
}

export interface MergeLearningJournal {
  format: "agentify_merge_learning_transaction";
  schema_version: typeof LEARNING_SCHEMA_VERSION;
  event_digest: string;
  accepted_commit: string;
  expected_repository_head: string;
  repository_id: string;
  phase: MergeLearningPhase;
  started_at: string;
  updated_at: string;
  journal_digest: string;
}

export interface LearningContextRequest {
  candidate_paths?: ReadonlyArray<string>;
  specialist_ids?: ReadonlyArray<string>;
  include_inactive?: boolean;
  max_records?: number;
}

export interface LearningContextResult {
  records: MemoryRecord[];
  evidence: EvidenceReference[];
  selected_specialist_ids: string[];
}

export interface ReconciliationInput {
  cwd: string;
  repository_id: string;
  default_branch: string;
  max_commits?: number;
  options?: LearningRuntimeOptions;
}

export interface ReconciliationReport {
  considered_commits: string[];
  processed: MergeLearningReport[];
  skipped_commits: string[];
}

export interface LearningAssessment {
  event_digest: string;
  changes: AcceptedMergeChange[];
  evidence: EvidenceReference[];
  portfolio: SpecialistPortfolio | null;
  invalidation: ExpertiseInvalidationReport;
  affected_memory: MemoryRecord[];
  generated_candidates: MemoryCandidateDraft[];
  knowledge_only: boolean;
}
