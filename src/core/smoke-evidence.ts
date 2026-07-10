import * as fs from "node:fs";

export type SmokeEvidenceGate =
  | "implement_preflight"
  | "drill_preflight"
  | "retry_command"
  | "model_implementation"
  | "model_review"
  | "model_refresh";

export type SmokeEvidenceProfile = "full" | "no_llm";

export interface SmokeEvidence {
  schema: "agentify.smoke-evidence.v1";
  gate: SmokeEvidenceGate;
  repo: string;
  result: "passed" | "failed";
  commit_sha: string;
  completed_at: string;
  issue_url: string;
  pr_url: string;
  workflow_url: string;
  details: string;
}

export interface SmokeEvidenceReport {
  passed: boolean;
  totalEvidence: number;
  passedEvidence: number;
  repos: string[];
  commitShas: string[];
  missingGates: SmokeEvidenceGate[];
  failures: string[];
  evidence: SmokeEvidence[];
}

const REQUIRED_GATES: SmokeEvidenceGate[] = [
  "implement_preflight",
  "drill_preflight",
  "retry_command",
  "model_implementation",
  "model_review",
  "model_refresh",
];

const NO_LLM_REQUIRED_GATES: SmokeEvidenceGate[] = [
  "implement_preflight",
  "drill_preflight",
  "retry_command",
];

export interface SmokeEvidenceVerificationOptions {
  profile?: SmokeEvidenceProfile;
}

export function verifySmokeEvidence(
  evidence: SmokeEvidence[],
  options: SmokeEvidenceVerificationOptions = {},
): SmokeEvidenceReport {
  const requiredGates = requiredGatesForProfile(options.profile ?? "full");
  const failures: string[] = [];
  const gates = new Set(evidence.map((entry) => entry.gate));
  const missingGates = requiredGates.filter((gate) => !gates.has(gate));
  const repos = unique(evidence.map((entry) => entry.repo).filter((repo) => repo.length > 0));
  const commitShas = unique(evidence.map((entry) => entry.commit_sha).filter((commitSha) => commitSha.length > 0));

  for (const entry of evidence) {
    failures.push(...validateSmokeEvidence(entry));
  }

  if (repos.length > 1) {
    failures.push(`evidence spans multiple repositories: ${repos.join(", ")}`);
  }
  if (commitShas.length > 1) {
    failures.push(`evidence spans multiple commits: ${commitShas.join(", ")}`);
  }

  for (const [gate, count] of gateCounts(evidence)) {
    if (count > 1) {
      failures.push(`duplicate smoke evidence for gate: ${gate}`);
    }
  }

  for (const gate of missingGates) {
    failures.push(`missing required smoke gate: ${gate}`);
  }

  const passedEvidence = evidence.filter((entry) => entry.result === "passed").length;
  return {
    passed: evidence.length > 0 && failures.length === 0 && missingGates.length === 0,
    totalEvidence: evidence.length,
    passedEvidence,
    repos,
    commitShas,
    missingGates,
    failures,
    evidence,
  };
}

export function loadSmokeEvidenceFiles(filePaths: string[]): SmokeEvidenceReport {
  const evidence = filePaths.map((filePath) => parseSmokeEvidenceFile(filePath));
  return verifySmokeEvidence(evidence);
}

export function loadSmokeEvidenceFilesWithOptions(
  filePaths: string[],
  options: SmokeEvidenceVerificationOptions = {},
): SmokeEvidenceReport {
  const evidence = filePaths.map((filePath) => parseSmokeEvidenceFile(filePath));
  return verifySmokeEvidence(evidence, options);
}

export function parseSmokeEvidenceFile(filePath: string): SmokeEvidence {
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON (${errorMessage(error)})`);
  }
  return parseSmokeEvidence(parsed, filePath);
}

function parseSmokeEvidence(value: unknown, context: string): SmokeEvidence {
  const record = requireRecord(value, context);
  return {
    schema: requireSchema(record["schema"], `${context}.schema`),
    gate: requireGate(record["gate"], `${context}.gate`),
    repo: requireNonEmptyString(record["repo"], `${context}.repo`),
    result: requireResult(record["result"], `${context}.result`),
    commit_sha: requireNonEmptyString(record["commit_sha"], `${context}.commit_sha`),
    completed_at: requireNonEmptyString(record["completed_at"], `${context}.completed_at`),
    issue_url: requireString(record["issue_url"], `${context}.issue_url`),
    pr_url: requireString(record["pr_url"], `${context}.pr_url`),
    workflow_url: requireString(record["workflow_url"], `${context}.workflow_url`),
    details: requireString(record["details"], `${context}.details`),
  };
}

function validateSmokeEvidence(entry: SmokeEvidence): string[] {
  const failures: string[] = [];
  if (entry.result !== "passed") {
    failures.push(`${entry.gate} result must be passed`);
  }
  if (Number.isNaN(Date.parse(entry.completed_at))) {
    failures.push(`${entry.gate} completed_at must be an ISO timestamp`);
  }
  if (!isGitSha(entry.commit_sha)) {
    failures.push(`${entry.gate} commit_sha must be a 40-character git SHA`);
  }
  if (requiresIssueUrlOnly(entry.gate) && entry.issue_url.length === 0) {
    failures.push(`${entry.gate} must include issue_url`);
  }
  if (requiresIssueUrlOnly(entry.gate) && !isRepoIssueUrl(entry.issue_url, entry.repo)) {
    failures.push(`${entry.gate} issue_url must point at ${entry.repo}`);
  }
  if (requiresIssueUrlOnly(entry.gate) && entry.workflow_url.length === 0) {
    failures.push(`${entry.gate} must include workflow_url`);
  }
  if (requiresIssueUrlOnly(entry.gate) && !isRepoWorkflowUrl(entry.workflow_url, entry.repo)) {
    failures.push(`${entry.gate} workflow_url must point at ${entry.repo}`);
  }
  if (entry.gate === "model_implementation") {
    if (entry.issue_url.length === 0) failures.push("model_implementation must include issue_url");
    if (entry.pr_url.length === 0) failures.push("model_implementation must include pr_url");
    if (entry.workflow_url.length === 0) failures.push("model_implementation must include workflow_url");
    if (!isRepoIssueUrl(entry.issue_url, entry.repo)) failures.push(`model_implementation issue_url must point at ${entry.repo}`);
    if (!isRepoPrUrl(entry.pr_url, entry.repo)) failures.push(`model_implementation pr_url must point at ${entry.repo}`);
    if (!isRepoWorkflowUrl(entry.workflow_url, entry.repo)) failures.push(`model_implementation workflow_url must point at ${entry.repo}`);
  }
  if (entry.gate === "model_review" && entry.pr_url.length === 0) {
    failures.push("model_review must include pr_url");
  }
  if (entry.gate === "model_review" && entry.workflow_url.length === 0) {
    failures.push("model_review must include workflow_url");
  }
  if (entry.gate === "model_review" && !isRepoPrUrl(entry.pr_url, entry.repo)) {
    failures.push(`model_review pr_url must point at ${entry.repo}`);
  }
  if (entry.gate === "model_review" && !isRepoWorkflowUrl(entry.workflow_url, entry.repo)) {
    failures.push(`model_review workflow_url must point at ${entry.repo}`);
  }
  if (entry.gate === "model_refresh" && entry.workflow_url.length === 0) {
    failures.push("model_refresh must include workflow_url");
  }
  if (entry.gate === "model_refresh" && !isRepoWorkflowUrl(entry.workflow_url, entry.repo)) {
    failures.push(`model_refresh workflow_url must point at ${entry.repo}`);
  }
  return failures;
}

function requiresIssueUrlOnly(gate: SmokeEvidenceGate): boolean {
  return gate === "implement_preflight" || gate === "drill_preflight" || gate === "retry_command";
}

function requiredGatesForProfile(profile: SmokeEvidenceProfile): SmokeEvidenceGate[] {
  return profile === "no_llm" ? NO_LLM_REQUIRED_GATES : REQUIRED_GATES;
}

function gateCounts(evidence: SmokeEvidence[]): Map<SmokeEvidenceGate, number> {
  const counts = new Map<SmokeEvidenceGate, number>();
  for (const entry of evidence) {
    counts.set(entry.gate, (counts.get(entry.gate) ?? 0) + 1);
  }
  return counts;
}

function isRepoIssueUrl(value: string, repo: string): boolean {
  return isGitHubRepoUrl(value, repo, "issues");
}

function isGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function isRepoPrUrl(value: string, repo: string): boolean {
  return isGitHubRepoUrl(value, repo, "pull");
}

function isRepoWorkflowUrl(value: string, repo: string): boolean {
  return isGitHubRepoUrl(value, repo, "actions/runs");
}

function isGitHubRepoUrl(value: string, repo: string, section: string): boolean {
  if (value.length === 0) return false;
  const escapedRepo = escapeRegExp(repo);
  const escapedSection = escapeRegExp(section);
  const pattern = new RegExp(`^https://github\\.com/${escapedRepo}/${escapedSection}/[0-9]+$`);
  return pattern.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected object`);
  }
  return value as Record<string, unknown>;
}

function requireSchema(value: unknown, context: string): SmokeEvidence["schema"] {
  if (value === "agentify.smoke-evidence.v1") return value;
  throw new Error(`${context}: expected agentify.smoke-evidence.v1`);
}

function requireGate(value: unknown, context: string): SmokeEvidenceGate {
  if (
    value === "implement_preflight" ||
    value === "drill_preflight" ||
    value === "retry_command" ||
    value === "model_implementation" ||
    value === "model_review" ||
    value === "model_refresh"
  ) {
    return value;
  }
  throw new Error(`${context}: expected known smoke gate`);
}

function requireResult(value: unknown, context: string): SmokeEvidence["result"] {
  if (value === "passed" || value === "failed") return value;
  throw new Error(`${context}: expected passed or failed`);
}

function requireNonEmptyString(value: unknown, context: string): string {
  const result = requireString(value, context);
  if (result.trim().length === 0) {
    throw new Error(`${context}: expected non-empty string`);
  }
  return result;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context}: expected string`);
  }
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
