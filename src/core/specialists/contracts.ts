import type {
  EvidenceReference,
  MemoryConfidence,
  MemoryFreshness,
  MemoryRecord,
  MemorySourceType,
} from "../memory/schema.ts";
import type { MemoryStoreOptions } from "../memory/contracts.ts";

export const SPECIALIST_PORTFOLIO_SCHEMA_VERSION = "1" as const;
export const MAX_DISCOVERED_SPECIALISTS = 8;
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
  | "expert_evidence"
  | "feature_agent"
  | "suggested_domain"
  | "structural_evidence";

export interface SpecialistDefinition {
  specialist_id: string;
  display_name: string;
  domain: string;
  purpose: string;
  owned_paths: string[];
  observed_paths: string[];
  contracts: string[];
  patterns: string[];
  pitfalls: string[];
  related_specialists: string[];
  validation_commands: string[];
  evidence_paths: string[];
  freshness_dependencies: string[];
  supporting_commit: string;
  freshness: MemoryFreshness;
  confidence: MemoryConfidence;
  source_kinds: SpecialistSourceKind[];
  discovery_score: number;
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
  | "owned_path"
  | "observed_path"
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
