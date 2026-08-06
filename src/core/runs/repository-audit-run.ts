import * as crypto from "node:crypto";
import * as path from "node:path";
import { PI_SDK_VERSION } from "../pi-sdk-version.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { defaultConfigDir } from "../agentify-config.ts";
import { AgentifyLog } from "../audit/log.ts";
import { createGapDraftMap } from "../audit/map-draft.ts";
import { DEFAULT_MAP_FILENAME, writeCanonicalMap } from "../audit/map-storage.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { loadBuilderPrompt } from "../audit/prompt.ts";
import { COVERAGE_DIMENSIONS, assessCoverageClosure } from "../audit/schema.ts";
import {
  setThinkingLevel,
} from "../audit/state.ts";
import { createWriteMapTools, loadCanonicalMapAt } from "../audit/write-map-tool.ts";
import { readPackageVersion } from "../package-version.ts";
import { packageRoot } from "../pi-sdk-runtime.ts";
import { createReadOnlyExecutionPolicy } from "../security/execution-policy.ts";
import { startSpinner, type SpinnerHandle } from "../ui/spinner.ts";
import type { RunContext } from "./run-context.ts";

const AUDIT_TOOL_ALLOWLIST = [
  "read",
  "grep",
  "find",
  "ls",
  "write_map",
  "write_map_delta",
  "spawn_explorer",
];

type AssistantUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

type WriteMapResult = {
  details?: {
    path?: string;
    size_bytes?: number;
    coverage_summary?: {
      covered?: string[];
      gap?: string[];
      total?: number;
    };
    gap_warning?: string[] | null;
  };
  isError?: boolean;
};

export interface FocusedAuditResult {
  map_path: string;
  covered_dimensions: number;
  total_dimensions: number;
  turns: number;
  cost_usd: number | null;
}

function extractUsage(event: AgentSessionEvent): AssistantUsage | undefined {
  const maybe = event as { type?: string; message?: { usage?: AssistantUsage } };
  return maybe.type === "message_end" ? maybe.message?.usage : undefined;
}

function auditActivityForTool(toolName: string): string {
  switch (toolName) {
    case "read":
    case "grep":
    case "find":
    case "ls":
      return "Inspecting repository files and source patterns…";
    case "write_map":
    case "write_map_delta":
      return "Recording the validated codebase map and evidence…";
    case "spawn_explorer":
      return "Launching a focused read-only explorer…";
    default:
      return "Reviewing the repository evidence…";
  }
}

function mapResult(result: WriteMapResult | undefined): {
  path: string;
  size_bytes: number;
  covered: string[];
  gap: string[];
  total: number;
  gap_warning: string[] | null;
} | null {
  if (!result || result.isError || !result.details?.path) return null;
  return {
    path: result.details.path,
    size_bytes: result.details.size_bytes ?? 0,
    covered: result.details.coverage_summary?.covered ?? [],
    gap: result.details.coverage_summary?.gap ?? [],
    total: result.details.coverage_summary?.total ?? COVERAGE_DIMENSIONS.length,
    gap_warning: result.details.gap_warning ?? null,
  };
}

function focusedAuditPrompt(): string {
  return [
    "Audit this existing repository for its persistent Agentify engineering team.",
    "Use only read-only repository tools and the structured write_map/write_map_delta tools.",
    "A gap-marked map is already present; after initial direct reads, call write_map_delta with concrete repository evidence.",
    "Close every supportable coverage dimension and leave unsupported claims as explicit gaps.",
    "The map is internal operational evidence for specialists and task planning.",
    "Do not write application files, AGENTS.md, harness configuration, skills, prompts, workflows, dependencies, or prose artifacts.",
    "Do not create a generic agent surface. Repository-specific specialists and procedures are materialized later from validated evidence.",
    "Do not return prose instead of the required structured tool call.",
  ].join(" ");
}

/**
 * Produce the one validated map required by the focused installer. The
 * canonical map is the deliberately versioned exception beneath
 * `.agentify/runtime`, so installed workflows receive the same validated
 * routing evidence. Audit history and other transient runtime state stay
 * ignored by Git.
 */
export async function runRepositoryAudit(context: RunContext): Promise<FocusedAuditResult> {
  const stateDir = AUDIT_STATE_RELATIVE_DIR;
  const mapTools = createWriteMapTools({ stateDir });
  const promptContent = loadBuilderPrompt(stateDir);
  const promptSha = crypto.createHash("sha256").update(promptContent).digest("hex");
  const log = new AgentifyLog({ cwd: context.cwd, configDir: defaultConfigDir() });
  const startedAt = Date.now();
  setThinkingLevel(context.config.thinkingLevel);

  log.runStart({
    cwd: context.cwd,
    args: "",
    model: context.config.models.primary?.model ?? "auto",
    thinking_level: context.config.thinkingLevel,
    agentify_version: readPackageVersion(packageRoot()),
    sdk_version: PI_SDK_VERSION,
    system_prompt_sha256: promptSha,
    system_prompt_path: "src/core/audit/prompts/builder.md",
    tool_allowlist: AUDIT_TOOL_ALLOWLIST,
  });

  const bootstrappedGapDraft = loadCanonicalMapAt(context.cwd, stateDir) === null;
  if (bootstrappedGapDraft) {
    writeCanonicalMap(context.cwd, createGapDraftMap(), {
      stateDir,
      mapFilename: DEFAULT_MAP_FILENAME,
    });
  }

  const spinner: SpinnerHandle = startSpinner("starting focused repository audit…");
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (context.signal?.aborted) forwardAbort();
  else context.signal?.addEventListener("abort", forwardAbort, { once: true });
  let controlledClosure = false;
  let spinnerStopped = false;
  let observedTurns = 0;
  let observedCost = 0;
  context.ui.status("agentify: auditing existing repository");

  try {
    const runtimeResult = await context.runtime.runSession({
      cwd: context.cwd,
      configDir: defaultConfigDir(),
      config: context.config,
      systemPrompt: promptContent,
      userPrompt: focusedAuditPrompt(),
      tools: [...AUDIT_TOOL_ALLOWLIST],
      executionPolicy: createReadOnlyExecutionPolicy({
        cwd: context.cwd,
        mode: "audit-readonly",
        tools: ["read", "grep", "find", "ls"],
        protectedPaths: [path.resolve(context.cwd)],
      }),
      customTools: [mapTools.writeMapTool, mapTools.writeMapDeltaTool],
      spawnExplorerAgentDir: defaultConfigDir(),
      spawnExplorerStateDir: stateDir,
      signal: controller.signal,
      inactivityTimeoutMs: 5 * 60 * 1000,
      recoveryPromptIfToolNotCalled: {
        requiredToolName: bootstrappedGapDraft ? "write_map_delta" : "write_map",
        maxAttempts: 2,
        userPrompt: "Read the current map and submit the strongest evidence already gathered through write_map_delta. Leave genuinely unsupported dimensions as gaps; do not return prose.",
        shouldRecover: () => {
          const map = loadCanonicalMapAt(context.cwd, stateDir);
          return map !== null && assessCoverageClosure(map).unresolved.length > 0;
        },
      },
      onEvent: (event) => {
        const eventType = (event as { type?: string }).type ?? "unknown";
        log.sessionEvent({ pi_event_type: eventType, event });
        if (eventType === "message_start" && (event as { message?: { role?: string } }).message?.role === "user") {
          log.recordTurnStart();
        } else if (eventType === "message_end") {
          log.incrementTurns();
          const usage = extractUsage(event);
          log.recordTurnEnd(usage);
          observedTurns += 1;
          if (typeof usage?.cost?.total === "number") observedCost += usage.cost.total;
          const currentMap = loadCanonicalMapAt(context.cwd, stateDir);
          if (currentMap && assessCoverageClosure(currentMap).unresolved.length === 0) {
            controlledClosure = true;
            controller.abort();
          }
        } else if (eventType === "tool_execution_start") {
          const toolName = (event as { toolName?: string; tool_name?: string }).toolName
            ?? (event as { tool_name?: string }).tool_name
            ?? "unknown";
          spinner.update(auditActivityForTool(toolName));
        } else if (eventType === "tool_execution_end") {
          const toolEvent = event as { toolName?: string; result?: WriteMapResult };
          if (toolEvent.toolName === "write_map" || toolEvent.toolName === "write_map_delta") {
            const written = mapResult(toolEvent.result);
            if (written) {
              log.mapWritten({
                path: written.path,
                size_bytes: written.size_bytes,
                coverage_summary: {
                  covered: written.covered,
                  gap: written.gap,
                  total: written.total,
                },
                gap_warning: written.gap_warning,
              });
              if (
                written.covered.length === written.total
                && written.gap.length === 0
                && (written.gap_warning?.length ?? 0) === 0
              ) {
                controlledClosure = true;
                controller.abort();
              }
            }
          }
        }
      },
    });

    const map = loadCanonicalMapAt(context.cwd, stateDir);
    const closure = map === null
      ? { closed: [] as string[], unresolved: [...COVERAGE_DIMENSIONS], reasons: {} as Record<string, string> }
      : assessCoverageClosure(map);
    const intentionallyStopped = runtimeResult.aborted && controlledClosure;
    const success = map !== null && closure.unresolved.length === 0 && (!runtimeResult.aborted || intentionallyStopped);
    const status = success ? "success" : runtimeResult.aborted ? "aborted" : "partial";
    log.sessionEnd({
      duration_ms: Date.now() - startedAt,
      was_aborted: runtimeResult.aborted && !intentionallyStopped,
      status,
    });
    log.runEnd({
      exit_code: success ? 0 : -1,
      status,
      coverage: {
        covered: closure.closed.length,
        gap: closure.unresolved.length,
        total: COVERAGE_DIMENSIONS.length,
      },
      agents_md_path: null,
    });
    if (!success) {
      const reasons = closure.unresolved
        .slice(0, 8)
        .map((dimension) => `${dimension}: ${closure.reasons[dimension] ?? "not closed"}`);
      throw new Error(
        `repository audit did not reach structured closure (${closure.closed.length}/${COVERAGE_DIMENSIONS.length}); ${reasons.join("; ")}`,
      );
    }

    spinner.stop("repository audit complete", "success");
    spinnerStopped = true;
    context.ui.info(`agentify: validated codebase map written to ${stateDir}/${DEFAULT_MAP_FILENAME}`);
    context.ui.info(`agentify: audit log written to ${log.logPath}`);
    return {
      map_path: `${stateDir}/${DEFAULT_MAP_FILENAME}`,
      covered_dimensions: closure.closed.length,
      total_dimensions: COVERAGE_DIMENSIONS.length,
      turns: runtimeResult.turns || observedTurns,
      cost_usd: runtimeResult.costUsd ?? (observedCost > 0 ? observedCost : null),
    };
  } catch (error) {
    log.runEnd({
      exit_code: -1,
      status: "error",
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    context.signal?.removeEventListener("abort", forwardAbort);
    if (!spinnerStopped) spinner.stop("repository audit failed", "error");
    await log.close();
  }
}
