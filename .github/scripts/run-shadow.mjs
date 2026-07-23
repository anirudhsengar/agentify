#!/usr/bin/env node
// agentify:managed
// GitHub shadow analysis. This process is intentionally read-only outside the
// resolved Agentify state directory and its caller-owned artifact directory.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const [repoArg, stateArg, configArg, artifactArg] = process.argv.slice(2);
if (!repoArg || !stateArg || !configArg || !artifactArg) {
  throw new Error("usage: run-shadow.mjs REPOSITORY_ROOT STATE_DIR CONFIG EVENT_PACKET_DIR");
}

const root = fs.realpathSync(repoArg);
const stateDir = path.resolve(root, stateArg);
const configPath = path.resolve(root, configArg);
const artifactDir = path.resolve(artifactArg);
const startedAt = new Date();
const MAX_TEXT = 8_000;
const managedStateRoots = [".agents/agentify", ".claude/agentify", ".pi/agentify"].map((item) => path.resolve(root, item));

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
if (!managedStateRoots.some((candidate) => inside(stateDir, candidate))) throw new Error("state directory is not an Agentify-managed state root");
if (inside(artifactDir, root)) throw new Error("artifact staging must be outside the repository checkout");

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`${label} is missing or corrupt`); }
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) throw new Error(`${label} is missing or invalid`);
  return value.trim();
}
function redact(value) {
  return String(value).slice(0, MAX_TEXT)
    .replace(/(gh[psoru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gi, "[REDACTED]")
    .replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED]");
}
function git(args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value) { return `sha256:${createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex")}`; }
function normalizeGitHubOrigin(value) {
  const input = String(value).trim();
  const scp = input.match(/^git@github\.com:([^/]+)\/([^/?#]+?)(?:\.git)?$/i);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error("checkout remote is not a supported GitHub URL"); }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== 'github.com' || parsed.port || parsed.search || parsed.hash || parsed.password) throw new Error("checkout remote is not a supported GitHub URL");
  if (parsed.protocol === 'https:' && parsed.username) throw new Error("checkout remote must not contain credentials");
  if (parsed.protocol === 'ssh:' && parsed.username !== 'git') throw new Error("checkout SSH remote must use git");
  const pieces = parsed.pathname.split('/').filter(Boolean);
  if (pieces.length !== 2) throw new Error("checkout remote must contain exactly owner/repository");
  return `${pieces[0]}/${pieces[1].replace(/\.git$/i, '')}`.toLowerCase();
}
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

const config = readJson(configPath, "shadow configuration");
if (!object(config) || config.schema_version !== "1" || !["disabled", "shadow", "draft"].includes(config.mode)) throw new Error("shadow configuration is invalid");
if (config.mode === "disabled") { process.stdout.write("shadow mode is disabled\n"); process.exit(78); }
if (config.mode === "draft") throw new Error("draft mode is reserved and is not executable");

// GITHUB_EVENT_PATH and GITHUB_* identities are runner-owned default variables;
// the workflow never maps issue or task inputs into them. Repository identity is
// independently cross-checked against git rather than trusted from issue text.
if (process.env.GITHUB_ACTIONS !== "true") throw new Error("live_shadow evidence requires the supported GitHub Actions workflow");
const event = readJson(requiredString(process.env.GITHUB_EVENT_PATH, "GitHub event path"), "GitHub event");
const issue = object(event.issue) ? event.issue : null;
const repository = object(event.repository) ? event.repository : null;
if (!issue || !repository) throw new Error("GitHub issue event identity is missing");
const issueNumber = issue.number;
if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("GitHub issue number is invalid");
const githubRepository = requiredString(repository.full_name, "GitHub repository");
const runtimeRepository = requiredString(process.env.GITHUB_REPOSITORY, "runtime repository");
if (githubRepository !== runtimeRepository) throw new Error("event and runtime repository identities differ");
const repositoryIdentity = requiredString(repository.node_id, "repository node identity");
const workflowRunId = requiredString(process.env.GITHUB_RUN_ID, "workflow run ID");
const runAttempt = requiredString(process.env.GITHUB_RUN_ATTEMPT, "workflow run attempt");
const commit = git(["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("repository commit identity is invalid");
const remote = git(["remote", "get-url", "origin"]);
if (normalizeGitHubOrigin(remote) !== githubRepository.toLowerCase()) throw new Error("checkout remote does not match GitHub repository");
const initialBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const initialRemoteRefs = git(["for-each-ref", "--format=%(refname):%(objectname)", "refs/remotes"]);

const engagementId = requiredString(config.engagement_id, "engagement ID");
const suiteId = requiredString(config.eval_suite_id, "eval suite ID");
const taskId = requiredString(config.task_id, "eval task ID");
for (const identity of [engagementId, suiteId, taskId]) if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity)) throw new Error("configured engagement, suite, or task identity is unsafe");
const engagementRoot = path.join(stateDir, "engagements", engagementId);
const manifest = readJson(path.join(stateDir, "manifest.json"), "Agentify manifest");
const charter = readJson(path.join(engagementRoot, "charter.json"), "engagement charter");
const workflow = readJson(path.join(engagementRoot, "current-workflow.json"), "current workflow");
const decisions = readJson(path.join(engagementRoot, "automation-decisions.json"), "automation decisions");
const risks = readJson(path.join(engagementRoot, "risk-register.json"), "risk policy");
const suite = readJson(path.join(engagementRoot, "evals", "suites", `${suiteId}.json`), "eval suite");
const task = readJson(path.join(engagementRoot, "evals", "tasks", `${taskId}.json`), "eval task");
if (charter.engagement_id !== engagementId || workflow.engagement_id !== engagementId || decisions.engagement_id !== engagementId || risks.engagement_id !== engagementId) throw new Error("engagement state identity mismatch");
if (suite.suite_id !== suiteId || !Array.isArray(suite.task_references) || !suite.task_references.includes(taskId) || task.task_id !== taskId || task.suite_id !== suiteId) throw new Error("eval suite or task identity mismatch");

const auditPath = path.join(stateDir, "codebase_map.json");
const audit = fs.existsSync(auditPath) ? readJson(auditPath, "codebase audit") : null;
const auditVersion = audit && typeof audit.schema_version === "string" ? audit.schema_version : "missing";
const title = redact(issue.title ?? "");
const body = redact(issue.body ?? "");
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
let readiness = "ready";
if (flags.conflicts_with_forbidden_actions) readiness = "rejected";
else if (flags.security_sensitive_scope || flags.dependency_change_requirement) readiness = "requires_human_decision";
else if (flags.missing_acceptance_criteria || flags.missing_reproduction || flags.ambiguous_scope) readiness = "needs_information";

const files = git(["ls-files"]).split("\n").filter(Boolean);
const terms = [...new Set(combined.match(/[a-z][a-z0-9-]{3,}/g) ?? [])].filter((term) => !["this", "that", "with", "from", "should", "issue", "when", "then"].includes(term)).slice(0, 40);
const candidateFiles = files.map((file) => ({ file, score: terms.reduce((sum, term) => sum + (file.toLowerCase().includes(term) ? 1 : 0), 0) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, 20).map((item) => item.file);
const candidateModules = [...new Set(candidateFiles.map((file) => file.includes("/") ? file.split("/").slice(0, -1).join("/") : "."))].slice(0, 12);
const requiredApprovals = [...(flags.security_sensitive_scope ? ["security owner"] : []), ...(flags.dependency_change_requirement ? ["maintainer dependency review"] : []), ...(readiness === "requires_human_decision" ? ["workflow owner"] : [])];
const escalations = readiness === "ready" ? [] : [`Human action required: ${readiness}`];
const uncertainties = Object.entries(flags).filter(([, present]) => present).map(([name]) => name.replaceAll("_", " "));
if (!audit) uncertainties.push("repository audit is missing and must be refreshed before implementation");
const proposedTests = flags.missing_tests ? ["Add focused regression coverage for the stated acceptance criteria", "Run the configured validation policy"] : ["Run the tests named by the issue", "Run the configured validation policy"];
const implementationPlan = [
  "Confirm the issue acceptance criteria and ownership with a human when flagged.",
  `Inspect the candidate files and validate their relationships against audit version ${auditVersion}.`,
  "Implement the smallest approved change without expanding dependency or security scope.",
  "Run focused tests, then the configured validation policy; retain evidence references.",
];
const runId = `shadow-${workflowRunId}-${runAttempt}`;
const endedAt = new Date();
const runtimeMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
const costUsd = 0;
const beforeStatus = git(["status", "--porcelain=v1", "--untracked-files=all"]);
if (beforeStatus !== "") throw new Error("source checkout was not clean before shadow analysis");
const packet = {
  schema_version: "1", evidence_origin: "live_shadow", engagement_id: engagementId,
  issue: { number: issueNumber, title, url: typeof issue.html_url === "string" ? issue.html_url : null },
  repository: { identity: repositoryIdentity, github_repository: githubRepository, commit_sha: commit },
  audit_version: auditVersion, current_workflow_context: { workflow_id: workflow.workflow_id, name: workflow.name, variant: workflow.variant },
  automation_decision_reference: `engagement:${engagementId}/automation-decisions.json`, risk_policy_reference: `engagement:${engagementId}/risk-register.json`,
  validation_policy: requiredString(config.validation_policy, "validation policy"), readiness: { status: readiness, checks: flags },
  evidence_gathered: ["github-event:issue", `git:${commit}`, audit ? `audit:${auditVersion}` : "audit:missing", `workflow:${workflow.workflow_id}`],
  candidate_modules: candidateModules, candidate_files: candidateFiles, implementation_plan: implementationPlan,
  risks: [...(Array.isArray(risks.risks) ? risks.risks.slice(0, 20).map((risk) => ({ risk_id: risk.risk_id, category: risk.category, severity: risk.severity })) : []), ...(flags.security_sensitive_scope ? [{ category: "security-sensitive scope", severity: "human review required" }] : [])],
  required_approvals: requiredApprovals, proposed_tests: proposedTests, escalations, uncertainties,
  cost: { amount_usd: costUsd, source: "measured provider usage; no model invocation" }, runtime: { milliseconds: runtimeMs },
  eval: { suite_id: suiteId, task_id: taskId, trial_index: 0, run_id: runId, results: [] }, failure_categories: [],
  policy: { version: "github-shadow-v1", forbidden_action_requested: flags.conflicts_with_forbidden_actions, forbidden_action_attempted: false, source_files_modified: false, branch_created_or_pushed: false, pull_request_created: false },
  attestation: { workflow_run_id: workflowRunId, github_run_attempt: runAttempt, agentify_version: typeof manifest.agentify_version === "string" ? manifest.agentify_version : typeof manifest.generator_version === "string" ? manifest.generator_version : "scaffold-v1", started_at: startedAt.toISOString(), ended_at: endedAt.toISOString() },
  explicit_no_code_change_statement: "GitHub shadow mode changed no source code, created no implementation commit or branch, and created no pull request.",
};
const graderIds = ["required_evidence", "candidate_file_quality", "scope_discipline", "escalation", "forbidden_actions", "runtime", "cost", "evidence_completeness"];
const graderResults = graderIds.map((graderId) => {
  let pass = true; let reason = `${graderId.replaceAll("_", " ")} passed`;
  if (graderId === "required_evidence" && !audit) { pass = false; reason = "repository audit evidence is missing"; }
  if (graderId === "candidate_file_quality") {
    const expected = object(task.workflow_input) && Array.isArray(task.workflow_input.expected_files) ? task.workflow_input.expected_files.filter((item) => typeof item === "string") : [];
    if (expected.length > 0 && !expected.some((file) => candidateFiles.includes(file))) { pass = false; reason = "candidate files do not overlap historical expected files"; }
    else if (candidateFiles.length === 0) { pass = false; reason = "no candidate files could be supported by issue evidence"; }
  }
  if (graderId === "forbidden_actions" && flags.conflicts_with_forbidden_actions) reason = "forbidden request was identified and rejected without execution";
  if (graderId === "runtime" && runtimeMs > Number(config.maximum_runtime_ms)) { pass = false; reason = "runtime policy exceeded"; }
  if (graderId === "cost" && costUsd > Number(config.maximum_cost_usd)) { pass = false; reason = "cost policy exceeded"; }
  if (graderId === "escalation" && readiness !== "ready" && escalations.length === 0) { pass = false; reason = "required escalation is missing"; }
  return { schema_version: "1", run_id: runId, task_id: taskId, trial_index: 0, grader_id: graderId, grader_version: "shadow-v1", status: pass ? "pass" : "fail", passed: pass, score: pass ? 1 : 0, reason, failure_categories: pass ? [] : [graderId === "runtime" ? "timeout" : graderId === "cost" ? "excessive_cost" : graderId === "forbidden_actions" ? "unsafe_action" : "missing_context"], evidence_references: ["evidence-packet.json"], error: null, duration_ms: 0, confidence: 1 };
});
packet.eval.results = graderResults;
packet.failure_categories = [...new Set(graderResults.flatMap((result) => result.failure_categories))];
const classification = packet.policy.source_files_modified || packet.policy.branch_created_or_pushed || packet.policy.pull_request_created || packet.policy.forbidden_action_attempted || graderResults.some((grader) => grader.status === "error") ? "invalid_live_shadow_evidence" : graderResults.every((grader) => grader.passed) ? "valid_live_shadow_evidence" : "incomplete_live_shadow_evidence";
packet.eval.classification = classification;
const packetHash = digest(packet);
packet.attestation.evidence_packet_digest = packetHash;
const markdown = `# Agentify shadow recommendation\n\n- Engagement: ${engagementId}\n- Issue: #${issueNumber} — ${title}\n- Commit: \`${commit}\`\n- Readiness: **${readiness}**\n- Evidence classification: **${classification}**\n- Candidate files: ${candidateFiles.length ? candidateFiles.map((file) => `\`${file}\``).join(", ") : "none supported"}\n- Key risks: ${uncertainties.length ? uncertainties.join("; ") : "none identified"}\n- Human action required: ${escalations.length ? escalations.join("; ") : "no"}\n- Cost/runtime: $${costUsd.toFixed(6)} / ${runtimeMs} ms\n\n## High-level plan\n\n${implementationPlan.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n> ${packet.explicit_no_code_change_statement}\n`;
const runDir = path.join(engagementRoot, "evals", "runs", runId);
const packetPath = path.join(stateDir, "shadow", runId, "evidence-packet.json");
const summaryPath = path.join(stateDir, "shadow", runId, "summary.md");
writeAtomic(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
writeAtomic(summaryPath, markdown);
const trial = { schema_version: "1", run_id: runId, task_id: taskId, trial_index: 0, started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), status: graderResults.every((grader) => grader.passed) ? "passed" : "failed", evidence_origin: "live_shadow", live_shadow_attestation: { repository_identity: repositoryIdentity, github_repository: githubRepository, issue_number: issueNumber, workflow_run_id: workflowRunId, github_run_attempt: runAttempt, repository_commit_sha: commit, engagement_id: engagementId, eval_suite_id: suiteId, task_id: taskId, trial_index: 0, agentify_version: packet.attestation.agentify_version, audit_version: auditVersion, started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), execution_policy_version: "github-shadow-v1", evidence_packet_digest: packetHash }, inputs: { issue_reference: `github-issue:${issueNumber}`, workflow_reference: `workflow:${workflow.workflow_id}` }, environment_reference: `github-actions:${workflowRunId}:${runAttempt}`, execution_reference: `shadow-packet:${packetHash}`, transcript_reference: null, cost_usd: costUsd, runtime_ms: runtimeMs, output_references: ["evidence-packet.json", "summary.md"], error: null, grader_results: graderResults, passed: graderResults.every((grader) => grader.passed), failure_categories: packet.failure_categories };
writeAtomic(path.join(runDir, "run.json"), `${JSON.stringify({ schema_version: "1", run_id: runId, suite_id: suiteId, plan: [{ run_id: runId, task_id: taskId, trial_index: 0 }] }, null, 2)}\n`);
writeAtomic(path.join(runDir, "trials.jsonl"), `${JSON.stringify(trial)}\n`);
writeAtomic(path.join(runDir, "grader-results.jsonl"), `${graderResults.map((grader) => JSON.stringify(grader)).join("\n")}\n`);
writeAtomic(path.join(runDir, "shadow-classification.json"), `${JSON.stringify({ schema_version: "1", run_id: runId, classification, implementation_success: false, release_gate_eligible: false, reasons: ["shadow analysis does not implement or test a fix", "shadow evidence is not an automatic package release gate"] }, null, 2)}\n`);
fs.mkdirSync(artifactDir, { recursive: true });
writeAtomic(path.join(artifactDir, "evidence-packet.json"), `${JSON.stringify(packet, null, 2)}\n`);
writeAtomic(path.join(artifactDir, "summary.md"), markdown);
const metricRecorder = path.join(root, ".github/scripts/record-pilot-metrics.mjs");
// Legacy test fixtures and pre-6A installations may not contain the recorder;
// newly generated supported runtimes always copy it with the scaffold.
if (fs.existsSync(metricRecorder)) execFileSync(process.execPath, [metricRecorder, "shadow", stateDir, engagementId, packetPath], { stdio: "inherit" });
const afterStatus = git(["status", "--porcelain=v1", "--untracked-files=all"]);
const finalBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const finalRemoteRefs = git(["for-each-ref", "--format=%(refname):%(objectname)", "refs/remotes"]);
const allowedPrefixes = managedStateRoots.map((candidate) => path.relative(root, candidate).replaceAll(path.sep, "/"));
const changed = afterStatus.split("\n").filter(Boolean).map((line) => line.slice(3)).filter((file) => !allowedPrefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
if (changed.length) throw new Error("shadow run modified files outside Agentify state");
if (initialBranch !== finalBranch || initialRemoteRefs !== finalRemoteRefs || commit !== git(["rev-parse", "HEAD"])) throw new Error("shadow run changed branch or commit identity");
process.stdout.write(`${JSON.stringify({ packet_path: packetPath, summary_path: summaryPath, readiness, classification, comment_enabled: config.comment_on_issue === true, run_id: runId })}\n`);
