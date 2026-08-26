import * as path from "node:path";
import { defaultConfigDir } from "../agentify-config.ts";
import { DEFAULT_MAP_FILENAME, writeCanonicalMap } from "../audit/map-storage.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { loadBuilderPrompt } from "../audit/prompt.ts";
import {
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
const MAX_REPAIR_PASSES = 2;
const REPAIR_TIMEOUT_MS = 20 * 60 * 1000;
const REPAIR_MAX_OUTPUT_TOKENS = 65_536;

function repairPrompt(assessment: SpecialistEvidenceAssessment): string {
  const needsBroadDiscovery = assessment.accepted_concerns.length === 0
    || assessment.reasons.some((reason) => /thin specialist portfolio/i.test(reason));
  const uncovered = assessment.uncovered_paths.length > 0
    ? assessment.uncovered_paths.slice(0, 24).join(", ")
    : "none";
  const rejected = assessment.rejected_concerns.length > 0
    ? assessment.rejected_concerns
      .slice(0, 12)
      .map((entry) => `${entry.concern} (${entry.reasons.join("; ")})`)
      .join(", ")
    : "none";
  const uncoveredClusters = assessment.uncovered_clusters.length > 0
    ? assessment.uncovered_clusters.slice(0, 12).map((cluster) =>
      `${cluster.cluster_key}: ${[...cluster.implementation_paths, ...cluster.test_paths].join(", ")}`
    ).join("; ")
    : "none";

  return [
    "The repository's coverage map is complete, but its specialist portfolio failed the trusted semantic-quality gate.",
    `Current failures: ${assessment.reasons.slice(0, 12).join("; ")}.`,
    `Accepted concerns to preserve: ${assessment.accepted_concerns.join(", ") || "none"}.`,
    `Tracked high-signal files still unaccounted for: ${uncovered}.`,
    `Repository implementation/test clusters still unaccounted for: ${uncoveredClusters}.`,
    `Concern candidates rejected by trusted evidence binding: ${rejected}.`,
    needsBroadDiscovery
      ? "Run concern_scout against the repository root once, then one concern_tracer for each retained candidate."
      : "Do not rerun a broad concern scout. Repair only the named tracked gaps and rejected candidates, preserving accepted concerns.",
    "A repository path is evidence only when that exact path is a regular Git blob tracked at HEAD. Extensionless tracked files such as Jenkinsfiles are valid; fetched dependencies, ignored/generated outputs, symlinks, path templates, glob expressions, and process labels are not.",
    "Trace every retained concern through at least two ordered tracked steps and record at least one tracked core touchpoint. A flow may revisit the same orchestration file around another step; do not collapse ordered steps into a set of filenames.",
    "For each uncovered tracked path, add it to the appropriate concern as a real touchpoint/flow step, or put its exact path in not_concerns.candidate with a repository-specific reason.",
    "For each implementation/test cluster, trace the behavior through both implementation and authoritative tests. Create a distinct specialist when the cluster is a cohesive recurring contract; otherwise attach both sides to an existing concern or explicitly reject the exact paths.",
    "Remove or retrace any rejected concern whose evidence is only fetched, generated, ignored, or conceptual. Do not preserve it merely because one supporting tracked file was mentioned.",
    "Shared files must appear under every concern they serve with the role they play in that concern; overlap is expected and must never cause merging.",
    "Do not include .agentify/** or .github/agentify/** as repository architecture, specialists, or application evidence.",
    "Set meta.project_type and meta.languages/formats from the code actually observed; do not leave them unknown.",
    "Replace concern_evidence atomically through write_map_delta, preserving accepted concerns and recording rejected candidates in not_concerns. Omit the dimension parameter because concern evidence closes no D1-D10 dimension.",
    "Do not modify application files, workflows, dependencies, prompts, or documentation. Do not return prose instead of the structured write_map_delta call.",
  ].join(" ");
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
): Promise<{ turns: number; cost_usd: number | null }> {
  const stateDir = AUDIT_STATE_RELATIVE_DIR;
  const mapTools = createWriteMapTools({ stateDir });
  const systemPrompt = loadBuilderPrompt(stateDir);
  let turns = 0;
  let costUsd: number | null = null;

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
      userPrompt: repairPrompt(assessment),
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
    });
    turns += result.turns;
    costUsd = addCost(costUsd, result.costUsd);
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
  const result = await runBaseRepositoryAudit(context);
  const map = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
  if (map === null) throw new Error("repository audit returned without a canonical codebase map");
  const assessment = assessSpecialistEvidence(map, { cwd: context.cwd });
  if (assessment.complete) {
    persistTrustedConcernProjection(context, map, assessment);
    return result;
  }

  context.ui.info(
    "agentify: coverage closed, but specialist discovery was incomplete; running a bounded semantic repair",
  );
  const repair = await repairSpecialistPortfolio(context);
  return {
    ...result,
    turns: result.turns + repair.turns,
    cost_usd: addCost(result.cost_usd, repair.cost_usd),
  };
}
