import type {
  EvidenceReference,
  MemoryConfidence,
  MemoryFreshness,
  MemoryRecord,
  MemorySourceType,
} from "../memory/schema.ts";
import type { MemoryStoreOptions } from "../memory/contracts.ts";

export const SPECIALIST_PORTFOLIO_SCHEMA_VERSION = "1" as const;
export const MAX_DISCOVERED_PROCEDURES = 64;
export const MAX_ROUTED_SPECIALISTS = 4;
export const MAX_ROUTED_PROCEDURES = 6;

export const SPECIALIST_READ_ONLY_EXECUTION_POLICY = {
  mode: "read_only",
  builtin_tools: ["read", "grep", "find", "ls"],
  shell: "denied",
  filesystem_writes: "denied",
  github_write: "none",
} as const;

export interface SpecialistExecutionPolicy {
  mode: "read_only";
  builtin_tools: readonly ["read", "grep", "find", "ls"];
  shell: "denied";
  filesystem_writes: "denied";
  github_write: "none";
}

export type SpecialistSourceKind =
  | "concern_evidence"
  | "legacy_expert_evidence";

export type TouchpointCentrality = "core" | "supporting" | "peripheral";

/**
 * One observed location a concern reaches.
 *
 * Touchpoints are deliberately not an ownership claim. The same file is
 * expected to appear under several specialists with a different `role` in
 * each: authentication and checkout both touch the request middleware, for
 * entirely different reasons. `role` records the reason, which is the part a
 * specialist actually needs.
 */
export interface SpecialistTouchpoint {
  path: string;
  symbol: string | null;
  role: string;
  line_range: [number, number] | null;
  centrality: TouchpointCentrality;
}

/** One end-to-end trace through a concern, entry point through effect. */
export interface SpecialistFlow {
  name: string;
  description: string;
  steps: Array<{ path: string; what_happens: string }>;
}

export interface SpecialistInvariant {
  rule: string;
  why: string;
  reference: string;
}

export interface SpecialistPitfall {
  risk: string;
  consequence: string;
  reference: string;
}

/**
 * A persistent specialist in one concern.
 *
 * A specialist is defined by what it knows, not by where it lives. There is no
 * owned territory here: `context_paths` is a derived read-scope for bounding a
 * consultation session, computed from the concern's own touchpoints and flow
 * steps. Two specialists sharing a path is normal and carries no meaning.
 */
export interface SpecialistDefinition {
  specialist_id: string;
  display_name: string;
  concern: string;
  one_line: string;
  covers: string;
  excludes: string;
  flows: SpecialistFlow[];
  touchpoints: SpecialistTouchpoint[];
  invariants: SpecialistInvariant[];
  pitfalls: SpecialistPitfall[];
  entry_questions: string[];
  related_specialists: string[];
  validation_commands: string[];
  /** Verified tracked paths this specialist is grounded in. Derived. */
  evidence_paths: string[];
  /** Read scope for a bounded consultation. Derived from touchpoints and flows. */
  context_paths: string[];
  /** Distinct top-level areas the concern reaches. Evidence of scatter, not scope. */
  spans_subtrees: string[];
  freshness_dependencies: string[];
  supporting_commit: string;
  freshness: MemoryFreshness;
  confidence: MemoryConfidence;
  source_kinds: SpecialistSourceKind[];
  execution_policy: SpecialistExecutionPolicy;
}

export interface ProcedureDefinition {
  procedure_id: string;
  name: string;
  purpose: string;
  owner_specialist_id: string | null;
  trigger_conditions: string[];
  required_context_paths: string[];
  allowed_commands: string[];
  expected_file_patterns: string[];
  side_effects: string[];
  validation_commands: string[];
  recovery_steps: string[];
  evidence_paths: string[];
  freshness_dependencies: string[];
  supporting_commit: string;
  freshness: MemoryFreshness;
  confidence: MemoryConfidence;
  source_kind:
    | "custom_tool"
    | "skill_candidate"
    | "area_template"
    | "domain_validation"
    | "repository_validation";
}

export interface SpecialistPortfolio {
  schema_version: typeof SPECIALIST_PORTFOLIO_SCHEMA_VERSION;
  supporting_commit: string;
  source_map_digest: string;
  evidence_paths: string[];
  specialists: SpecialistDefinition[];
  procedures: ProcedureDefinition[];
  warnings: string[];
}

export type RoutingRiskCategory = "low" | "medium" | "high" | "critical";

export interface SpecialistRoutingRequest {
  task_description: string;
  candidate_paths?: ReadonlyArray<string>;
  changed_files?: ReadonlyArray<string>;
  contracts?: ReadonlyArray<string>;
  risk_category?: RoutingRiskCategory;
  prior_successful_specialist_ids?: ReadonlyArray<string>;
  max_specialists?: number;
  max_procedures?: number;
}

export type RoutingReasonKind =
  | "concern_match"
  | "touchpoint"
  | "context_path"
  | "contract"
  | "task_signal"
  | "risk_signal"
  | "prior_success"
  | "procedure_trigger"
  | "procedure_context";

export interface RoutingReason {
  kind: RoutingReasonKind;
  signal: string;
  weight: number;
}

export interface SpecialistRoutingSelection {
  specialist_id: string;
  score: number;
  reasons: RoutingReason[];
}

export interface ProcedureRoutingSelection {
  procedure_id: string;
  score: number;
  reasons: RoutingReason[];
}

export interface SpecialistRoutingReport {
  task_digest: string;
  selected_specialists: SpecialistRoutingSelection[];
  selected_procedures: ProcedureRoutingSelection[];
  unmatched_signals: string[];
}

export interface ExpertiseInvalidationReport {
  specialist_ids: string[];
  procedure_ids: string[];
  reasons: Record<string, string[]>;
}

export interface MaterializeSpecialistPortfolioInput {
  cwd: string;
  portfolio: SpecialistPortfolio;
  actor: "knowledge-maintainer";
  source_type?: Exclude<MemorySourceType, "maintainer_instruction" | "architecture_decision">;
  observed_at?: string;
  evidence_actor?: string | null;
  options?: MemoryStoreOptions;
}

export interface MaterializedPortfolioResult {
  created_specialist_ids: string[];
  updated_specialist_ids: string[];
  unchanged_specialist_ids: string[];
  retired_specialist_ids: string[];
  stale_procedure_memory_ids: string[];
  specialist_memory: MemoryRecord[];
  procedure_memory: MemoryRecord[];
  evidence: EvidenceReference[];
}
