// Shared shadow analysis engine. Both the GitHub Actions runner and the
// supported local shadow runner call into this deterministic algorithm;
// only the identity adapter differs between them. The engine performs no
// filesystem writes and invokes no model.

import { createHash } from "node:crypto";
import type { EvalFailureCategory } from "../evals/failure-taxonomy.ts";
import { redactSecret } from "./redaction.ts";

export interface ShadowIssueInput {
  number: number;
  title: string;
  body: string;
}

export interface ShadowFilesystemInput {
  /** All repository paths known to git. */
  files: ReadonlyArray<string>;
  /** Path to codebase_map.json if present, else null. */
  auditPath: string | null;
}

export interface ShadowConfigInput {
  maximumRuntimeMs: number;
  maximumCostUsd: number;
  forbiddenPaths: ReadonlyArray<string>;
  /** Trial index; defaults to 0. */
  trialIndex?: number;
  /** Suite / task ids used by downstream grading. */
  evalSuiteId: string;
  taskId: string;
}

export interface ShadowAnalysis {
  flags: {
    missing_acceptance_criteria: boolean;
    missing_reproduction: boolean;
    ambiguous_scope: boolean;
    security_sensitive_scope: boolean;
    dependency_change_requirement: boolean;
    missing_tests: boolean;
    unclear_ownership: boolean;
    conflicts_with_forbidden_actions: boolean;
  };
  readiness: "ready" | "needs_information" | "requires_human_decision" | "rejected";
  candidateFiles: string[];
  candidateModules: string[];
  requiredApprovals: string[];
  escalations: string[];
  uncertainties: string[];
  proposedTests: string[];
  implementationPlan: string[];
  terms: string[];
}

const STOPWORDS = new Set([
  "this", "that", "with", "from", "should", "issue", "when", "then", "have", "has",
  "what", "which", "their", "there", "these", "those", "would", "could",
]);

function classifyReadiness(flags: ShadowAnalysis["flags"]): ShadowAnalysis["readiness"] {
  if (flags.conflicts_with_forbidden_actions) return "rejected";
  if (flags.security_sensitive_scope || flags.dependency_change_requirement) return "requires_human_decision";
  if (flags.missing_acceptance_criteria || flags.missing_reproduction || flags.ambiguous_scope) return "needs_information";
  return "ready";
}

export function analyseShadow(
  issue: ShadowIssueInput,
  filesystem: ShadowFilesystemInput,
  auditVersion: string,
): ShadowAnalysis {
  const title = redactSecret(issue.title ?? "");
  const body = redactSecret(issue.body ?? "");
  const combined = `${title}\n${body}`.toLowerCase();
  const flags = {
    missing_acceptance_criteria: !/(acceptance criteria|expected behavior|done when|should)/i.test(body),
    missing_reproduction: /(bug|error|fail|regression|crash)/i.test(combined) && !/(steps to reproduce|repro|when .* then|1\.)/i.test(body),
    ambiguous_scope: body.trim().length < 80 || /\b(somehow|etc\.?|as needed|various)\b/i.test(body),
    security_sensitive_scope: /\b(auth|credential|secret|token|permission|security|encrypt|private key|pii)\b/i.test(combined),
    dependency_change_requirement: /\b(add|install|upgrade|update|replace)\b.{0,30}\b(dependency|package|library|npm)\b/i.test(combined),
    missing_tests: !/\b(test|spec|verify|validation)\b/i.test(body),
    unclear_ownership: !/\b(owner|team|maintainer|module|component|service)\b/i.test(body),
    conflicts_with_forbidden_actions: /\b(force[- ]?push|auto[- ]?merge|merge it|create (?:a )?pr|open (?:a )?pr|push (?:a )?branch|modify dependencies|delete (?:the )?history)\b/i.test(combined),
  };
  const terms = [...new Set(combined.match(/[a-z][a-z0-9-]{3,}/g) ?? [])].filter((term) => !STOPWORDS.has(term)).slice(0, 40);
  const candidateFiles = filesystem.files
    .map((file) => ({ file, score: terms.reduce((sum, term) => sum + (file.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 20)
    .map((item) => item.file);
  const candidateModules = [...new Set(candidateFiles.map((file) => file.includes("/") ? file.split("/").slice(0, -1).join("/") : "."))].slice(0, 12);
  const requiredApprovals = [
    ...(flags.security_sensitive_scope ? ["security owner"] : []),
    ...(flags.dependency_change_requirement ? ["maintainer dependency review"] : []),
  ];
  const readiness = classifyReadiness(flags);
  const escalations = readiness === "ready" ? [] : [`Human action required: ${readiness}`];
  const uncertainties = Object.entries(flags).filter(([, present]) => present).map(([name]) => name.replaceAll("_", " "));
  if (!filesystem.auditPath) uncertainties.push("repository audit is missing and must be refreshed before implementation");
  const proposedTests = flags.missing_tests
    ? ["Add focused regression coverage for the stated acceptance criteria", "Run the configured validation policy"]
    : ["Run the tests named by the issue", "Run the configured validation policy"];
  const implementationPlan = [
    "Confirm the issue acceptance criteria and ownership with a human when flagged.",
    `Inspect the candidate files and validate their relationships against audit version ${auditVersion}.`,
    "Implement the smallest approved change without expanding dependency or security scope.",
    "Run focused tests, then the configured validation policy; retain evidence references.",
  ];
  return { flags, readiness, candidateFiles, candidateModules, requiredApprovals, escalations, uncertainties, proposedTests, implementationPlan, terms };
}

export interface GraderInput {
  analysis: ShadowAnalysis;
  trialIndex: number;
  config: ShadowConfigInput;
  costUsd: number;
  runtimeMs: number;
  expectedFilesFromTask: ReadonlyArray<string>;
}

export interface GraderOutcome {
  graderId: string;
  pass: boolean;
  reason: string;
  failureCategories: EvalFailureCategory[];
}

const GRADER_IDS = [
  "required_evidence",
  "candidate_file_quality",
  "scope_discipline",
  "escalation",
  "forbidden_actions",
  "runtime",
  "cost",
  "evidence_completeness",
] as const;

export function evaluateGraders(input: GraderInput): GraderOutcome[] {
  const { analysis, config, costUsd, runtimeMs, expectedFilesFromTask } = input;
  const outcomes: GraderOutcome[] = [];
  for (const graderId of GRADER_IDS) {
    let pass = true;
    let reason = `${graderId.replaceAll("_", " ")} passed`;
    const categories: EvalFailureCategory[] = [];
    if (graderId === "required_evidence" && analysis.uncertainties.includes("repository audit is missing and must be refreshed before implementation")) {
      pass = false; reason = "repository audit evidence is missing"; categories.push("missing_context");
    }
    if (graderId === "candidate_file_quality") {
      if (expectedFilesFromTask.length > 0 && !expectedFilesFromTask.some((file) => analysis.candidateFiles.includes(file))) {
        pass = false; reason = "candidate files do not overlap historical expected files"; categories.push("missing_context");
      } else if (analysis.candidateFiles.length === 0) {
        pass = false; reason = "no candidate files could be supported by issue evidence"; categories.push("missing_context");
      }
    }
    if (graderId === "forbidden_actions" && analysis.flags.conflicts_with_forbidden_actions) {
      reason = "forbidden request was identified and rejected without execution";
    }
    if (graderId === "runtime" && runtimeMs > Number(config.maximumRuntimeMs)) {
      pass = false; reason = "runtime policy exceeded"; categories.push("timeout");
    }
    if (graderId === "cost" && costUsd > Number(config.maximumCostUsd)) {
      pass = false; reason = "cost policy exceeded"; categories.push("excessive_cost");
    }
    if (graderId === "escalation" && analysis.readiness !== "ready" && analysis.escalations.length === 0) {
      pass = false; reason = "required escalation is missing"; categories.push("missing_context");
    }
    outcomes.push({ graderId, pass, reason, failureCategories: categories });
  }
  return outcomes;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestObject(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}