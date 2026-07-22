import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import type { EvalFailureCategory } from "./failure-taxonomy.ts";
import type { GraderResult } from "./schema/grader-result.ts";
import { HumanReviewSchema, type HumanReview } from "./schema/human-review.ts";
import type { EvalTask } from "./schema/task.ts";
import type { GraderAdapter, ImportedTrialArtifact } from "./runner.ts";

export const SUPPORTED_EVAL_GRADERS = ["deterministic", "outcome", "process", "economics", "human_review"] as const;
type SupportedGrader = typeof SUPPORTED_EVAL_GRADERS[number];
type GraderOutput = ReturnType<GraderAdapter>;
interface TraceEntry { tool_category: string; action: string; path?: string; evidence_reference?: string; approval_reference?: string; escalation_reference?: string }
export interface EvalArtifactFacts {
  repository_root?: string; modified_paths?: string[]; diff_lines?: number; dependency_files_changed?: string[];
  command_results?: Array<{ command_id: string; category: "test" | "typecheck" | "lint" | "approved"; exit_status: number }>;
  schema_results?: Record<string, boolean>; artifact_references?: string[];
  outcome_results?: Record<string, "met" | "not_met" | "unknown">; trace?: TraceEntry[];
  retry_count?: number; repeated_action_count?: number; human_review?: HumanReview;
  accepted_outcome_count?: number;
}
type Check =
  | { type: "file_exists" | "file_absent" | "required_artifact" | "schema_validation"; value: string }
  | { type: "allowed_paths" | "forbidden_paths"; values: string[] }
  | { type: "command_status"; command_id: string; category: "test" | "typecheck" | "lint" | "approved"; expected_exit_status: number }
  | { type: "diff_size"; maximum_lines: number }
  | { type: "dependency_changes"; allowed: boolean };

function facts(artifact: ImportedTrialArtifact): EvalArtifactFacts { return artifact.facts ?? {}; }
function result(status: GraderResult["status"], reason: string, categories: EvalFailureCategory[], evidence: string[], started: number, score: number | null, confidence: number | null): GraderOutput {
  return { grader_version: "1", status, passed: status === "pass" ? true : status === "fail" ? false : null, score, reason, failure_categories: categories, evidence_references: evidence, error: status === "error" ? reason : null, duration_ms: Math.max(0, Date.now() - started), confidence };
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function patternsMatch(value: string, patterns: readonly string[]): boolean {
  const normalized = value.split(path.sep).join("/");
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
    return new RegExp(`^${escaped}$`).test(normalized);
  });
}
function safeRepositoryPath(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error(`grader path must be repository-relative: ${relative}`);
  const resolvedRoot = path.resolve(root); const resolved = path.resolve(root, relative); const back = path.relative(resolvedRoot, resolved);
  if (back.startsWith("..") || path.isAbsolute(back)) throw new Error(`grader path escapes repository: ${relative}`);
  return resolved;
}
function parseChecks(value: unknown): Check[] {
  if (!isObject(value) || !Array.isArray(value.checks)) throw new Error("deterministic grader config requires checks[]");
  return value.checks.map((candidate) => {
    if (!isObject(candidate) || typeof candidate.type !== "string") throw new Error("invalid deterministic check");
    const type = candidate.type;
    if (["file_exists", "file_absent", "required_artifact", "schema_validation"].includes(type) && typeof candidate.value === "string") return { type, value: candidate.value } as Check;
    if (["allowed_paths", "forbidden_paths"].includes(type) && Array.isArray(candidate.values) && candidate.values.every((item) => typeof item === "string")) return { type, values: candidate.values } as Check;
    if (type === "command_status" && typeof candidate.command_id === "string" && ["test", "typecheck", "lint", "approved"].includes(String(candidate.category)) && Number.isInteger(candidate.expected_exit_status)) return candidate as unknown as Check;
    if (type === "diff_size" && typeof candidate.maximum_lines === "number" && candidate.maximum_lines >= 0) return { type, maximum_lines: candidate.maximum_lines };
    if (type === "dependency_changes" && typeof candidate.allowed === "boolean") return { type, allowed: candidate.allowed };
    throw new Error(`unsupported deterministic check '${type}'; raw command strings are never accepted`);
  });
}

export function deterministicGrader(task: EvalTask, artifact: ImportedTrialArtifact): GraderOutput {
  const started = Date.now(); const config = task.grader_configuration.deterministic; const checks = parseChecks(config); const data = facts(artifact);
  const failures: string[] = []; const categories = new Set<EvalFailureCategory>(); const modified = data.modified_paths ?? [];
  for (const check of checks) {
    if (check.type === "file_exists" || check.type === "file_absent") {
      if (!data.repository_root) throw new Error(`${check.type} requires repository_root`);
      const exists = fs.existsSync(safeRepositoryPath(data.repository_root, check.value));
      if ((check.type === "file_exists" && !exists) || (check.type === "file_absent" && exists)) { failures.push(`${check.type}: ${check.value}`); categories.add("test_failure"); }
    } else if (check.type === "allowed_paths") {
      const bad = modified.filter((item) => !patternsMatch(item, check.values)); if (bad.length) { failures.push(`modified paths outside allowlist: ${bad.join(", ")}`); categories.add("incorrect_scope"); }
    } else if (check.type === "forbidden_paths") {
      const bad = modified.filter((item) => patternsMatch(item, check.values)); if (bad.length) { failures.push(`forbidden paths modified: ${bad.join(", ")}`); categories.add("unsafe_action"); }
    } else if (check.type === "command_status") {
      const found = data.command_results?.find((item) => item.command_id === check.command_id && item.category === check.category);
      if (!found || found.exit_status !== check.expected_exit_status) { failures.push(`${check.category} status missing or unexpected: ${check.command_id}`); categories.add(check.category === "test" || check.category === "typecheck" || check.category === "lint" ? "test_failure" : "wrong_tool"); }
    } else if (check.type === "schema_validation" && data.schema_results?.[check.value] !== true) { failures.push(`schema validation failed: ${check.value}`); categories.add("test_failure"); }
    else if (check.type === "required_artifact" && !data.artifact_references?.includes(check.value)) { failures.push(`required artifact missing: ${check.value}`); categories.add("incomplete_task"); }
    else if (check.type === "diff_size" && (data.diff_lines === undefined || data.diff_lines > check.maximum_lines)) { failures.push("diff size missing or exceeds limit"); categories.add("incorrect_scope"); }
    else if (check.type === "dependency_changes" && !check.allowed && (data.dependency_files_changed?.length ?? 0) > 0) { failures.push("dependency files changed"); categories.add("incorrect_scope"); }
  }
  return result(failures.length ? "fail" : "pass", failures.join("; ") || "all deterministic checks passed", [...categories], artifact.output_references, started, failures.length ? 0 : 1, 1);
}

export function outcomeGrader(task: EvalTask, artifact: ImportedTrialArtifact): GraderOutput {
  const started = Date.now(); const outcomes = facts(artifact).outcome_results ?? {}; const failed = [...task.expected_outcomes.filter((item) => outcomes[item] === "not_met"), ...task.forbidden_outcomes.filter((item) => outcomes[item] === "met")];
  if (failed.length) return result("fail", `outcome checks failed: ${failed.join("; ")}`, ["incomplete_task"], artifact.output_references, started, 0, 1);
  const unknown = [...task.expected_outcomes, ...task.forbidden_outcomes].filter((item) => outcomes[item] === undefined || outcomes[item] === "unknown");
  if (unknown.length) return result("human_required", `outcomes require human review: ${unknown.join("; ")}`, [], artifact.output_references, started, null, null);
  return result("pass", "all expected and forbidden outcomes were deterministically verified", [], artifact.output_references, started, 1, 1);
}

export function processGrader(task: EvalTask, artifact: ImportedTrialArtifact): GraderOutput {
  const started = Date.now(); const config = task.grader_configuration.process; if (!isObject(config)) throw new Error("process grader config must be an object");
  const trace = facts(artifact).trace; if (!trace?.length) return result("fail", "structured audit trail is missing", ["missing_context"], [], started, 0, 1);
  const failures: string[] = []; const categories = new Set<EvalFailureCategory>();
  const requiredEvidence = Array.isArray(config.required_evidence) ? config.required_evidence.filter((x): x is string => typeof x === "string") : [];
  for (const evidence of requiredEvidence) if (!trace.some((entry) => entry.evidence_reference === evidence)) { failures.push(`missing evidence: ${evidence}`); categories.add("missing_context"); }
  const requiredTools = Array.isArray(config.required_tool_categories) ? config.required_tool_categories.filter((x): x is string => typeof x === "string") : [];
  for (const tool of requiredTools) if (!trace.some((entry) => entry.tool_category === tool)) { failures.push(`required tool category missing: ${tool}`); categories.add("wrong_tool"); }
  for (const escalation of task.required_escalations) if (!trace.some((entry) => entry.escalation_reference === escalation)) { failures.push(`required escalation missing: ${escalation}`); categories.add("failed_escalation"); }
  if (trace.some((entry) => task.forbidden_outcomes.includes(entry.action))) { failures.push("forbidden action attempted"); categories.add("unsafe_action"); }
  if (config.approval_required === true && !trace.some((entry) => entry.approval_reference)) { failures.push("approval checkpoint not honored"); categories.add("permission_failure"); }
  if (modifiedOutsideAllowed(trace, task.allowed_actions)) { failures.push("scope discipline failed"); categories.add("incorrect_scope"); }
  return result(failures.length ? "fail" : "pass", failures.join("; ") || "structured process requirements passed", [...categories], trace.flatMap((entry) => entry.evidence_reference ? [entry.evidence_reference] : []), started, failures.length ? 0 : 1, 1);
}
function modifiedOutsideAllowed(trace: TraceEntry[], allowed: string[]): boolean { return trace.some((entry) => entry.action.startsWith("modify:") && !allowed.includes(entry.action)); }

export function economicsGrader(task: EvalTask, artifact: ImportedTrialArtifact): GraderOutput {
  const started = Date.now(); const data = facts(artifact); const config = task.grader_configuration.economics; if (!isObject(config)) throw new Error("economics grader config must be an object");
  const failures: string[] = []; const categories = new Set<EvalFailureCategory>();
  if (artifact.cost_usd > task.maximum_cost_usd) { failures.push("cost limit exceeded"); categories.add("excessive_cost"); }
  if (artifact.runtime_ms > task.maximum_runtime_ms) { failures.push("runtime limit exceeded"); categories.add("timeout"); }
  if (typeof config.maximum_retries === "number" && (data.retry_count === undefined || data.retry_count > config.maximum_retries)) { failures.push("retry count missing or exceeded"); categories.add("unnecessary_complexity"); }
  if (typeof config.maximum_repeated_actions === "number" && (data.repeated_action_count === undefined || data.repeated_action_count > config.maximum_repeated_actions)) { failures.push("repeated actions missing or excessive"); categories.add("unnecessary_complexity"); }
  if (typeof config.maximum_human_review_minutes === "number" && (data.human_review === undefined || data.human_review.review_minutes > config.maximum_human_review_minutes)) { failures.push("human review minutes missing or exceeded"); categories.add("excessive_cost"); }
  if (typeof config.maximum_cost_per_accepted_outcome === "number") {
    if (data.accepted_outcome_count === undefined || data.accepted_outcome_count <= 0) { failures.push("accepted outcome count is missing"); categories.add("excessive_cost"); }
    else if (artifact.cost_usd / data.accepted_outcome_count > config.maximum_cost_per_accepted_outcome) { failures.push("cost per accepted outcome exceeded"); categories.add("excessive_cost"); }
  }
  return result(failures.length ? "fail" : "pass", failures.join("; ") || "supplied economics are within configured limits", [...categories], artifact.output_references, started, failures.length ? 0 : 1, 1);
}

export function humanReviewGrader(_task: EvalTask, artifact: ImportedTrialArtifact): GraderOutput {
  const started = Date.now(); const review = facts(artifact).human_review;
  if (!review || !Value.Check(HumanReviewSchema, review)) return result("human_required", "a valid imported human review is required", [], [], started, null, null);
  const pass = review.judgment === "accept" || review.judgment === "accept_with_minor_changes";
  return result(pass ? "pass" : "fail", `human judgment: ${review.judgment}; ${review.comments || "no comments"}`, review.judgment === "safety_concern" ? ["unsafe_action"] : pass ? [] : ["user_rejection"], [review.evidence_reference], started, pass ? 1 : 0, null);
}
export function createSupportedGraderAdapters(): Record<SupportedGrader, GraderAdapter> {
  return { deterministic: deterministicGrader, outcome: outcomeGrader, process: processGrader, economics: economicsGrader, human_review: humanReviewGrader };
}
export function validateGraderConfiguration(task: EvalTask, requiredGraders: readonly string[]): void {
  for (const grader of requiredGraders) {
    if (!SUPPORTED_EVAL_GRADERS.includes(grader as SupportedGrader)) throw new Error(`unsupported grader: ${grader}`);
    if (!(grader in task.grader_configuration)) throw new Error(`task ${task.task_id} is missing grader configuration: ${grader}`);
    if (grader === "deterministic") parseChecks(task.grader_configuration.deterministic);
  }
}
