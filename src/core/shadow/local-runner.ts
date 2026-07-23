// Supported local shadow runner. Orchestrates identity collection, workspace
// preparation, deterministic analysis, evidence packet assembly, metric
// emission, and git safety verification. The runner is read-only against
// the source repository; it never invokes a model and never opens a
// branch, commit, or PR.

import { performance } from "node:perf_hooks";
import { Value } from "typebox/value";
import * as fs from "node:fs";
import * as path from "node:path";
import { readPackageVersion } from "../package-version.ts";
import { analyseShadow, digestObject, evaluateGraders } from "./engine.ts";
import {
  assertSafeId,
  assertSafeRepo,
  collectIssueIdentity,
  collectOperatorIdentity,
  collectRepositoryIdentity,
  git,
  normalizeOrigin,
  type IssueIdentity,
  type RepositoryIdentity,
} from "./identity.ts";
import {
  acquireLock,
  type AcquiredLock,
} from "./lock.ts";
import {
  assertManagedWrite,
  preparePrivateClone,
  resolveWorkspacePaths,
  type WorkspacePaths,
} from "./workspace.ts";
import { captureGitSnapshot, findUnsafeChanges, verifyGitSafety, type GitSnapshot } from "./git-safety.ts";
import { classifyLocalShadowTrial } from "../evals/runner.ts";
import { LocalShadowAttestationSchema } from "../evals/schema/trial.ts";
import type { GraderResult } from "../evals/schema/grader-result.ts";
import { recordMetricEvent } from "../engagement/metrics/storage.ts";
import type { MetricEventInput } from "../engagement/metrics/schema.ts";
import { redactSecret } from "./redaction.ts";

export interface LocalShadowRunInput {
  pilotRoot: string;
  repoSlug: string;
  /** GitHub owner/name (must match the source origin). */
  githubFullName: string;
  /** Path to the source checkout (the operator's normal working copy). */
  sourceRepoRoot: string;
  engagementId: string;
  issueNumber: number;
  suiteId: string;
  taskId: string;
  /** Absolute path to the agentify-shadow.json config. */
  configPath: string;
  /** Override maximum runtime; defaults to config.maximum_runtime_ms. */
  maximumRuntimeMs?: number;
}

export interface LocalShadowConfig {
  schema_version: string;
  mode: "disabled" | "shadow" | "draft";
  engagement_id: string;
  eval_suite_id: string;
  task_id: string;
  validation_policy: string;
  maximum_runtime_ms: number;
  maximum_cost_usd: number;
  forbidden_paths: ReadonlyArray<string>;
  /** Optional overrides used for unit tests. */
  audit_version?: string;
}

export interface LocalShadowRunResult {
  runId: string;
  evidenceOrigin: "live_local_shadow";
  classification: ReturnType<typeof classifyLocalShadowTrial>;
  repository: { githubFullName: string; commitSha: string };
  issue: { number: number; url: string };
  engagement: { id: string; suite: string; task: string };
  readiness: "ready" | "needs_information" | "requires_human_decision" | "rejected";
  runtimeMs: number;
  costUsd: number;
  costStatus: "measured" | "rejected";
  evidencePacketPath: string;
  summaryPath: string;
  metricsStatus: "recorded" | "skipped";
  evidenceTrust: {
    isOperatorAttested: boolean;
    appropriateFor: "controlled internal pilot evidence";
    notEquivalentTo: "GitHub-hosted runtime attestation";
    notAReleaseGate: true;
    notCustomerProof: true;
    notImplementationSuccess: true;
    cannotProveIssueFixed: true;
  };
}

class RunnerTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "RunnerTimeoutError"; }
}

function readConfig(configPath: string): LocalShadowConfig {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  if (parsed.schema_version !== "1") throw new Error("shadow configuration schema_version must be 1");
  if (!["disabled", "shadow", "draft"].includes(parsed.mode as string)) throw new Error("shadow configuration mode is invalid");
  if (parsed.mode === "disabled") throw new Error("shadow configuration is disabled");
  if (parsed.mode === "draft") throw new Error("draft mode is reserved and is not executable");
  assertSafeId(parsed.engagement_id as string, "engagement_id");
  assertSafeId(parsed.eval_suite_id as string, "eval_suite_id");
  assertSafeId(parsed.task_id as string, "task_id");
  return {
    schema_version: "1",
    mode: "shadow",
    engagement_id: parsed.engagement_id as string,
    eval_suite_id: parsed.eval_suite_id as string,
    task_id: parsed.task_id as string,
    validation_policy: parsed.validation_policy as string,
    maximum_runtime_ms: Number(parsed.maximum_runtime_ms),
    maximum_cost_usd: Number(parsed.maximum_cost_usd),
    forbidden_paths: Array.isArray(parsed.forbidden_paths) ? (parsed.forbidden_paths as string[]) : [],
    audit_version: typeof parsed.audit_version === "string" ? parsed.audit_version : undefined,
  };
}

function atomicWrite(paths: WorkspacePaths, file: string, contents: string): void {
  assertManagedWrite(file, paths);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  assertManagedWrite(tmp, paths);
  fs.writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}

function remainingMs(deadline: number, label: string): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new RunnerTimeoutError(`maximum runtime exceeded before ${label}`);
  return remaining;
}

function isTimeoutError(error: unknown): boolean {
  const value = error as { code?: string; killed?: boolean; signal?: string };
  return error instanceof RunnerTimeoutError || value.code === "ETIMEDOUT" || value.killed === true || value.signal === "SIGKILL";
}

function packetDigest(packet: Record<string, any>): string {
  const copy = structuredClone(packet);
  if (copy.attestation) copy.attestation.evidence_packet_digest = "pending";
  if (copy.local_shadow_attestation) copy.local_shadow_attestation.evidence_packet_digest = "pending";
  return digestObject(copy);
}

export async function runLocalShadow(input: LocalShadowRunInput): Promise<LocalShadowRunResult> {
  assertSafeRepo(input.githubFullName);
  assertSafeId(input.engagementId, "engagement id");
  assertSafeId(input.suiteId, "suite id");
  assertSafeId(input.taskId, "task id");
  if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new Error("issue number must be a positive integer");
  }
  const configAbsolute = path.resolve(input.configPath);
  const sourceAbsolute = path.resolve(input.sourceRepoRoot);
  if (configAbsolute !== sourceAbsolute && !configAbsolute.startsWith(`${sourceAbsolute}${path.sep}`)) {
    throw new Error("shadow configuration must be inside the source repository");
  }
  if (fs.lstatSync(configAbsolute).isSymbolicLink()) throw new Error("shadow configuration cannot be a symlink");
  const config = readConfig(configAbsolute);
  if (config.engagement_id !== input.engagementId) throw new Error("config engagement_id does not match --id");
  if (config.eval_suite_id !== input.suiteId) throw new Error("config eval_suite_id does not match --suite");
  if (config.task_id !== input.taskId) throw new Error("config task_id does not match --task");

  const paths = resolveWorkspacePaths({
    pilotRoot: input.pilotRoot,
    repoSlug: input.repoSlug,
    githubFullName: input.githubFullName,
    sourceRepoRoot: input.sourceRepoRoot,
    sourceCommitSha: "pending",
  });

  const startedAt = new Date();
  const startedMonotonic = performance.now();
  const maximumRuntimeMs = input.maximumRuntimeMs ?? config.maximum_runtime_ms;
  const deadline = startedMonotonic + maximumRuntimeMs;
  const operator = await collectOperatorIdentity({ timeoutMs: remainingMs(deadline, "operator identity") });
  const runId = `local-${operator.localRunId}`;
  let terminalPaths: WorkspacePaths | null = null;
  const lock: AcquiredLock = acquireLock(paths.workspaceRoot, {
    repo: input.githubFullName,
    engagementId: input.engagementId,
    issueNumber: input.issueNumber,
    localRunId: operator.localRunId,
  });
  terminalPaths = paths;

  try {
    const repo: RepositoryIdentity = await collectRepositoryIdentity(
      input.sourceRepoRoot,
      input.githubFullName,
      { timeoutMs: remainingMs(deadline, "repository identity") },
    );
    const issue: IssueIdentity = await collectIssueIdentity(
      input.githubFullName,
      input.issueNumber,
      { timeoutMs: remainingMs(deadline, "issue identity") },
    );
    if (normalizeOrigin(repo.remoteUrl) !== input.githubFullName.toLowerCase()) {
      throw new Error("source repository origin mismatch");
    }
    // Recreate paths now that we know the exact source commit.
    const finalPaths = resolveWorkspacePaths({
      pilotRoot: input.pilotRoot,
      repoSlug: input.repoSlug,
      githubFullName: input.githubFullName,
      sourceRepoRoot: input.sourceRepoRoot,
      sourceCommitSha: repo.commitSha,
    });
    terminalPaths = finalPaths;
    preparePrivateClone(finalPaths, repo.commitSha, remainingMs(deadline, "private clone"));

    const snapshot: GitSnapshot = await captureGitSnapshot(input.sourceRepoRoot, { timeoutMs: remainingMs(deadline, "git snapshot") });
    if (snapshot.commitSha !== repo.commitSha) {
      throw new Error("git snapshot commit does not match reported repository commit");
    }

    const files = await git(["ls-files"], input.sourceRepoRoot, { timeoutMs: remainingMs(deadline, "source inventory") });
    const fileList = files.split("\n").filter(Boolean);
    const configRelative = path.relative(input.sourceRepoRoot, configAbsolute).split(path.sep).join("/");
    if (!fileList.includes(configRelative)) throw new Error("shadow configuration must be tracked by the selected source commit");
    const sourceAudit = [".pi/agentify/codebase_map.json", ".agents/agentify/codebase_map.json", ".claude/agentify/codebase_map.json"]
      .map((relative) => path.join(input.sourceRepoRoot, relative))
      .find((candidate) => fs.existsSync(candidate));
    const auditVersion = (() => {
      if (config.audit_version) return config.audit_version;
      if (sourceAudit) {
        try { return JSON.parse(fs.readFileSync(sourceAudit, "utf8")).schema_version ?? "missing"; }
        catch { return "missing"; }
      }
      return "missing";
    })();
    if (!sourceAudit) throw new Error("managed codebase audit state is missing");
    const sourceStateRoot = path.dirname(sourceAudit);
    const requiredState = {
      audit: sourceAudit,
      manifest: path.join(sourceStateRoot, "manifest.json"),
      charter: path.join(sourceStateRoot, "engagements", config.engagement_id, "charter.json"),
      workflow: path.join(sourceStateRoot, "engagements", config.engagement_id, "current-workflow.json"),
      decisions: path.join(sourceStateRoot, "engagements", config.engagement_id, "automation-decisions.json"),
      risks: path.join(sourceStateRoot, "engagements", config.engagement_id, "risk-register.json"),
      suite: path.join(sourceStateRoot, "engagements", config.engagement_id, "evals", "suites", `${config.eval_suite_id}.json`),
      task: path.join(sourceStateRoot, "engagements", config.engagement_id, "evals", "tasks", `${config.task_id}.json`),
    };
    const state = Object.fromEntries(Object.entries(requiredState).map(([name, file]) => {
      if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw new Error(`managed ${name} state is missing or unsafe`);
      const relative = path.relative(input.sourceRepoRoot, file).split(path.sep).join("/");
      if (!fileList.includes(relative)) throw new Error(`managed ${name} state is not tracked by the selected source commit`);
      try { return [name, JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>]; }
      catch { throw new Error(`managed ${name} state is corrupt`); }
    })) as Record<string, Record<string, any>>;
    if (state.charter.engagement_id !== config.engagement_id || state.workflow.engagement_id !== config.engagement_id
      || state.decisions.engagement_id !== config.engagement_id || state.risks.engagement_id !== config.engagement_id) {
      throw new Error("managed engagement state identity mismatch");
    }
    if (state.suite.suite_id !== config.eval_suite_id || !Array.isArray(state.suite.task_references)
      || !state.suite.task_references.includes(config.task_id) || state.task.task_id !== config.task_id
      || state.task.suite_id !== config.eval_suite_id) {
      throw new Error("managed eval suite or task identity mismatch");
    }

    remainingMs(deadline, "analysis");
    const analysis = analyseShadow({ number: issue.number, title: issue.title, body: issue.body }, { files: fileList, auditPath: sourceAudit ?? null }, auditVersion);

    // Deterministic cost: shadow analysis invokes no model.
    const costUsd = 0;
    const endedAt = new Date();
    const runtimeMs = Math.max(0, Math.floor(performance.now() - startedMonotonic));

    const expectedFilesFromTask: string[] = [];
    const graderOutcomes = evaluateGraders({
      analysis,
      trialIndex: 0,
      config: {
        maximumRuntimeMs,
        maximumCostUsd: config.maximum_cost_usd,
        forbiddenPaths: config.forbidden_paths,
        trialIndex: 0,
        evalSuiteId: config.eval_suite_id,
        taskId: config.task_id,
      },
      costUsd,
      runtimeMs,
      expectedFilesFromTask,
    });
    const graderResults: GraderResult[] = graderOutcomes.map((outcome) => ({
      schema_version: "1",
      run_id: `local-${operator.localRunId}`,
      task_id: config.task_id,
      trial_index: 0,
      grader_id: outcome.graderId,
      grader_version: "shadow-v1",
      status: outcome.pass ? "pass" : "fail",
      passed: outcome.pass,
      score: outcome.pass ? 1 : 0,
      reason: outcome.reason,
      failure_categories: outcome.failureCategories,
      evidence_references: ["evidence-packet.json"],
      error: null,
      duration_ms: 0,
      confidence: 1,
    }));

    const policyForbiddenAttempted = false;
    const sourceFilesModified = false;
    const branchCreatedOrPushed = false;
    const prCreated = false;
    const classification = policyForbiddenAttempted || sourceFilesModified || branchCreatedOrPushed || prCreated || graderResults.some((g) => g.status === "error")
      ? "invalid_live_local_shadow_evidence"
      : operator.githubAuthenticationStatus !== "authenticated" || !operator.githubOperatorLogin
        ? "incomplete_live_local_shadow_evidence"
        : graderResults.every((g) => g.passed)
          ? "valid_live_local_shadow_evidence"
          : "incomplete_live_local_shadow_evidence";
    const failureCategories = [...new Set(graderResults.flatMap((g) => g.failure_categories))];

    const evidenceOrigin = "live_local_shadow" as const;
    const workspaceReference = `workspace:${finalPaths.repoSlug}`;
    const sourceReference = `github:${repo.githubFullName}@${repo.commitSha}`;

    const packet = {
      schema_version: "1",
      evidence_origin: evidenceOrigin,
      local_shadow_attestation: {
        repository_identity: repo.nodeId,
        github_repository: repo.githubFullName,
        issue_number: issue.number,
        issue_url: issue.url,
        local_run_id: operator.localRunId,
        github_operator_login: operator.githubOperatorLogin,
        local_operator_identity: operator.localOperatorIdentity,
        github_authentication_status: operator.githubAuthenticationStatus,
        repository_commit_sha: repo.commitSha,
        engagement_id: config.engagement_id,
        workflow_id: config.engagement_id,
        eval_suite_id: config.eval_suite_id,
        task_id: config.task_id,
        trial_index: 0,
        agentify_version: readPackageVersion(),
        audit_version: auditVersion,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        monotonic_runtime_ms: runtimeMs,
        execution_policy_version: "local-shadow-v1",
        evidence_packet_digest: "pending",
        issue_fetched_at: issue.fetchedAt,
        workspace_reference: workspaceReference,
        source_repository_reference: sourceReference,
        source_repository_commit: repo.commitSha,
        local_authentication_used_only_for_reads: true as const,
      },
      engagement_id: config.engagement_id,
      issue: { number: issue.number, title: redactSecret(issue.title, [input.sourceRepoRoot, finalPaths.workspaceRoot]), url: issue.url },
      repository: { identity: repo.nodeId, github_repository: repo.githubFullName, commit_sha: repo.commitSha },
      audit_version: auditVersion,
      current_workflow_context: { workflow_id: config.engagement_id, name: config.engagement_id, variant: "local_shadow" },
      automation_decision_reference: `engagement:${config.engagement_id}/automation-decisions.json`,
      risk_policy_reference: `engagement:${config.engagement_id}/risk-register.json`,
      validation_policy: config.validation_policy,
      readiness: { status: analysis.readiness, checks: analysis.flags },
      evidence_gathered: ["local-issue-fetch", `git:${repo.commitSha}`, auditVersion === "missing" ? "audit:missing" : `audit:${auditVersion}`, `workflow:${config.engagement_id}`],
      candidate_modules: analysis.candidateModules,
      candidate_files: analysis.candidateFiles,
      implementation_plan: analysis.implementationPlan,
      risks: [...(analysis.flags.security_sensitive_scope ? [{ category: "security-sensitive scope", severity: "human review required" }] : [])],
      required_approvals: analysis.requiredApprovals,
      proposed_tests: analysis.proposedTests,
      escalations: analysis.escalations,
      uncertainties: analysis.uncertainties,
      cost: { amount_usd: costUsd, source: "no provider invocation", configured_maximum_usd: config.maximum_cost_usd },
      runtime: { milliseconds: runtimeMs },
      eval: { suite_id: config.eval_suite_id, task_id: config.task_id, trial_index: 0, run_id: runId, results: graderResults, classification },
      failure_categories: failureCategories,
      policy: {
        version: "local-shadow-v1",
        forbidden_action_requested: analysis.flags.conflicts_with_forbidden_actions,
        forbidden_action_attempted: policyForbiddenAttempted,
        source_files_modified: sourceFilesModified,
        branch_created_or_pushed: branchCreatedOrPushed,
        pull_request_created: prCreated,
      },
      attestation: {
        local_run_id: operator.localRunId,
        github_operator_login: operator.githubOperatorLogin,
        local_operator_identity: operator.localOperatorIdentity,
        agentify_version: readPackageVersion(),
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        evidence_packet_digest: "pending",
      },
      operator_attestation: {
        github_operator_login: operator.githubOperatorLogin,
        local_operator_identity: operator.localOperatorIdentity,
        github_authentication_status: operator.githubAuthenticationStatus,
        local_run_id: operator.localRunId,
        local_authentication_used_only_for_reads: true,
      },
      explicit_no_code_change_statement: "Local shadow mode changed no source code, created no implementation commit or branch, and created no pull request.",
      evidence_trust: {
        is_operator_attested: true,
        appropriate_for: "controlled internal pilot evidence",
        not_equivalent_to: "GitHub-hosted runtime attestation",
        not_a_release_gate: true,
        not_customer_proof: true,
        not_implementation_success: true,
        cannot_prove_issue_fixed: true,
      },
    };

    const digest = packetDigest(packet);
    packet.attestation.evidence_packet_digest = digest;
    packet.local_shadow_attestation.evidence_packet_digest = digest;
    if (!Value.Check(LocalShadowAttestationSchema, packet.local_shadow_attestation)) {
      throw new Error("local shadow attestation failed schema validation");
    }

    // Verify git safety before persisting the packet.
    const safety = await verifyGitSafety(snapshot, input.sourceRepoRoot, { timeoutMs: remainingMs(deadline, "git safety") });
    const afterPorcelain = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], input.sourceRepoRoot, { timeoutMs: remainingMs(deadline, "final status") });
    const unsafe = findUnsafeChanges(snapshot, afterPorcelain);
    if (!safety.ok || unsafe.length > 0) {
      const reason = [...safety.failures, ...unsafe.map((file) => `unauthorized change to ${file}`)].join("; ");
      packet.policy.source_files_modified = true;
      packet.eval.classification = "invalid_live_local_shadow_evidence";
      const invalidDigest = packetDigest(packet);
      packet.attestation.evidence_packet_digest = invalidDigest;
      packet.local_shadow_attestation.evidence_packet_digest = invalidDigest;
      const evidencePath = path.join(finalPaths.shadowEvidenceRoot, runId, "evidence-packet.json");
      try { atomicWrite(finalPaths, evidencePath, `${JSON.stringify(packet, null, 2)}\n`); }
      catch (error) { throw new Error(`git safety violation; preserving evidence at workspace but cannot continue: ${reason}`); }
      throw new Error(`git safety violation: ${reason}`);
    }

    const evidencePath = path.join(finalPaths.shadowEvidenceRoot, runId, "evidence-packet.json");
    atomicWrite(finalPaths, evidencePath, `${JSON.stringify(packet, null, 2)}\n`);

    const summary = `# Agentify local shadow recommendation\n\n- Engagement: ${config.engagement_id}\n- Issue: #${issue.number} — ${redactSecret(issue.title, [input.sourceRepoRoot, finalPaths.workspaceRoot])}\n- Commit: \`${repo.commitSha}\`\n- Readiness: **${analysis.readiness}**\n- Evidence classification: **${packet.eval.classification}**\n- Local run id: \`${operator.localRunId}\`\n- GitHub operator: \`${operator.githubOperatorLogin ?? "not authenticated"}\`\n- Local operator: \`${redactSecret(operator.localOperatorIdentity)}\`\n- GitHub authentication: \`${operator.githubAuthenticationStatus}\`\n- Workspace reference: \`${workspaceReference}\`\n- Candidate files: ${analysis.candidateFiles.length ? analysis.candidateFiles.map((f) => `\`${f}\``).join(", ") : "none supported"}\n- Key risks: ${analysis.uncertainties.length ? analysis.uncertainties.join("; ") : "none identified"}\n- Human action required: ${analysis.escalations.length ? analysis.escalations.join("; ") : "no"}\n- Cost/runtime: $${costUsd.toFixed(6)} / ${runtimeMs} ms\n\n## High-level plan\n\n${analysis.implementationPlan.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}\n\n> ${packet.explicit_no_code_change_statement}\n\n> Trust: operator-attested local shadow evidence; not equivalent to GitHub-hosted runtime attestation; not a package release gate; not customer proof; not implementation success; cannot prove the issue was fixed.\n`;
    const summaryPath = path.join(finalPaths.shadowEvidenceRoot, runId, "summary.md");
    atomicWrite(finalPaths, summaryPath, summary);

    const postEvidenceSafety = await verifyGitSafety(snapshot, input.sourceRepoRoot, { timeoutMs: remainingMs(deadline, "post-evidence integrity") });
    if (!postEvidenceSafety.ok) {
      packet.policy.source_files_modified = true;
      packet.eval.classification = "invalid_live_local_shadow_evidence";
      const invalidDigest = packetDigest(packet);
      packet.attestation.evidence_packet_digest = invalidDigest;
      packet.local_shadow_attestation.evidence_packet_digest = invalidDigest;
      atomicWrite(finalPaths, evidencePath, `${JSON.stringify(packet, null, 2)}\n`);
      atomicWrite(finalPaths, summaryPath, summary.replace(`Evidence classification: **${classification}**`, "Evidence classification: **invalid_live_local_shadow_evidence**"));
      throw new Error(`git safety violation after evidence write: ${postEvidenceSafety.failures.join("; ")}`);
    }

    // Record pilot metric events so reports distinguish GitHub and local runs.
    let metricsStatus: "recorded" | "skipped" = "skipped";
    let metricSafetyFailure: string | null = null;
    try {
      const refs = [path.relative(finalPaths.workspaceRoot, evidencePath)];
      const startedEvent: MetricEventInput = {
        schema_version: "1",
        engagement_id: config.engagement_id,
        workflow_id: config.engagement_id,
        run_id: runId,
        timestamp: startedAt.toISOString(),
        source: "runtime",
        execution_origin: "live_local_shadow",
        event_type: "run_started",
        provenance: { quality: "measured", method: "local shadow runner clock and identity", source_reference: refs[0] ?? null },
        evidence_references: refs,
        redaction_status: "reference_only",
        payload: {
          mode: "shadow",
          issue: String(issue.number),
          repository: repo.githubFullName,
          commit: repo.commitSha,
          engagement: config.engagement_id,
          start_time: startedAt.toISOString(),
        },
      };
      const completedEvent: MetricEventInput = {
        schema_version: "1",
        engagement_id: config.engagement_id,
        workflow_id: config.engagement_id,
        run_id: runId,
        timestamp: endedAt.toISOString(),
        source: "runtime",
        execution_origin: "live_local_shadow",
        event_type: "run_completed",
        provenance: { quality: "measured", method: "local shadow runner clock and structured graders", source_reference: refs[0] ?? null },
        evidence_references: refs,
        redaction_status: "reference_only",
        payload: {
          final_status: graderResults.every((g) => g.passed) ? "completed" : "failed",
          runtime_ms: { value: runtimeMs, quality: "measured", unit: "ms" },
          cost_accounting_status: "measured",
          measured_cost_usd: { value: costUsd, quality: "measured", unit: "usd" },
          estimated_cost_usd: { value: null, quality: "unavailable", unit: "usd" },
          reserved_exposure_usd: { value: null, quality: "unavailable", unit: "usd" },
          model_call_count: { value: 0, quality: "measured", unit: "count" },
          tool_call_count: { value: null, quality: "unavailable", unit: "count" },
          retry_count: { value: 0, quality: "measured", unit: "count" },
          timeout: failureCategories.includes("timeout"),
          cancellation: false,
          safety_status: packet.eval.classification === "invalid_live_local_shadow_evidence" ? "failed" : "passed",
          validation_status: graderResults.every((g) => g.passed) ? "passed" : "failed",
        },
      };
      recordMetricEvent(finalPaths.managedStateRoot, startedEvent);
      const postMetricSafety = await verifyGitSafety(snapshot, input.sourceRepoRoot, { timeoutMs: remainingMs(deadline, "post-metric integrity") });
      if (!postMetricSafety.ok) {
        packet.policy.source_files_modified = true;
        packet.eval.classification = "invalid_live_local_shadow_evidence";
        const invalidDigest = packetDigest(packet);
        packet.attestation.evidence_packet_digest = invalidDigest;
        packet.local_shadow_attestation.evidence_packet_digest = invalidDigest;
        atomicWrite(finalPaths, evidencePath, `${JSON.stringify(packet, null, 2)}\n`);
        atomicWrite(finalPaths, summaryPath, summary.replace(`Evidence classification: **${classification}**`, "Evidence classification: **invalid_live_local_shadow_evidence**"));
        const failedPayload = completedEvent.payload as { final_status: "completed" | "failed" | "cancelled" | "timed_out" | "rejected"; safety_status: "passed" | "failed" | "unavailable"; validation_status: "passed" | "failed" | "not_run" | "unavailable" };
        failedPayload.final_status = "failed";
        failedPayload.safety_status = "failed";
        failedPayload.validation_status = "failed";
        metricSafetyFailure = postMetricSafety.failures.join("; ");
      }
      recordMetricEvent(finalPaths.managedStateRoot, completedEvent);
      metricsStatus = "recorded";
    } catch {
      metricsStatus = "skipped";
    }
    if (metricSafetyFailure) throw new Error(`git safety violation during metric recording: ${metricSafetyFailure}`);

    return {
      runId,
      evidenceOrigin,
      classification: packet.eval.classification as ReturnType<typeof classifyLocalShadowTrial>,
      repository: { githubFullName: repo.githubFullName, commitSha: repo.commitSha },
      issue: { number: issue.number, url: issue.url },
      engagement: { id: config.engagement_id, suite: config.eval_suite_id, task: config.task_id },
      readiness: analysis.readiness,
      runtimeMs,
      costUsd,
      costStatus: "measured",
      evidencePacketPath: path.relative(finalPaths.workspaceRoot, evidencePath),
      summaryPath: path.relative(finalPaths.workspaceRoot, summaryPath),
      metricsStatus,
      evidenceTrust: {
        isOperatorAttested: true,
        appropriateFor: "controlled internal pilot evidence",
        notEquivalentTo: "GitHub-hosted runtime attestation",
        notAReleaseGate: true,
        notCustomerProof: true,
        notImplementationSuccess: true,
        cannotProveIssueFixed: true,
      },
    };
  } catch (error) {
    if (isTimeoutError(error) && terminalPaths) {
      const endedAt = new Date();
      const runtimeMs = Math.max(0, Math.floor(performance.now() - startedMonotonic));
      const terminal = {
        schema_version: "1",
        evidence_origin: "live_local_shadow",
        run_id: runId,
        engagement_id: config.engagement_id,
        issue_number: input.issueNumber,
        status: "timed_out",
        classification: "invalid_live_local_shadow_evidence",
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        monotonic_runtime_ms: runtimeMs,
        terminal_reason: isTimeoutError(error) ? "maximum runtime exceeded during a bounded subprocess" : redactSecret(error instanceof Error ? error.message : String(error), [input.sourceRepoRoot, terminalPaths.workspaceRoot]),
        evidence_trust: { not_a_release_gate: true, not_customer_proof: true, not_implementation_success: true },
      };
      const evidencePath = path.join(terminalPaths.shadowEvidenceRoot, runId, "terminal-evidence.json");
      try {
        atomicWrite(terminalPaths, evidencePath, `${JSON.stringify(terminal, null, 2)}\n`);
        const terminalEvent: MetricEventInput = {
          schema_version: "1", engagement_id: config.engagement_id, workflow_id: config.engagement_id,
          run_id: runId, timestamp: endedAt.toISOString(), source: "runtime", execution_origin: "live_local_shadow",
          event_type: "run_completed",
          provenance: { quality: "measured", method: "local shadow monotonic deadline", source_reference: path.relative(terminalPaths.workspaceRoot, evidencePath) },
          evidence_references: [path.relative(terminalPaths.workspaceRoot, evidencePath)], redaction_status: "redacted",
          payload: {
            final_status: "timed_out", runtime_ms: { value: runtimeMs, quality: "measured", unit: "ms" },
            cost_accounting_status: "measured", measured_cost_usd: { value: 0, quality: "measured", unit: "usd" },
            estimated_cost_usd: { value: null, quality: "unavailable", unit: "usd" }, reserved_exposure_usd: { value: null, quality: "unavailable", unit: "usd" },
            model_call_count: { value: 0, quality: "measured", unit: "count" }, tool_call_count: { value: null, quality: "unavailable", unit: "count" },
            retry_count: { value: 0, quality: "measured", unit: "count" }, timeout: true, cancellation: false,
            safety_status: "unavailable", validation_status: "not_run",
          },
        };
        recordMetricEvent(terminalPaths.managedStateRoot, terminalEvent);
      } catch { /* preserve the original bounded timeout error */ }
    }
    if (isTimeoutError(error)) throw new Error("local shadow command timed out");
    throw new Error(redactSecret(error instanceof Error ? error.message : String(error), [input.sourceRepoRoot, terminalPaths?.workspaceRoot ?? ""]));
  } finally {
    try { lock.release(); } catch { /* best-effort cleanup */ }
  }
}

export { RunnerTimeoutError };
