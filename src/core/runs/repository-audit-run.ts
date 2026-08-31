import * as path from "node:path";
import { defaultConfigDir } from "../agentify-config.ts";
import { AgentifyLog } from "../audit/log.ts";
import {
  AuditBudgetExceededError,
  AuditResourceBudget,
  unresolvedObligationFingerprint,
} from "../audit/resource-budget.ts";
import {
  assessExplorerReceiptAttestation,
  checkpointExplorerConcernEvidence,
  currentRepositoryCommit,
  ExplorerReceiptTracker,
} from "../audit/explorer-receipts.ts";
import { DEFAULT_MAP_FILENAME, writeCanonicalMap } from "../audit/map-storage.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { loadBuilderPrompt } from "../audit/prompt.ts";
import {
  assessCoverageClosure,
  compileSpecialistEvidence,
  type CodebaseMap,
  type SpecialistCompilationResult,
  type SpecialistEvidenceAssessment,
} from "../audit/schema.ts";
import { createWriteMapTools, loadCanonicalMapAt } from "../audit/write-map-tool.ts";
import { assessSpecialistReviews, reviewSpecialistCompilation, specialistReviewDigest } from "../audit/specialist-review.ts";
import { createReadOnlyExecutionPolicy } from "../security/execution-policy.ts";
import type { AgentRuntimeResult } from "../types.ts";
import type { RunContext } from "./run-context.ts";
import {
  ProviderAuthFailedError,
  runRepositoryAudit as runBaseRepositoryAudit,
  type FocusedAuditResult,
} from "./repository-audit-run-core.ts";

export { ProviderAuthFailedError };
export type { FocusedAuditResult };

const REPAIR_TOOL_ALLOWLIST = [
  "write_map_delta",
  "spawn_explorer",
];
const REPAIR_PATH_BATCH_SIZE = 48;
const REPAIR_CLUSTER_BATCH_SIZE = 24;
const REPAIR_TIMEOUT_MS = 20 * 60 * 1000;
const REPAIR_MAX_OUTPUT_TOKENS = 65_536;

function rotatingWindow<T>(values: readonly T[], limit: number, pass: number): T[] {
  if (values.length <= limit) return [...values];
  const offset = ((pass - 1) * limit) % values.length;
  const result: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    result.push(values[(offset + index) % values.length]!);
  }
  return result;
}

function repairPrompt(
  map: CodebaseMap,
  assessment: SpecialistEvidenceAssessment,
  pass: number,
  maxRepairPasses: number,
  explorerReceiptReasons: ReadonlyArray<string> = [],
  compilationReasons: ReadonlyArray<string> = [],
): string {
  const currentFailures = [...assessment.reasons, ...compilationReasons];
  const narrativeCorrections = (map.specialist_reviews?.records ?? []).flatMap(record => {
    const body = map.concern_evidence?.concerns.find(concern => concern.concern === record.concern);
    if (!record.failure || !body || record.digest !== specialistReviewDigest(body)) return [];
    return [record.finding, ...record.additional_findings ?? []].flatMap(finding => {
      const match = /^(pitfalls|invariants|flows)\[([0-9]+)\]$/.exec(finding?.claim ?? "");
      if (!finding || (!match && finding.claim !== "one_line")) return [];
      return [{ concern: record.concern, digest: record.digest, claim: finding.claim,
        original: finding.claim === "one_line" ? body.one_line
          : match?.[1] === "pitfalls" ? body.pitfalls[Number(match[2])]
          : match?.[1] === "invariants" ? body.invariants[Number(match[2])] : body.flows[Number(match?.[2])], finding }];
    });
  }).slice(0, 12);
  const coreConflictReasons = currentFailures.filter((reason) =>
    /multiple core owners/i.test(reason)
  );
  const coreConflictObligations = (map.concern_evidence?.concerns ?? [])
    .filter((concern) => coreConflictReasons.some((reason) => reason.includes(concern.concern)))
    .map((concern) => {
      const core = concern.touchpoints
        .filter((touchpoint) => touchpoint.centrality === "core")
        .map((touchpoint) => touchpoint.path);
      const flows = concern.flows.map((flow) =>
        `${flow.name} [${flow.steps.map((step) => step.path).join(" > ")}]`
      );
      return `${concern.concern}: core ${core.join(", ")}; flows ${flows.join(" | ")}`;
    });
  const needsBroadDiscovery = pass === 1 && (
    assessment.accepted_concerns.length === 0
    || currentFailures.some((reason) => /thin specialist portfolio/i.test(reason))
  );
  const uncoveredBatch = rotatingWindow(
    assessment.uncovered_paths,
    REPAIR_PATH_BATCH_SIZE,
    pass,
  );
  const clusterBatch = rotatingWindow(
    assessment.uncovered_clusters,
    REPAIR_CLUSTER_BATCH_SIZE,
    pass,
  );
  const uncovered = uncoveredBatch.length > 0 ? uncoveredBatch.join(", ") : "none";
  const rejected = assessment.rejected_concerns.length > 0
    ? assessment.rejected_concerns
      .slice(0, 12)
      .map((entry) => `${entry.concern} (${entry.reasons.join("; ")})`)
      .join(", ")
    : "none";
  const uncoveredClusters = clusterBatch.length > 0
    ? clusterBatch.map((cluster) =>
      `${cluster.cluster_key}: ${[...cluster.implementation_paths, ...cluster.test_paths].join(", ")}`
    ).join("; ")
    : "none";

  return [
    "The repository's coverage map is complete, but its specialist portfolio failed the trusted semantic-quality gate.",
    `Repair pass ${pass}/${maxRepairPasses}; ${assessment.uncovered_paths.length} tracked paths and ${assessment.uncovered_clusters.length} local implementation/test clusters remain in total.`,
    `Current failures: ${currentFailures.slice(0, 12).join("; ")}.`,
    "A narrative review finding is a source-backed correction obligation. For a listed correction, use write_map_delta with delta: {} and claim_correction: {concern, digest, claim, statement, rationale}; use the exact identifiers below. For a pitfall/invariant, correct only that assertion and its consequence/explanation. For a flow finding, also supply flow_step (zero-based index at the finding's path); statement replaces only that step's what_happens and rationale explains the correction. Flow descriptions, names, paths, order and all other steps stay unchanged. All other claims, references and ownership are preserved, and full normalized review remains mandatory. Findings requiring new paths or changed flow structure require retracing the exact concern. Covered paths do not excuse false claims; never reject real behavior or suppress review to close it.",
    `Bounded narrative corrections: ${JSON.stringify(narrativeCorrections)}.`,
    "For a listed one_line finding, statement replaces only that summary; rationale explains the correction. Keep covers, excludes, identity and all evidence unchanged. Do not supply flow_step for a summary.",
    "When multiple listed findings share one concern and digest, include up to two additional_corrections: [{claim, statement, rationale, flow_step?}] in that claim_correction proposal. The batch is atomic and only named reviewed assertions may change; do not use a stale digest for sequential corrections.",
    `Accepted concerns to preserve or safely subsume: ${assessment.accepted_concerns.join(", ") || "none"}.`,
    `Current tracked-path batch: ${uncovered}.`,
    `Current local implementation/test-cluster batch, ordered by direct dependency centrality: ${uncoveredClusters}.`,
    "Resolve every obligation in the current bounded cluster batch, investigating distinct behavior before leaf utilities unless stronger repository evidence proves another obligation blocks it.",
    "If a listed uncovered cluster is a distinct maintainer behavior omitted by every scout proposal, run one concern_scout with focus naming its exact cluster key and tracked paths, then trace the resulting proposal. Do not rerun broad scouting or reject a real behavior merely to close the cluster.",
    `Concern candidates rejected by trusted evidence binding: ${rejected}.`,
    `Explorer receipt failures to resolve: ${explorerReceiptReasons.join("; ") || "none"}.`,
    needsBroadDiscovery
      ? "Run concern_scout against the repository root once, then one concern_tracer for each retained candidate."
      : "Do not rerun a broad concern scout. Repair only the named tracked gaps and rejected candidates, preserving accepted concerns.",
    "A repository path is evidence only when that exact path is a regular Git blob tracked at HEAD. Extensionless tracked files such as Jenkinsfiles are valid; fetched dependencies, ignored/generated outputs, symlinks, path templates, glob expressions, and process labels are not.",
    "Trace every retained concern through at least two ordered tracked operations and record at least one tracked core touchpoint. Distinct operations may occur in the same orchestration file; duplicated padding is not a trace.",
    "For each uncovered tracked path, add it to the appropriate concern as a real touchpoint/flow step, or put its exact path in not_concerns.candidate with a repository-specific reason.",
    "Batch exact not_concerns decisions into one write_map_delta after the bounded batch is classified; do not end the pass after only the first disposition.",
    "Implementation/test clusters are path-local. Trace both sides when they form a cohesive recurring contract; otherwise attach them to an existing concern or explicitly reject the exact paths.",
    "Treat a concern's excludes statement as negative evidence. Never attach a path or cluster to a concern that excludes that behavior; retain or create the adjacent concern, or reject the exact path with repository-specific evidence.",
    "A high-signal implementation shared by multiple concerns is not closed by supporting mentions. Record one explicit core touchpoint under the concern whose verified flow owns the behavior, or create a distinct concern.",
    "Workspace package facades, exported module roots, and inline-tested implementation files are behavioral obligations even when no separate test file exists.",
    "A concern_tracer timeout is unresolved evidence, not grounds for not_concerns. Retry a narrower target with the same focus until a successful report is returned.",
    "Every concern_tracer call must pass the exact intended identity in concern. When repairing an accepted concern, reuse its name verbatim; do not create a renamed or narrower duplicate.",
    "For an ownership-only conflict with otherwise correct attested bodies, use write_map_delta with delta: {} and core_owner: {path, concern}. Select the exact existing core claimant whose verified flow owns the shared behavior; competing specialists must retain independent core implementation. This demotes only competing touchpoints without rereading or retranscribing bodies. If ownership is ambiguous, keep it unresolved; if behavior or prose is wrong, use the tracer. The normalized result still requires narrative review.",
    "Shared supporting files should appear under every concern they serve. When the compiler names multiple core owners that cannot retain independent file-level implementation ownership, group the already-attested bodies instead of guessing an owner or retranscribing them: add each narrower exact identity to not_concerns with grouped_into set to one exact existing broader concern identity and a repository-specific 'Subsumed by ...' reason. Trusted normalization unions their flows, touchpoints, invariants, pitfalls, questions, and validation only when the grouped concerns share a core implementation file; unrelated grouping remains unresolved.",
    `Current core-conflict preservation obligations: ${coreConflictObligations.join(" || ") || "none"}.`,
    "Do not include .agentify/** or .github/agentify/** as repository architecture, specialists, or application evidence.",
    "Agentify validates and checkpoints complete concern_tracer bodies directly. Never retranscribe or resend accepted concern bodies through write_map_delta. Use write_map_delta for compact core_owner or claim_correction proposals, or rejected candidates in not_concerns. Omit the dimension parameter because concern evidence closes no D1-D10 dimension.",
    "Do not modify application files, workflows, dependencies, prompts, or documentation. Do not return prose instead of the structured write_map_delta call.",
  ].join(" ");
}

function repairObligationFingerprint(
  compilation: SpecialistCompilationResult,
  receiptReasons: ReadonlyArray<string>,
): string {
  return unresolvedObligationFingerprint({
    compilation_reasons: [...compilation.reasons].sort(),
    assessment_reasons: [...compilation.assessment.reasons].sort(),
    uncovered_paths: [...compilation.assessment.uncovered_paths].sort(),
    uncovered_clusters: compilation.assessment.uncovered_clusters
      .map((cluster) => ({
        cluster_key: cluster.cluster_key,
        implementation_paths: [...cluster.implementation_paths].sort(),
        test_paths: [...cluster.test_paths].sort(),
      }))
      .sort((left, right) => left.cluster_key.localeCompare(right.cluster_key)),
    explorer_receipt_reasons: [...receiptReasons].sort(),
  });
}

function actionableBudgetError(
  error: AuditBudgetExceededError,
  map: CodebaseMap | null,
  cwd: string,
): AuditBudgetExceededError {
  const obligations: string[] = [];
  if (map === null) {
    obligations.push("canonical codebase map is unavailable");
  } else {
    const coverage = assessCoverageClosure(map, { cwd });
    for (const dimension of coverage.unresolved) {
      obligations.push(`${dimension}: ${coverage.reasons[dimension] ?? "coverage is unresolved"}`);
    }
    try {
      const compilation = compileSpecialistEvidence(map, { cwd });
      obligations.push(...compilation.reasons);
    } catch (compilationError) {
      obligations.push(
        `specialist evidence could not be compiled: ${compilationError instanceof Error ? compilationError.message : String(compilationError)}`,
      );
    }
    obligations.push(...assessExplorerReceiptAttestation(map, cwd).reasons);
    obligations.push(...assessSpecialistReviews(map, cwd));
  }
  const uniqueObligations = [...new Set(obligations)].sort();
  const fingerprint = unresolvedObligationFingerprint({ obligations: uniqueObligations });
  const budgetReason = error.message.replace(/^repository audit resource budget exhausted:\s*/i, "");
  return new AuditBudgetExceededError(
    `${budgetReason}; semantic closure remains unresolved; unresolved-obligation fingerprint ${fingerprint}: `
      + uniqueObligations.slice(0, 12).join("; "),
  );
}

type RepairWriteMapResult = {
  details?: {
    path?: string;
    size_bytes?: number;
    coverage_summary?: { covered?: string[]; gap?: string[]; total?: number };
    gap_warning?: string[] | null;
  };
  isError?: boolean;
};

function logRepairEvent(log: AgentifyLog, event: unknown): void {
  const value = event as {
    type?: string;
    message?: {
      role?: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: { total?: number };
      };
    };
    toolName?: string;
    tool_name?: string;
    result?: RepairWriteMapResult;
  };
  const eventType = value.type ?? "unknown";
  log.sessionEvent({ pi_event_type: eventType, event });
  if (eventType === "message_start" && value.message?.role === "user") {
    log.recordTurnStart();
  } else if (eventType === "message_end") {
    log.recordMessageEnd(value.message?.role, value.message?.usage);
  } else if (
    eventType === "tool_execution_end"
    && (value.toolName === "write_map" || value.toolName === "write_map_delta")
    && value.result?.isError !== true
    && value.result?.details?.path
  ) {
    log.mapWritten({
      path: value.result.details.path,
      size_bytes: value.result.details.size_bytes ?? 0,
      coverage_summary: {
        covered: value.result.details.coverage_summary?.covered ?? [],
        gap: value.result.details.coverage_summary?.gap ?? [],
        total: value.result.details.coverage_summary?.total ?? 10,
      },
      gap_warning: value.result.details.gap_warning ?? null,
    });
  }
}

function addCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return Number(((left ?? 0) + (right ?? 0)).toFixed(12));
}

function persistSpecialistCompilation(
  context: RunContext,
  sourceMap: CodebaseMap,
  compilation: SpecialistCompilationResult,
): void {
  if (compilation.map === sourceMap) return;
  writeCanonicalMap(context.cwd, compilation.map, {
    stateDir: AUDIT_STATE_RELATIVE_DIR,
    mapFilename: DEFAULT_MAP_FILENAME,
  });
}

function reviewCompiledPortfolio(
  context: RunContext, log: AgentifyLog, budget: AuditResourceBudget, compilation: SpecialistCompilationResult,
): Promise<SpecialistCompilationResult> {
  return reviewSpecialistCompilation({ ...context, auditLog: log }, compilation, budget, log.runId,
    map => { writeCanonicalMap(context.cwd, map, {
      stateDir: AUDIT_STATE_RELATIVE_DIR, mapFilename: DEFAULT_MAP_FILENAME,
    }); });
}

function announceCompiledPortfolio(
  context: RunContext,
  compilation: SpecialistCompilationResult,
): void {
  context.ui.info(
    `agentify: retained ${compilation.assessment.accepted_concerns.length} tracked specialist concern(s) and recorded ${compilation.assessment.rejected_concerns.length} ungrounded candidate(s) as rejected`,
  );
}

async function repairSpecialistPortfolio(
  context: RunContext,
  log: AgentifyLog,
  resourceBudget: AuditResourceBudget,
): Promise<{ turns: number; cost_usd: number | null }> {
  const stateDir = AUDIT_STATE_RELATIVE_DIR;
  const mapTools = createWriteMapTools({ stateDir });
  const systemPrompt = loadBuilderPrompt(stateDir);
  let turns = 0;
  let costUsd: number | null = null;
  let lastFingerprint = "unavailable";
  const initialMap = loadCanonicalMapAt(context.cwd, stateDir);
  if (initialMap === null) throw new Error("canonical codebase map disappeared before specialist repair");
  const trustedReceiptAttestation = initialMap.explorer_receipts;
  const explorerReceipts = new ExplorerReceiptTracker();
  if (trustedReceiptAttestation !== undefined) {
    explorerReceipts.loadAttestation(trustedReceiptAttestation);
  }
  const combinedReceiptAttestation = () => {
    const commit = currentRepositoryCommit(context.cwd);
    if (commit === null) throw new Error("cannot bind repaired explorer receipts to current HEAD");
    return explorerReceipts.attestation(commit, log.runId);
  };
  const preserveReceiptAttestation = (map: CodebaseMap | null): CodebaseMap | null => {
    if (map === null) return map;
    const attestation = combinedReceiptAttestation();
    if (JSON.stringify(map.explorer_receipts) === JSON.stringify(attestation)) return map;
    const preserved = { ...map, explorer_receipts: attestation };
    writeCanonicalMap(context.cwd, preserved, {
      stateDir: AUDIT_STATE_RELATIVE_DIR,
      mapFilename: DEFAULT_MAP_FILENAME,
    });
    return preserved;
  };
  const initialCompilation = compileSpecialistEvidence(initialMap, { cwd: context.cwd });
  persistSpecialistCompilation(context, initialMap, initialCompilation);
  const initialAssessment = initialCompilation.assessment;
  const baselineConcerns = new Set(
    initialAssessment.accepted_concerns.map((concern) => concern.trim().toLowerCase()),
  );
  const requireScout = initialAssessment.accepted_concerns.length === 0
    || [...initialAssessment.reasons, ...initialCompilation.reasons]
      .some((reason) => /thin specialist portfolio/i.test(reason));
  const persistCombinedReceiptAttestation = (map: CodebaseMap): void => {
    writeCanonicalMap(context.cwd, {
      ...map,
      explorer_receipts: combinedReceiptAttestation(),
    }, {
      stateDir: AUDIT_STATE_RELATIVE_DIR,
      mapFilename: DEFAULT_MAP_FILENAME,
    });
  };
  const receiptAssessmentFor = (
    map: CodebaseMap,
    assessment: SpecialistEvidenceAssessment,
  ) => explorerReceipts.assess(map, {
    requireScout,
    requiredConcerns: assessment.accepted_concerns.filter((concern) =>
      !baselineConcerns.has(concern.trim().toLowerCase())
    ),
  });

  const maxRepairPasses = resourceBudget.limits.maxSemanticRepairPasses;
  for (let pass = 1; pass <= maxRepairPasses; pass += 1) {
    resourceBudget.reserveSemanticRepairPass();
    const sourceMap = preserveReceiptAttestation(loadCanonicalMapAt(context.cwd, stateDir));
    if (sourceMap === null) throw new Error("canonical codebase map disappeared before specialist repair");
    const compilation = await reviewCompiledPortfolio(context, log, resourceBudget,
      compileSpecialistEvidence(sourceMap, { cwd: context.cwd }));
    persistSpecialistCompilation(context, sourceMap, compilation);
    const map = compilation.map;
    const assessment = compilation.assessment;
    const receiptAssessment = receiptAssessmentFor(map, assessment);
    if (compilation.complete && receiptAssessment.complete) {
      persistCombinedReceiptAttestation(map);
      announceCompiledPortfolio(context, compilation);
      return { turns, cost_usd: costUsd };
    }

    lastFingerprint = repairObligationFingerprint(compilation, receiptAssessment.reasons);
    if (!resourceBudget.recordUnresolvedFingerprint(lastFingerprint)) break;

    context.ui.status(
      `agentify: repairing incomplete specialist discovery (${pass}/${maxRepairPasses}; unresolved ${lastFingerprint.slice(0, 12)})`,
    );
    const repairController = new AbortController();
    const forwardAbort = (): void => repairController.abort();
    if (context.signal?.aborted) forwardAbort();
    else context.signal?.addEventListener("abort", forwardAbort, { once: true });
    const repairSessionBudget = resourceBudget.beginSession();
    let result: AgentRuntimeResult;
    try {
      result = await context.runtime.runSession({
      cwd: context.cwd,
      configDir: defaultConfigDir(),
      config: context.config,
      systemPrompt,
      userPrompt: repairPrompt(
        map,
        assessment,
        pass,
        maxRepairPasses,
        receiptAssessment.reasons,
        compilation.reasons,
      ),
      tools: [...REPAIR_TOOL_ALLOWLIST],
      executionPolicy: createReadOnlyExecutionPolicy({
        cwd: context.cwd,
        mode: "audit-readonly",
        tools: [],
        protectedPaths: [path.resolve(context.cwd)],
      }),
      customTools: [mapTools.writeMapDeltaTool],
      spawnExplorerAgentDir: defaultConfigDir(),
      spawnExplorerStateDir: stateDir,
      auditResourceBudget: resourceBudget,
      signal: repairController.signal,
      inactivityTimeoutMs: 5 * 60 * 1000,
      timeoutMs: resourceBudget.remainingDurationMs(REPAIR_TIMEOUT_MS),
      maxOutputTokens: resourceBudget.remainingOutputTokens(REPAIR_MAX_OUTPUT_TOKENS),
      recoveryPromptIfToolNotCalled: {
        requiredToolName: "write_map_delta",
        maxAttempts: 2,
        userPrompt:
          "Checkpoint only new not_concerns decisions through write_map_delta now; pass an empty concern list when tracer checkpoints already contain the repair. Do not retranscribe concern bodies or return prose.",
        shouldRecover: () => {
          const current = loadCanonicalMapAt(context.cwd, stateDir);
          return current !== null
            && !compileSpecialistEvidence(current, { cwd: context.cwd }).complete;
        },
      },
      onProviderRequest: (reservation) => resourceBudget.recordProviderRequest(repairSessionBudget, reservation),
      onEvent: (event) => {
        try {
          resourceBudget.observeParentEvent(event, repairSessionBudget);
        } catch {
          repairController.abort();
        }
        checkpointExplorerConcernEvidence(context.cwd, stateDir, event);
        explorerReceipts.observe(event);
        const value = event as { type?: string; toolName?: string; tool_name?: string };
        if (
          value.type === "tool_execution_end"
          && (value.toolName ?? value.tool_name) === "spawn_explorer"
        ) {
          const currentMap = loadCanonicalMapAt(context.cwd, stateDir);
          if (currentMap !== null) persistCombinedReceiptAttestation(currentMap);
        }
        logRepairEvent(log, event);
      },
      });
    } finally {
      context.signal?.removeEventListener("abort", forwardAbort);
    }
    resourceBudget.finishParentSession(repairSessionBudget, result);
    resourceBudget.assertWithinBudget();
    turns += result.turns;
    costUsd = addCost(costUsd, result.costUsd);

    const updatedSourceMap = preserveReceiptAttestation(loadCanonicalMapAt(context.cwd, stateDir));
    const updatedCompilation = updatedSourceMap === null
      ? null
      : await reviewCompiledPortfolio(context, log, resourceBudget,
        compileSpecialistEvidence(updatedSourceMap, { cwd: context.cwd }));
    if (updatedSourceMap !== null && updatedCompilation !== null) {
      persistSpecialistCompilation(context, updatedSourceMap, updatedCompilation);
    }
    const updatedAssessment = updatedCompilation?.assessment ?? null;
    const updatedReceiptAssessment = updatedCompilation === null || updatedAssessment === null
      ? null
      : receiptAssessmentFor(updatedCompilation.map, updatedAssessment);
    if (updatedCompilation?.complete && updatedReceiptAssessment?.complete) {
      persistCombinedReceiptAttestation(updatedCompilation.map);
      announceCompiledPortfolio(context, updatedCompilation);
      return { turns, cost_usd: costUsd };
    }
  }

  const finalSourceMap = preserveReceiptAttestation(loadCanonicalMapAt(context.cwd, stateDir));
  const finalCompilation = finalSourceMap === null
    ? null
    : await reviewCompiledPortfolio(context, log, resourceBudget,
      compileSpecialistEvidence(finalSourceMap, { cwd: context.cwd }));
  if (finalSourceMap !== null && finalCompilation !== null) {
    persistSpecialistCompilation(context, finalSourceMap, finalCompilation);
  }
  const finalReceiptAssessment = finalCompilation === null
    ? null
    : receiptAssessmentFor(finalCompilation.map, finalCompilation.assessment);
  if (finalCompilation?.complete && finalReceiptAssessment?.complete) {
    persistCombinedReceiptAttestation(finalCompilation.map);
    announceCompiledPortfolio(context, finalCompilation);
    return { turns, cost_usd: costUsd };
  }
  if (finalCompilation !== null) {
    lastFingerprint = repairObligationFingerprint(
      finalCompilation,
      finalReceiptAssessment?.reasons ?? [],
    );
  }
  throw new AuditBudgetExceededError(
    `repository specialist discovery did not reach semantic closure; unresolved-obligation fingerprint ${lastFingerprint}: `
      + [
        ...(finalCompilation?.reasons.slice(0, 12) ?? ["canonical map is unavailable"]),
        ...(finalReceiptAssessment?.reasons ?? []),
      ].join("; "),
  );
}

export async function runRepositoryAudit(context: RunContext): Promise<FocusedAuditResult> {
  const ownsLog = context.auditLog === undefined;
  const log = context.auditLog ?? new AgentifyLog({ cwd: context.cwd, configDir: defaultConfigDir() });
  const deferCompletion = context.deferAuditLogCompletion === true;
  if (deferCompletion && ownsLog) throw new Error("deferred audit logging requires a caller-owned AgentifyLog");
  const startedAt = Date.now();
  const initialMap = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
  const initialCommit = currentRepositoryCommit(context.cwd);
  const priorCheckpoint = initialCommit !== null
    && initialMap?.audit_budget_checkpoint?.repository_commit === initialCommit
    ? initialMap.audit_budget_checkpoint
    : undefined;
  const resourceBudget = context.auditResourceBudget
    ?? new AuditResourceBudget(
      context.config.auditBudgets,
      startedAt,
      priorCheckpoint?.usage,
      priorCheckpoint?.unresolved_fingerprints,
    );
  const checkpointRunCount = (priorCheckpoint?.run_count ?? 0) + 1;
  let budgetCheckpointPersisted = false;
  const persistBudgetCheckpoint = (): void => {
    if (budgetCheckpointPersisted) return;
    const map = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
    const repositoryCommit = currentRepositoryCommit(context.cwd);
    if (map === null || repositoryCommit === null) return;
    writeCanonicalMap(context.cwd, {
      ...map,
      audit_budget_checkpoint: {
        repository_commit: repositoryCommit,
        run_count: checkpointRunCount,
        usage: resourceBudget.snapshot(),
        unresolved_fingerprints: resourceBudget.unresolvedFingerprints(),
      },
    }, {
      stateDir: AUDIT_STATE_RELATIVE_DIR,
      mapFilename: DEFAULT_MAP_FILENAME,
    });
    budgetCheckpointPersisted = true;
  };
  let terminalWritten = false;
  const checkpointOnSignal = (exitCode: number): void => {
    try {
      persistBudgetCheckpoint();
      log.auditBudget({
        status: "failed",
        limits: { ...resourceBudget.limits },
        usage: resourceBudget.snapshot(),
      });
    } catch (error) {
      if (!deferCompletion) log.runEnd({
        exit_code: exitCode,
        status: "error",
        error_message: `Could not checkpoint interrupted audit usage: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
  // Checkpoint inside the pending transaction so rollback also removes its history.
  const checkpointOnSigint = (): void => checkpointOnSignal(130);
  const checkpointOnSigterm = (): void => checkpointOnSignal(143);
  process.prependOnceListener("SIGINT", checkpointOnSigint);
  process.prependOnceListener("SIGTERM", checkpointOnSigterm);
  try {
    const result = await runBaseRepositoryAudit({
      ...context,
      auditResourceBudget: resourceBudget,
      auditLog: log,
      deferAuditLogCompletion: true,
    });
    const map = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
    if (map === null) throw new Error("repository audit returned without a canonical codebase map");
    const compilation = await reviewCompiledPortfolio(context, log, resourceBudget,
      compileSpecialistEvidence(map, { cwd: context.cwd }));
    persistSpecialistCompilation(context, map, compilation);
    let repair = { turns: 0, cost_usd: null as number | null };
    if (compilation.complete) {
      announceCompiledPortfolio(context, compilation);
    } else {
      context.ui.info(
        "agentify: coverage closed, but specialist discovery was incomplete; running a bounded semantic repair",
      );
      repair = await repairSpecialistPortfolio(context, log, resourceBudget);
    }

    const finalSourceMap = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
    if (finalSourceMap === null) {
      throw new Error("canonical codebase map disappeared after specialist repair");
    }
    const finalCompilation = compileSpecialistEvidence(finalSourceMap, { cwd: context.cwd });
    persistSpecialistCompilation(context, finalSourceMap, finalCompilation);
    if (!finalCompilation.complete) {
      throw new Error(
        `repository specialist discovery did not reach semantic closure: ${finalCompilation.reasons.join("; ")}`,
      );
    }
    const reviewReasons = assessSpecialistReviews(finalCompilation.map, context.cwd);
    if (reviewReasons.length > 0) throw new Error(`specialist narrative review incomplete: ${reviewReasons.join("; ")}`);
    const receiptAttestation = assessExplorerReceiptAttestation(
      finalCompilation.map,
      context.cwd,
    );
    if (!receiptAttestation.complete) {
      throw new Error(
        `repository specialist discovery lacks current explorer attestation: ${receiptAttestation.reasons.join("; ")}`,
      );
    }
    const coverage = assessCoverageClosure(finalCompilation.map, { cwd: context.cwd });
    resourceBudget.assertWithinBudget();
    persistBudgetCheckpoint();
    log.auditBudget({
      status: "within",
      limits: { ...resourceBudget.limits },
      usage: resourceBudget.snapshot(),
    });
    log.sessionEnd({
      duration_ms: Date.now() - startedAt,
      was_aborted: false,
      status: "success",
    });
    if (!deferCompletion) log.runEnd({
      exit_code: 0,
      status: "success",
      coverage: {
        covered: coverage.closed.length,
        gap: coverage.unresolved.length,
        total: coverage.closed.length + coverage.unresolved.length,
      },
      agents_md_path: null,
    });
    terminalWritten = true;
    if (!deferCompletion) context.ui.info(`agentify: audit log written to ${log.logPath}`);
    return {
      ...result,
      turns: result.turns + repair.turns,
      cost_usd: addCost(result.cost_usd, repair.cost_usd),
    };
  } catch (error) {
    if (!terminalWritten) {
      const map = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
      const coverage = map === null ? null : assessCoverageClosure(map, { cwd: context.cwd });
      const reportedError = error instanceof AuditBudgetExceededError
        ? actionableBudgetError(error, map, context.cwd)
        : error;
      persistBudgetCheckpoint();
      log.sessionEnd({
        duration_ms: Date.now() - startedAt,
        was_aborted: context.signal?.aborted === true,
        status: "error",
      });
      log.auditBudget({
        status: error instanceof AuditBudgetExceededError ? "exhausted" : "failed",
        limits: { ...resourceBudget.limits },
        usage: resourceBudget.snapshot(),
      });
      if (!deferCompletion) log.runEnd({
        exit_code: -1,
        status: "error",
        error_message: reportedError instanceof Error ? reportedError.message : String(reportedError),
        coverage: coverage === null ? undefined : {
          covered: coverage.closed.length,
          gap: coverage.unresolved.length,
          total: coverage.closed.length + coverage.unresolved.length,
        },
        agents_md_path: null,
      });
      if (!deferCompletion) context.ui.info(`agentify: audit log written to ${log.logPath}`);
      throw reportedError;
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", checkpointOnSigint);
    process.removeListener("SIGTERM", checkpointOnSigterm);
    if (ownsLog) await log.close();
  }
}
