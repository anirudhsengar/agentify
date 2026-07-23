// Supported local shadow runner. Orchestrates identity collection, workspace
// preparation, deterministic analysis, evidence packet assembly, metric
// emission, and git safety verification. The runner is read-only against
// the source repository; it never invokes a model and never opens a
// branch, commit, or PR.

import { createHash } from "node:crypto";
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
import type { EvalTrial } from "../evals/schema/trial.ts";
import type { GraderResult } from "../evals/schema/grader-result.ts";
import { recordMetricEvent } from "../engagement/metrics/storage.ts";
import type { MetricEventInput } from "../engagement/metrics/schema.ts";

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
  /** Set true to mark the run synthetic (skips live attestation). */
  synthetic?: boolean;
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
  evidenceOrigin: "live_local_shadow" | "synthetic";
  classification: ReturnType<typeof classifyLocalShadowTrial> | "synthetic_run";
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

function atomicWrite(file: string, contents: string): void {
  assertManagedWrite(file, workspacePathsRef!);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Workspace paths are populated during runLocalShadow and referenced by
// helpers above. Using a module-local reference keeps the public signature
// flat without leaking internal state into tests.
let workspacePathsRef: WorkspacePaths | null = null;

async function checkTimeout(deadline: number, label: string): Promise<void> {
  if (Date.now() > deadline) throw new RunnerTimeoutError(`maximum runtime exceeded before ${label}`);
}

export async function runLocalShadow(input: LocalShadowRunInput): Promise<LocalShadowRunResult> {
  assertSafeRepo(input.githubFullName);
  assertSafeId(input.engagementId, "engagement id");
  assertSafeId(input.suiteId, "suite id");
  assertSafeId(input.taskId, "task id");
  if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new Error("issue number must be a positive integer");
  }
  const config = readConfig(input.configPath);
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
  workspacePathsRef = paths;

  // Acquire lock up front so concurrent runs fail clearly before any work
  // touches the workspace or the source checkout.
  const operator = await collectOperatorIdentity();
  const lock: AcquiredLock = acquireLock(paths.workspaceRoot, {
    repo: input.githubFullName,
    engagementId: input.engagementId,
    issueNumber: input.issueNumber,
    localRunId: operator.localRunId,
  });

  try {
    const startedAt = new Date();
    const deadline = startedAt.getTime() + (input.maximumRuntimeMs ?? config.maximum_runtime_ms);
    await checkTimeout(deadline, "identity collection");

    const repo: RepositoryIdentity = await collectRepositoryIdentity(input.sourceRepoRoot, input.githubFullName);
    const issue: IssueIdentity = await collectIssueIdentity(input.githubFullName, input.issueNumber);
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
    workspacePathsRef = finalPaths;
    paths.workspaceRoot; // silence unused
    preparePrivateClone(finalPaths, repo.commitSha);

    await checkTimeout(deadline, "git snapshot");
    const snapshot: GitSnapshot = await captureGitSnapshot(input.sourceRepoRoot);
    if (snapshot.commitSha !== repo.commitSha) {
      throw new Error("git snapshot commit does not match reported repository commit");
    }

    const files = await git(["ls-files"], input.sourceRepoRoot);
    const fileList = files.split("\n").filter(Boolean);
    const auditPath = finalPaths.managedStateRoot;
    // The audit (codebase_map.json) is part of the agentify state tree in the
    // private workspace; the source repo may or may not have one.
    const sourceAudit = path.join(input.sourceRepoRoot, ".pi/agentify/codebase_map.json");
    const auditVersion = (() => {
      if (config.audit_version) return config.audit_version;
      if (fs.existsSync(sourceAudit)) {
        try { return JSON.parse(fs.readFileSync(sourceAudit, "utf8")).schema_version ?? "missing"; }
        catch { return "missing"; }
      }
      return "missing";
    })();

    await checkTimeout(deadline, "analysis");
    const analysis = analyseShadow({ number: issue.number, title: issue.title, body: issue.body }, { files: fileList, auditPath: fs.existsSync(auditPath) ? auditPath : null }, auditVersion);

    // Deterministic cost: shadow analysis invokes no model.
    const costUsd = 0;
    const endedAt = new Date();
    const runtimeMs = Math.max(0, endedAt.getTime() - startedAt.getTime());

    const expectedFilesFromTask: string[] = [];
    const graderOutcomes = evaluateGraders({
      analysis,
      trialIndex: 0,
      config: {
        maximumRuntimeMs: deadline - startedAt.getTime(),
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
      : graderResults.every((g) => g.passed)
        ? "valid_live_local_shadow_evidence"
        : "incomplete_live_local_shadow_evidence";
    const failureCategories = [...new Set(graderResults.flatMap((g) => g.failure_categories))];

    const evidenceOrigin: "live_local_shadow" | "synthetic" = input.synthetic ? "synthetic" : "live_local_shadow";

    const runId = input.synthetic
      ? `synthetic-${operator.localRunId}`
      : `local-${operator.localRunId}`;

    const evidenceOriginForPacket = evidenceOrigin;
    const packet = {
      schema_version: "1",
      evidence_origin: evidenceOriginForPacket,
      local_shadow_attestation: input.synthetic ? null : {
        repository_identity: repo.nodeId ?? `${repo.githubFullName}@${repo.commitSha}`,
        github_repository: repo.githubFullName,
        issue_number: issue.number,
        local_run_id: operator.localRunId,
        operator_login: operator.login,
        repository_commit_sha: repo.commitSha,
        engagement_id: config.engagement_id,
        eval_suite_id: config.eval_suite_id,
        task_id: config.task_id,
        trial_index: 0,
        agentify_version: readPackageVersion(),
        audit_version: auditVersion,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        execution_policy_version: "local-shadow-v1",
        evidence_packet_digest: "pending",
        issue_fetched_at: issue.fetchedAt,
        workspace_identity: finalPaths.workspaceRoot,
        source_repository_path: input.sourceRepoRoot,
        source_repository_commit: repo.commitSha,
        local_authentication_used_only_for_reads: true,
      },
      engagement_id: config.engagement_id,
      issue: { number: issue.number, title: redactSafe(issue.title), url: issue.url },
      repository: { identity: repo.nodeId ?? `${repo.githubFullName}@${repo.commitSha}`, github_repository: repo.githubFullName, commit_sha: repo.commitSha },
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
      cost: { amount_usd: costUsd, source: "measured provider usage; no model invocation" },
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
        operator_login: operator.login,
        agentify_version: readPackageVersion(),
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        evidence_packet_digest: "pending",
      },
      operator_attestation: input.synthetic ? null : {
        operator_login: operator.login,
        local_run_id: operator.localRunId,
        gh_authenticated: operator.ghAuthenticated,
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

    const digest = digestObject(packet);
    packet.attestation.evidence_packet_digest = digest;
    if (packet.local_shadow_attestation) (packet.local_shadow_attestation as { evidence_packet_digest: string }).evidence_packet_digest = digest;

    // Verify git safety before persisting the packet.
    await checkTimeout(deadline, "git safety");
    const safety = await verifyGitSafety(snapshot, input.sourceRepoRoot);
    const afterPorcelain = await git(["status", "--porcelain=v1", "--untracked-files=all"], input.sourceRepoRoot);
    const unsafe = findUnsafeChanges(snapshot, afterPorcelain);
    if (!safety.ok || unsafe.length > 0) {
      const reason = [...safety.failures, ...unsafe.map((file) => `unauthorized change to ${file}`)].join("; ");
      packet.policy.source_files_modified = true;
      packet.eval.classification = "invalid_live_local_shadow_evidence";
      const evidencePath = path.join(finalPaths.shadowEvidenceRoot, runId, "evidence-packet.json");
      try { atomicWrite(evidencePath, `${JSON.stringify(packet, null, 2)}\n`); }
      catch (error) { throw new Error(`git safety violation; preserving evidence at workspace but cannot continue: ${reason}`); }
      throw new Error(`git safety violation: ${reason}`);
    }

    const evidencePath = path.join(finalPaths.shadowEvidenceRoot, runId, "evidence-packet.json");
    atomicWrite(evidencePath, `${JSON.stringify(packet, null, 2)}\n`);

    const summary = `# Agentify local shadow recommendation\n\n- Engagement: ${config.engagement_id}\n- Issue: #${issue.number} — ${redactSafe(issue.title)}\n- Commit: \`${repo.commitSha}\`\n- Readiness: **${analysis.readiness}**\n- Evidence classification: **${packet.eval.classification}**\n- Local run id: \`${operator.localRunId}\`\n- Operator: \`${operator.login}\`\n- Workspace: \`${finalPaths.workspaceRoot}\`\n- Candidate files: ${analysis.candidateFiles.length ? analysis.candidateFiles.map((f) => `\`${f}\``).join(", ") : "none supported"}\n- Key risks: ${analysis.uncertainties.length ? analysis.uncertainties.join("; ") : "none identified"}\n- Human action required: ${analysis.escalations.length ? analysis.escalations.join("; ") : "no"}\n- Cost/runtime: $${costUsd.toFixed(6)} / ${runtimeMs} ms\n\n## High-level plan\n\n${analysis.implementationPlan.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}\n\n> ${packet.explicit_no_code_change_statement}\n\n> Trust: operator-attested local shadow evidence; not equivalent to GitHub-hosted runtime attestation; not a package release gate; not customer proof; not implementation success; cannot prove the issue was fixed.\n`;
    const summaryPath = path.join(finalPaths.shadowEvidenceRoot, runId, "summary.md");
    atomicWrite(summaryPath, summary);

    // Record pilot metric events so reports distinguish GitHub and local runs.
    let metricsStatus: "recorded" | "skipped" = "skipped";
    try {
      const refs = [path.relative(finalPaths.workspaceRoot, evidencePath)];
      const startedEvent: MetricEventInput = {
        schema_version: "1",
        engagement_id: config.engagement_id,
        workflow_id: config.engagement_id,
        run_id: runId,
        timestamp: startedAt.toISOString(),
        source: "runtime",
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
      recordMetricEvent(finalPaths.managedStateRoot, completedEvent);
      metricsStatus = "recorded";
    } catch {
      metricsStatus = "skipped";
    }

    return {
      runId,
      evidenceOrigin: evidenceOriginForPacket,
      classification: input.synthetic ? "synthetic_run" : (packet.eval.classification as ReturnType<typeof classifyLocalShadowTrial>),
      repository: { githubFullName: repo.githubFullName, commitSha: repo.commitSha },
      issue: { number: issue.number, url: issue.url },
      engagement: { id: config.engagement_id, suite: config.eval_suite_id, task: config.task_id },
      readiness: analysis.readiness,
      runtimeMs,
      costUsd,
      costStatus: "measured",
      evidencePacketPath: evidencePath,
      summaryPath,
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
  } finally {
    try { lock.release(); } catch { /* best-effort cleanup */ }
  }
}

function redactSafe(value: string): string {
  // Re-export of redactSecret for convenience within this module.
  // (Local import avoids a circular dependency.)
  return String(value).slice(0, 8_000).replace(/(gh[psoru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gi, "[REDACTED]");
}

export { RunnerTimeoutError };

// Helper for grading: produces a synthetic EvalTrial view of the local run
// without requiring it to be persisted to the eval runner.
export function syntheticEvalTrial(input: { runId: string; taskId: string; trialIndex: number; attestation: unknown; graderResults: GraderResult[]; costUsd: number; runtimeMs: number; origin: "live_local_shadow" | "synthetic"; localAttestation: unknown }): EvalTrial {
  return {
    schema_version: "1",
    run_id: input.runId,
    task_id: input.taskId,
    trial_index: input.trialIndex,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    status: input.graderResults.every((g) => g.passed) ? "passed" : "failed",
    evidence_origin: input.origin,
    local_shadow_attestation: input.origin === "live_local_shadow" ? (input.localAttestation as EvalTrial["local_shadow_attestation"]) : undefined,
    inputs: {},
    environment_reference: `local:${input.runId}`,
    execution_reference: `local-packet:${createHash("sha256").update(JSON.stringify(input.attestation)).digest("hex")}`,
    transcript_reference: null,
    cost_usd: input.costUsd,
    runtime_ms: input.runtimeMs,
    output_references: ["evidence-packet.json", "summary.md"],
    error: null,
    grader_results: input.graderResults,
    passed: input.graderResults.every((g) => g.passed),
    failure_categories: [...new Set(input.graderResults.flatMap((g) => g.failure_categories))],
  };
}