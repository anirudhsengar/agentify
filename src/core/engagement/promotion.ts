import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import { EngagementError } from "./errors.ts";
import { engagementArtifactPath } from "./paths.ts";
import { readEngagement, writeEngagementJsonAtomic, type EngagementStateOptions } from "./state.ts";
import { AUTONOMY_LEVELS, PromotionPolicySchema, PromotionStateSchema, type AutonomyLevel, type PromotionActuals, type PromotionConditions, type PromotionPolicy, type PromotionRecord, type PromotionState } from "./schema/promotion.ts";

const SUPPORTED_LEVELS = new Set<AutonomyLevel>(["observe", "draft"]);
const SAFETY_KEYS = new Set(["maximum_forbidden_action_failures", "maximum_security_failures", "required_rollback_test", "required_escalation_test", "no_unresolved_critical_risks"]);
export function promotionStatePath(stateDir: string, engagementId: string): string { return path.join(path.dirname(engagementArtifactPath(stateDir, engagementId, "charter.json")), "promotion-state.json"); }
export function promotionReportPath(stateDir: string, engagementId: string): string { return path.join(path.dirname(engagementArtifactPath(stateDir, engagementId, "charter.json")), "reports", "promotion.md"); }
function index(level: AutonomyLevel): number { return AUTONOMY_LEVELS.indexOf(level); }
export function assertPromotionTransition(current: AutonomyLevel, candidate: AutonomyLevel): void {
  if (candidate === "policy_auto") throw new EngagementError("invalid_artifact", "policy_auto is unsupported");
  if (index(candidate) !== index(current) + 1) throw new EngagementError("invalid_artifact", `promotion must advance exactly one level: ${current} -> ${candidate}`);
}
export function createPromotionState(policy: PromotionPolicy): PromotionState {
  if (!Value.Check(PromotionPolicySchema, policy)) throw new EngagementError("invalid_artifact", "promotion policy failed schema validation");
  assertPromotionTransition(policy.current_level, policy.candidate_level);
  if (index(policy.rollback_level) > index(policy.current_level)) throw new EngagementError("invalid_artifact", "rollback level cannot exceed current level");
  return { schema_version: "1", revision: 1, engagement_id: policy.engagement_id, policy, records: [] };
}
export function readPromotionState(stateDir: string, engagementId: string): PromotionState {
  let parsed: unknown; try { parsed = JSON.parse(fs.readFileSync(promotionStatePath(stateDir, engagementId), "utf8")); } catch (error) { throw new EngagementError((error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "corrupt_state", "cannot read promotion state", { cause: error }); }
  if (!Value.Check(PromotionStateSchema, parsed) || (parsed as PromotionState).engagement_id !== engagementId) throw new EngagementError("corrupt_state", "promotion state is schema-invalid");
  return parsed as PromotionState;
}
function compare(name: keyof PromotionConditions, required: unknown, actual: unknown): boolean {
  if (typeof required === "boolean") return actual === required;
  if (typeof required === "string") return actual === required;
  if (typeof required !== "number" || typeof actual !== "number") return false;
  return name.startsWith("minimum_") || name === "required_human_reviews" ? actual >= required : actual <= required;
}
const ACTUAL_KEY: Record<keyof PromotionConditions, keyof PromotionActuals> = {
  minimum_eligible_tasks: "eligible_tasks", minimum_pass_at_1: "pass_at_1", minimum_repeated_run_consistency: "repeated_run_consistency",
  maximum_major_rework_rate: "major_rework_rate", maximum_forbidden_action_failures: "forbidden_action_failures", maximum_security_failures: "security_failures",
  maximum_cost_usd: "cost_usd", maximum_runtime_ms: "runtime_ms", required_human_reviews: "human_reviews", required_business_owner: "business_owner",
  required_technical_owner: "technical_owner", required_rollback_test: "rollback_test_passed", required_escalation_test: "escalation_test_passed",
  required_monitoring: "monitoring_active", required_risk_register_status: "risk_register_status", required_approval_checkpoint: "approval_checkpoint_passed",
  no_unresolved_critical_risks: "unresolved_critical_risks",
};
export function evaluatePromotion(policy: PromotionPolicy, actuals: PromotionActuals, timestamp: string, approvedBy: string | null = null): PromotionRecord {
  assertPromotionTransition(policy.current_level, policy.candidate_level);
  const passed: string[] = [], failed: string[] = [], missing: string[] = [], safety: string[] = [];
  for (const key of Object.keys(policy.required_conditions).sort() as (keyof PromotionConditions)[]) {
    const required = policy.required_conditions[key], actual = actuals[ACTUAL_KEY[key]];
    if (actual === undefined) { missing.push(key); continue; }
    const ok = key === "no_unresolved_critical_risks" ? required === true && actual === 0 : compare(key, required, actual);
    (ok ? passed : failed).push(key); if (!ok && SAFETY_KEYS.has(key)) safety.push(key);
  }
  const expired = policy.expires_at !== undefined && Date.parse(timestamp) >= Date.parse(policy.expires_at);
  let decision: PromotionRecord["decision"] = expired ? "expired" : missing.length ? "insufficient_evidence" : failed.length ? "rejected" : "approved";
  if (approvedBy === null && decision === "approved") { decision = "insufficient_evidence"; missing.push("human_approval"); }
  if (decision === "approved" && !SUPPORTED_LEVELS.has(policy.candidate_level)) { decision = "rejected"; failed.push("candidate_level_supported"); }
  const reasons = expired ? ["promotion policy has expired"] : [...safety.map((v) => `safety condition failed: ${v}`), ...failed.map((v) => `condition failed: ${v}`), ...missing.map((v) => `missing evidence: ${v}`)];
  if (reasons.length === 0) reasons.push("all configured conditions and explicit human approval passed");
  return { record_id: crypto.createHash("sha256").update(`${policy.engagement_id}\0${policy.policy_version}\0${timestamp}\0${decision}`).digest("hex"), engagement_id: policy.engagement_id, workflow_id: policy.workflow_id, current_level: policy.current_level, candidate_level: policy.candidate_level, requested_by: policy.requested_by, approved_by: approvedBy, timestamp, evidence_run_ids: policy.evidence_run_ids, required_conditions: policy.required_conditions, actual_condition_results: actuals, decision, reasons, expires_at: policy.expires_at ?? null, review_at: policy.review_at ?? null, rollback_level: policy.rollback_level, policy_version: policy.policy_version, passed_requirements: passed, failed_requirements: failed, missing_evidence: missing, safety_blockers: safety };
}
export function appendPromotionRecord(stateDir: string, state: PromotionState, record: PromotionRecord, expectedRevision: number, options?: EngagementStateOptions): PromotionState {
  const current = readPromotionState(stateDir, state.engagement_id); if (current.revision !== expectedRevision) throw new EngagementError("revision_conflict", `promotion revision conflict: expected ${expectedRevision}, found ${current.revision}`);
  if (current.records.some(({ record_id }) => record_id === record.record_id)) throw new EngagementError("already_exists", "promotion record already exists");
  const next = { ...current, revision: current.revision + 1, records: [...current.records, record] }; writeEngagementJsonAtomic(promotionStatePath(stateDir, state.engagement_id), next, options); return next;
}
export function currentAutonomyLevel(state: PromotionState, now = new Date()): AutonomyLevel {
  let level: AutonomyLevel = state.policy.current_level; for (const record of state.records) { if (record.decision === "approved") level = record.expires_at && Date.parse(record.expires_at) <= now.getTime() ? record.rollback_level : record.candidate_level; else if (record.decision === "expired" || record.decision === "revoked") level = record.rollback_level; } return level;
}
export function revokePromotion(stateDir: string, state: PromotionState, actor: string, timestamp: string, reason: string): PromotionState {
  const latestControlRecord = [...state.records].reverse().find((record) => record.decision === "approved" || record.decision === "revoked");
  if (!latestControlRecord || latestControlRecord.decision !== "approved") throw new EngagementError("invalid_transition", "no active approved promotion exists to revoke");
  const level = currentAutonomyLevel(state, new Date(timestamp)); const record: PromotionRecord = { record_id: crypto.randomUUID(), engagement_id: state.engagement_id, workflow_id: state.policy.workflow_id, current_level: level, candidate_level: level, requested_by: state.policy.requested_by, approved_by: actor, timestamp, evidence_run_ids: [], required_conditions: {}, actual_condition_results: {}, decision: "revoked", reasons: [reason], expires_at: null, review_at: state.policy.review_at ?? null, rollback_level: state.policy.rollback_level, policy_version: state.policy.policy_version, passed_requirements: [], failed_requirements: [], missing_evidence: [], safety_blockers: [] }; return appendPromotionRecord(stateDir, state, record, state.revision);
}
export function assertEngagementPromotable(stateDir: string, engagementId: string): void { const charter = readEngagement(stateDir, engagementId); if (charter.status === "completed" || charter.status === "stopped") throw new EngagementError("invalid_transition", `terminal engagement ${charter.status} cannot be promoted`); }
export function renderPromotionReport(state: PromotionState, record?: PromotionRecord): string { const latest = record ?? state.records.at(-1); const list = (items: readonly string[]) => items.length ? items.map((v) => `- ${v}`).join("\n") : "- none"; const requirements = Object.entries(state.policy.required_conditions).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}: ${JSON.stringify(value)}`); return `# Promotion report\n\nCurrent level: ${currentAutonomyLevel(state)}\nCandidate level: ${state.policy.candidate_level}\nPolicy version: ${state.policy.policy_version}\nExecution policy: ${state.policy.execution_policy_mode} (unchanged)\n\n## Requirements\n${list(requirements)}\n\n## Passed requirements\n${list(latest?.passed_requirements ?? [])}\n\n## Failed requirements\n${list(latest?.failed_requirements ?? [])}\n\n## Missing evidence\n${list(latest?.missing_evidence ?? [])}\n\n## Safety blockers\n${list(latest?.safety_blockers ?? [])}\n\n## Human approvals\n${latest?.approved_by ? `- ${latest.approved_by}` : "- none"}\n\nFinal decision: ${latest?.decision ?? "not evaluated"}\n\n## Rollback instructions\nRevoke explicitly to return to ${state.policy.rollback_level}; this command does not change GitHub behavior.\n`; }
