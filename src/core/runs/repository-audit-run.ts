import * as path from "node:path";
import { defaultConfigDir } from "../agentify-config.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { loadBuilderPrompt } from "../audit/prompt.ts";
import { assessSpecialistEvidence } from "../audit/schema.ts";
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

function repairPrompt(reasons: ReadonlyArray<string>): string {
  return [
    "The repository's coverage map is complete, but its specialist portfolio failed the trusted semantic-quality gate.",
    `Current failures: ${reasons.slice(0, 12).join("; ")}.`,
    "This is not a request for a generic role list. Discover the actual cross-cutting bodies of knowledge in this repository.",
    "Run concern_scout against the repository root exactly once, then run one concern_tracer for every retained candidate.",
    "Trace every concern from an observed entry point to an observed effect and record at least one core touchpoint.",
    "Account for every high-signal file named by entry points, module boundaries, type contracts, pitfalls, and build recipes: include it in the appropriate concern, or cite its exact path in not_concerns with a repository-specific reason.",
    "Shared files must appear under every concern they serve with the role they play in that concern; overlap is expected and must never cause merging.",
    "Do not include .agentify/** or .github/agentify/** as repository architecture, specialists, or application evidence.",
    "Set meta.project_type and meta.languages/formats from the code actually observed; do not leave them unknown.",
    "Persist the repaired result through write_map_delta as concern_evidence.concerns and concern_evidence.not_concerns. Omit the dimension parameter because concern evidence closes no D1-D10 dimension.",
    "Do not modify application files, workflows, dependencies, prompts, or documentation. Do not return prose instead of the structured write_map_delta call.",
  ].join(" ");
}

function addCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return Number(((left ?? 0) + (right ?? 0)).toFixed(12));
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
    const assessment = assessSpecialistEvidence(map);
    if (assessment.complete) return { turns, cost_usd: costUsd };

    context.ui.status(
      `agentify: repairing incomplete specialist discovery (${pass}/${MAX_REPAIR_PASSES})`,
    );
    const result = await context.runtime.runSession({
      cwd: context.cwd,
      configDir: defaultConfigDir(),
      config: context.config,
      systemPrompt,
      userPrompt: repairPrompt(assessment.reasons),
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
          return current !== null && !assessSpecialistEvidence(current).complete;
        },
      },
    });
    turns += result.turns;
    costUsd = addCost(costUsd, result.costUsd);
  }

  const finalMap = loadCanonicalMapAt(context.cwd, stateDir);
  const finalAssessment = finalMap === null ? null : assessSpecialistEvidence(finalMap);
  throw new Error(
    "repository specialist discovery did not reach semantic closure: "
      + (finalAssessment?.reasons.slice(0, 12).join("; ") ?? "canonical map is unavailable"),
  );
}

export async function runRepositoryAudit(context: RunContext): Promise<FocusedAuditResult> {
  const result = await runBaseRepositoryAudit(context);
  const map = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
  if (map === null) throw new Error("repository audit returned without a canonical codebase map");
  const assessment = assessSpecialistEvidence(map);
  if (assessment.complete) return result;

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
