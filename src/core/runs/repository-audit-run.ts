import * as path from "node:path";
import { defaultConfigDir } from "../agentify-config.ts";
import { AgentifyLog } from "../audit/log.ts";
import { DEFAULT_MAP_FILENAME, writeCanonicalMap } from "../audit/map-storage.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { loadBuilderPrompt } from "../audit/prompt.ts";
import {
  assessCoverageClosure,
  assessSpecialistEvidence,
  reconcileSpecialistEvidence,
  type CodebaseMap,
  type SpecialistEvidenceAssessment,
} from "../audit/schema.ts";
import { createWriteMapTools, loadCanonicalMapAt } from "../audit/write-map-tool.ts";
import { createReadOnlyExecutionPolicy } from "../security/execution-policy.ts";
import type { RunContext } from "./run-context.ts";
import {
  ProviderAuthFailedError,
  runRepositoryAudit as runBaseRepositoryAudit,
  type FocusedAuditResult,
} from "./repository-audit-run-core.ts";

export { ProviderAuthFailedError };
export type { FocusedAuditResult };

const REPAIR_TOOL_ALLOWLIST = [
  "read",
  "grep",
  "find",
  "ls",
  "write_map",
  "write_map_delta",
  "spawn_explorer",
];
const MAX_REPAIR_PASSES = 6;
const MAX_STALLED_REPAIR_PASSES = 2;
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

function repairPrompt(assessment: SpecialistEvidenceAssessment, pass: number): string {
  const needsBroadDiscovery = pass === 1 && (
    assessment.accepted_concerns.length === 0
    || assessment.reasons.some((reason) => /thin specialist portfolio/i.test(reason))
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
    `Repair pass ${pass}/${MAX_REPAIR_PASSES}; ${assessment.uncovered_paths.length} tracked paths and ${assessment.uncovered_clusters.length} local implementation/test clusters remain in total.`,
    `Current failures: ${assessment.reasons.slice(0, 12).join("; ")}.`,
    `Accepted concerns to preserve: ${assessment.accepted_concerns.join(", ") || "none"}.`,
    `Current tracked-path batch: ${uncovered}.`,
    `Current local implementation/test-cluster batch: ${uncoveredClusters}.`,
    `Concern candidates rejected by trusted evidence binding: ${rejected}.`,
    needsBroadDiscovery
      ? "Run concern_scout against the repository root once, then one concern_tracer for each retained candidate."
      : "Do not rerun a broad concern scout. Repair only the named tracked gaps and rejected candidates, preserving accepted concerns.",
    "A repository path is evidence only when that exact path is a regular Git blob tracked at HEAD. Extensionless tracked files such as Jenkinsfiles are valid; fetched dependencies, ignored/generated outputs, symlinks, path templates, glob expressions, and process labels are not.",
    "Trace every retained concern through at least two ordered tracked operations and record at least one tracked core touchpoint. Distinct operations may occur in the same orchestration file; duplicated padding is not a trace.",
    "For each uncovered tracked path, add it to the appropriate concern as a real touchpoint/flow step, or put its exact path in not_concerns.candidate with a repository-specific reason.",
    "Implementation/test clusters are path-local. Trace both sides when they form a cohesive recurring contract; otherwise attach them to an existing concern or explicitly reject the exact paths.",
    "Treat a concern's excludes statement as negative evidence. Never attach a path or cluster to a concern that excludes that behavior; retain or create the adjacent concern, or reject the exact path with repository-specific evidence.",
    "A high-signal implementation shared by multiple concerns is not closed by supporting mentions. Record one explicit core touchpoint under the concern whose verified flow owns the behavior, or create a distinct concern.",
    "Shared files must appear under every concern they serve with the role they play in that concern; overlap is expected and must never cause merging.",
    "Do not include .agentify/** or .github/agentify/** as repository architecture, specialists, or application evidence.",
    "Replace concern_evidence atomically through write_map_delta, preserving accepted concerns and recording rejected candidates in not_concerns. Omit the dimension parameter because concern evidence closes no D1-D10 dimension.",
    "Do not modify application files, workflows, dependencies, prompts, or documentation. Do not return prose instead of the structured write_map_delta call.",
  ].join(" ");
}

function repairImproved(
  before: SpecialistEvidenceAssessment,
  after: SpecialistEvidenceAssessment,
): boolean {
  return after.complete
    || after.uncovered_paths.length < before.uncovered_paths.length
    || after.uncovered_clusters.length < before.uncovered_clusters.length
    || after.accepted_concerns.length > before.accepted_concerns.length
    || after.rejected_concerns.length < before.rejected_concerns.length;
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
    log.incrementTurns();
    log.recordTurnEnd(value.message?.usage);
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

function persistTrustedConcernProjection(
  context: RunContext,
  map: CodebaseMap,
  assessment: SpecialistEvidenceAssessment,
): void {
  const reconciled = reconcileSpecialistEvidence(map, assessment);
  if (reconciled === map) return;
  writeCanonicalMap(context.cwd, reconciled, {
    stateDir: AUDIT_STATE_RELATIVE_DIR,
    mapFilename: DEFAULT_MAP_FILENAME,
  });
  context.ui.info(
    `agentify: retained ${assessment.accepted_concerns.length} tracked specialist concern(s) and recorded ${assessment.rejected_concerns.length} ungrounded candidate(s) as rejected`,
  );
}

async function repairSpecialistPortfolio(
  context: RunContext,
  log: AgentifyLog,
): Promise<{ turns: number; cost_usd: number | null }> {
  const stateDir = AUDIT_STATE_RELATIVE_DIR;
  const mapTools = createWriteMapTools({ stateDir });
  const systemPrompt = loadBuilderPrompt(stateDir);
  let turns = 0;
  let costUsd: number | null = null;
  let stalledPasses = 0;

  for (let pass = 1; pass <= MAX_REPAIR_PASSES; pass += 1) {
    const map = loadCanonicalMapAt(context.cwd, stateDir);
    if (map === null) throw new Error("canonical codebase map disappeared before specialist repair");
    const assessment = assessSpecialistEvidence(map, { cwd: context.cwd });
    if (assessment.complete) {
      persistTrustedConcernProjection(context, map, assessment);
      return { turns, cost_usd: costUsd };
    }

    context.ui.status(
      `agentify: repairing incomplete specialist discovery (${pass}/${MAX_REPAIR_PASSES})`,
    );
    const result = await context.runtime.runSession({
      cwd: context.cwd,
      configDir: defaultConfigDir(),
      config: context.config,
      systemPrompt,
      userPrompt: repairPrompt(assessment, pass),
      tools: [...REPAIR_TOOL_ALLOWLIST],
      executionPolicy: createReadOnlyExecutionPolicy({
        cwd: context.cwd,
        mode: "audit-readonly",
        tools: ["read", "grep", "find", "ls"],
        protectedPaths: [path.resolve(context.cwd)],
      }),
      customTools: [mapTools.writeMapTool, mapTools.writeMapDeltaTool],
      spawnExplorerAgentDir: defaultConfigDir(),
      spawnExplorerStateDir: stateDir,
      signal: context.signal,
      inactivityTimeoutMs: 5 * 60 * 1000,
      timeoutMs: REPAIR_TIMEOUT_MS,
      maxOutputTokens: REPAIR_MAX_OUTPUT_TOKENS,
      recoveryPromptIfToolNotCalled: {
        requiredToolName: "write_map_delta",
        maxAttempts: 2,
        userPrompt:
          "Submit the repaired concern_evidence through write_map_delta now. Do not return prose.",
        shouldRecover: () => {
          const current = loadCanonicalMapAt(context.cwd, stateDir);
          return current !== null
            && !assessSpecialistEvidence(current, { cwd: context.cwd }).complete;
        },
      },
      onEvent: (event) => logRepairEvent(log, event),
    });
    turns += result.turns;
    costUsd = addCost(costUsd, result.costUsd);

    const updatedMap = loadCanonicalMapAt(context.cwd, stateDir);
    const updatedAssessment = updatedMap === null
      ? null
      : assessSpecialistEvidence(updatedMap, { cwd: context.cwd });
    if (updatedAssessment?.complete) {
      persistTrustedConcernProjection(context, updatedMap!, updatedAssessment);
      return { turns, cost_usd: costUsd };
    }
    if (updatedAssessment !== null && repairImproved(assessment, updatedAssessment)) {
      stalledPasses = 0;
    } else {
      stalledPasses += 1;
      if (stalledPasses >= MAX_STALLED_REPAIR_PASSES) break;
    }
  }

  const finalMap = loadCanonicalMapAt(context.cwd, stateDir);
  const finalAssessment = finalMap === null
    ? null
    : assessSpecialistEvidence(finalMap, { cwd: context.cwd });
  if (finalMap !== null && finalAssessment !== null && finalAssessment.complete) {
    persistTrustedConcernProjection(context, finalMap, finalAssessment);
    return { turns, cost_usd: costUsd };
  }
  throw new Error(
    "repository specialist discovery did not reach semantic closure: "
      + (finalAssessment?.reasons.slice(0, 12).join("; ") ?? "canonical map is unavailable"),
  );
}

export async function runRepositoryAudit(context: RunContext): Promise<FocusedAuditResult> {
  const log = new AgentifyLog({ cwd: context.cwd, configDir: defaultConfigDir() });
  const startedAt = Date.now();
  let terminalWritten = false;
  try {
    const result = await runBaseRepositoryAudit({
      ...context,
      auditLog: log,
      deferAuditLogCompletion: true,
    });
    const map = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
    if (map === null) throw new Error("repository audit returned without a canonical codebase map");
    const assessment = assessSpecialistEvidence(map, { cwd: context.cwd });
    let repair = { turns: 0, cost_usd: null as number | null };
    if (assessment.complete) {
      persistTrustedConcernProjection(context, map, assessment);
    } else {
      context.ui.info(
        "agentify: coverage closed, but specialist discovery was incomplete; running a bounded semantic repair",
      );
      repair = await repairSpecialistPortfolio(context, log);
    }

    const finalMap = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
    if (finalMap === null) throw new Error("canonical codebase map disappeared after specialist repair");
    const finalAssessment = assessSpecialistEvidence(finalMap, { cwd: context.cwd });
    if (!finalAssessment.complete) {
      throw new Error(
        `repository specialist discovery did not reach semantic closure: ${finalAssessment.reasons.join("; ")}`,
      );
    }
    const coverage = assessCoverageClosure(finalMap, { cwd: context.cwd });
    log.sessionEnd({
      duration_ms: Date.now() - startedAt,
      was_aborted: false,
      status: "success",
    });
    log.runEnd({
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
    context.ui.info(`agentify: audit log written to ${log.logPath}`);
    return {
      ...result,
      turns: result.turns + repair.turns,
      cost_usd: addCost(result.cost_usd, repair.cost_usd),
    };
  } catch (error) {
    if (!terminalWritten) {
      const map = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
      const coverage = map === null ? null : assessCoverageClosure(map, { cwd: context.cwd });
      log.sessionEnd({
        duration_ms: Date.now() - startedAt,
        was_aborted: context.signal?.aborted === true,
        status: "error",
      });
      log.runEnd({
        exit_code: -1,
        status: "error",
        error_message: error instanceof Error ? error.message : String(error),
        coverage: coverage === null ? undefined : {
          covered: coverage.closed.length,
          gap: coverage.unresolved.length,
          total: coverage.closed.length + coverage.unresolved.length,
        },
        agents_md_path: null,
      });
      context.ui.info(`agentify: audit log written to ${log.logPath}`);
    }
    throw error;
  } finally {
    await log.close();
  }
}
