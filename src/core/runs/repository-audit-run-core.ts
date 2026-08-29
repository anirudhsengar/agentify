import * as crypto from "node:crypto";
import * as path from "node:path";
import { PI_SDK_VERSION } from "../pi-sdk-version.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeResult } from "../types.ts";
import { defaultConfigDir } from "../agentify-config.ts";
import { AgentifyLog } from "../audit/log.ts";
import { AuditResourceBudget } from "../audit/resource-budget.ts";
import {
  currentRepositoryCommit,
  checkpointExplorerConcernEvidence,
  ExplorerReceiptTracker,
} from "../audit/explorer-receipts.ts";
import { createGapDraftMap } from "../audit/map-draft.ts";
import { createRepositoryEvidenceDraft } from "../audit/repository-evidence-bootstrap.ts";
import { DEFAULT_MAP_FILENAME, writeCanonicalMap } from "../audit/map-storage.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { loadBuilderPrompt } from "../audit/prompt.ts";
import {
  COVERAGE_DIMENSIONS,
  assessAuditCompletion,
  assessCoverageClosure,
  specialistEvidenceRecorded,
} from "../audit/schema.ts";
import {
  setThinkingLevel,
} from "../audit/state.ts";
import { COVERAGE_REPAIR_HINTS, createWriteMapTools, loadCanonicalMapAt } from "../audit/write-map-tool.ts";
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

// The output cap prevents providers from truncating a large tool-call payload.
// Wall-clock limits come from the application-owned aggregate budget.
const AUDIT_MAX_OUTPUT_TOKENS = 65_536;

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
    specialist_evidence_recorded?: boolean;
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
      return "Inspecting repository files and source patterns";
    case "write_map":
    case "write_map_delta":
      return "Recording the validated codebase map and evidence";
    case "spawn_explorer":
      return "Launching a focused read-only explorer";
    default:
      return "Reviewing the repository evidence";
  }
}

/**
 * Thrown when every assistant turn in the audit session errored out before
 * a single tool call was made — the signature of a provider rejecting the
 * request outright (missing/invalid/expired credentials) rather than an
 * audit-content problem. Distinct from a generic closure failure so
 * `runAgentifyApp` can catch it and re-prompt for a credential instead of
 * just surfacing an opaque coverage error.
 */
export class ProviderAuthFailedError extends Error {
  readonly provider: string;
  constructor(provider: string, closedCount: number, totalCount: number) {
    super(
      `repository audit did not reach structured closure (${closedCount}/${totalCount}); `
      + `every request to ${provider} ended in an error before any tool call was made; `
      + `this usually means the stored credentials for ${provider} are missing, invalid, or expired `
      + `(run \`agentify login --provider ${provider}\` with a valid key and retry)`,
    );
    this.name = "ProviderAuthFailedError";
    this.provider = provider;
  }
}

function providerAuthFailure(diagnostics: AgentRuntimeResult["diagnostics"]): string | null {
  if (!diagnostics || !diagnostics.assistant_stop_reasons.includes("error")) return null;
  const toolCallsAttempted = Object.values(diagnostics.tool_execution_counts)
    .reduce((sum, counts) => sum + counts.started, 0);
  if (toolCallsAttempted > 0) return null;
  return diagnostics.provider ?? diagnostics.provider_api ?? null;
}

function mapResult(result: WriteMapResult | undefined): {
  path: string;
  size_bytes: number;
  covered: string[];
  gap: string[];
  total: number;
  gap_warning: string[] | null;
  specialist_evidence_recorded: boolean;
} | null {
  if (!result || result.isError || !result.details?.path) return null;
  return {
    path: result.details.path,
    size_bytes: result.details.size_bytes ?? 0,
    covered: result.details.coverage_summary?.covered ?? [],
    gap: result.details.coverage_summary?.gap ?? [],
    total: result.details.coverage_summary?.total ?? COVERAGE_DIMENSIONS.length,
    gap_warning: result.details.gap_warning ?? null,
    specialist_evidence_recorded: result.details.specialist_evidence_recorded ?? false,
  };
}

function focusedAuditPrompt(persistedReceiptReasons: ReadonlyArray<string> = []): string {
  const prompt = [
    "Audit this existing repository for its persistent Agentify engineering team.",
    "Use only read-only repository tools and the structured write_map/write_map_delta tools.",
    "A gap-marked map is already present; after initial direct reads, call write_map_delta with concrete repository evidence.",
    "Submit each dimension incrementally via write_map_delta (one or two dimensions per call) to keep tool payloads compact and complete.",
    "Close every supportable coverage dimension and leave unsupported claims as explicit gaps.",
    "Before finishing, obtain one successful concern_scout receipt and one successful concern_tracer receipt per accepted concern. Agentify validates and checkpoints complete tracer bodies directly; use write_map_delta for scout rejections and other map evidence, not to retranscribe tracer reports. An honest empty list is valid only when the repository is too small to have distinct specialties and must be justified in open_questions and not_concerns. A timeout remains unresolved and cannot justify not_concerns. The audit is not complete without these receipts.",
    "The map is internal operational evidence for specialists and task planning.",
    "Do not write application files, AGENTS.md, harness configuration, skills, prompts, workflows, dependencies, or prose artifacts.",
    "Do not create a generic agent surface. Repository-specific specialists and procedures are materialized later from validated evidence.",
    "Do not return prose instead of the required structured tool call.",
  ];
  if (persistedReceiptReasons.length > 0) {
    prompt.push(
      "Application-attested explorer work from a prior run on this exact HEAD is already present. Do not rerun a successful scout or a successful concern tracer whose matching concern body is already persisted. A successful receipt named below without its matching persisted concern body must be retraced narrowly and checkpointed immediately. Resolve only these remaining receipt obligations: "
        + persistedReceiptReasons.join("; "),
    );
  }
  return prompt.join(" ");
}

/**
 * Used when rerunning against a repository whose map already closes every
 * coverage dimension but predates the specialist-evidence gate. The audit
 * resumes as a bounded top-up instead of a fresh full audit.
 */
function specialistEvidenceTopUpPrompt(): string {
  return [
    "The canonical codebase map already closes every coverage dimension, but concern_evidence.concerns was never recorded.",
    "Run concern_scout successfully, record its substantive rejections through write_map_delta, then trace each accepted candidate successfully with concern_tracer. Agentify validates and checkpoints complete tracer bodies directly. A timeout remains unresolved and cannot justify not_concerns.",
    "Record one entry per concern a maintainer would recognize as its own body of knowledge: concern, one_line, covers, excludes, flows (each with at least two observed steps), touchpoints (path, symbol, role, line_range, centrality), invariants, pitfalls, entry_questions, validation, spans_subtrees, stability, recurrence, and confidence. Agentify binds last_updated to the exact repository commit.",
    "Ground every path, type, and command in repository evidence you actually read. Do not invent candidates.",
    "An honest empty concerns list is valid only when the repository is too small to have distinct specialties; record that justification in open_questions in the same delta.",
    "Do not modify or weaken the existing closed coverage dimensions. Do not return prose instead of the required structured tool call.",
  ].join(" ");
}

function buildAuditRecoveryPrompt(
  closure: { closed: string[]; unresolved: string[]; reasons: Record<string, string> },
  options?: {
    specialistEvidenceMissing?: boolean;
    explorerReceiptReasons?: ReadonlyArray<string>;
  },
): string {
  const lines: string[] = [
    "The repository audit has recorded progress but still needs structured closure for the following remaining dimension(s):",
    "",
  ];
  for (const dim of closure.unresolved) {
    const reason = closure.reasons[dim] ?? "status is not covered";
    const hint = COVERAGE_REPAIR_HINTS[dim as keyof typeof COVERAGE_REPAIR_HINTS] ?? "";
    lines.push(`- **${dim}**: ${reason}`);
    if (hint) {
      lines.push(`  Required fields: ${hint}`);
    }
  }
  if (options?.specialistEvidenceMissing) {
    lines.push("- **specialist_evidence**: every coverage dimension is closed, but `concern_evidence.concerns` has not been recorded.");
    lines.push("  Required fields: call `write_map_delta` with `delta: { concern_evidence: { concerns: [...], not_concerns: [...] } }` and OMIT the `dimension` parameter — 'specialist_evidence' is the name of the missing gate, not a value for `dimension`; concern evidence closes no coverage dimension. Record one entry per concern a maintainer would recognize as its own body of knowledge, each traced end to end through tracked files with per-touchpoint roles, flows, invariants, pitfalls, entry questions, stability, recurrence, and confidence. A concern is never a directory and two concerns may share files. An honest empty list is valid only when the repository is too small to have distinct specialties; record that justification in `open_questions` and `not_concerns`.");
  }
  for (const reason of options?.explorerReceiptReasons ?? []) {
    lines.push(`- **explorer_receipt**: ${reason}`);
  }
  lines.push("");
  lines.push("Instructions:");
  if (
    closure.unresolved.length === 0
    && (options?.explorerReceiptReasons?.length ?? 0) > 0
  ) {
    lines.push("1. Resolve the missing explorer receipts before claiming closure. Run concern_scout at the repository root when its receipt is missing, then run a focused concern_tracer for every named concern or failed focus.");
    lines.push("2. A tracer timeout is unresolved evidence, not a valid not_concerns rejection. Retry with a narrower target_path and the same concern in focus until a successful structured report is returned.");
    lines.push("3. Preserve every accepted concern and every verified ordered flow step. Call write_map_delta only when the successful reports change concern_evidence; otherwise stop after the required explorer calls.");
    lines.push("4. Do not return prose instead of the required explorer calls.");
  } else if (options?.specialistEvidenceMissing && closure.unresolved.length === 0) {
    lines.push("1. The only remaining work is specialist evidence. Do NOT re-close coverage dimensions; they are already covered.");
    lines.push("2. Run `spawn_explorer` with `mode: 'concern_scout'` against the repository root. Record substantive scout rejections with `write_map_delta`, then run one `mode: 'concern_tracer'` per retained candidate with the concern name and seed paths as `focus`. Agentify validates and checkpoints each complete tracer body directly; do not retranscribe it.");
    lines.push("3. If the repository is too small to have distinct specialties, call `write_map_delta` with `delta: { concern_evidence: { concerns: [], not_concerns: [{ candidate: '...', why_rejected: '...' }] }, open_questions: ['No specialist concern because ...'] }`.");
    lines.push("4. Do not return prose or summaries. Submit the structured tool call.");
  } else {
    lines.push("1. Inspect the repository with `read`, `grep`, `find`, or `ls` to locate the required evidence for these remaining dimensions.");
    lines.push("2. Call `write_map_delta` for each missing dimension. In each call, include the dimension data, `coverage: { [dimension]: { status: 'covered', confidence: 'high', evidence_summary: '...', evidence: [{ path: '...', excerpt: '...', kind: 'positive' }] } }`.");
    lines.push("3. All `evidence.path` citations must point to real files existing in the repository.");
    lines.push("4. Do not return prose or summaries. Submit tool calls with the required structured data.");
  }
  return lines.join("\n");
}

function checkpointExplorerReceipts(
  cwd: string,
  stateDir: string,
  runId: string,
  tracker: ExplorerReceiptTracker,
  event: unknown,
): void {
  const value = event as { type?: string; toolName?: string; tool_name?: string };
  if (
    value.type !== "tool_execution_end"
    || (value.toolName ?? value.tool_name) !== "spawn_explorer"
  ) {
    return;
  }
  const repositoryCommit = currentRepositoryCommit(cwd);
  const map = loadCanonicalMapAt(cwd, stateDir);
  if (repositoryCommit === null || map === null) return;
  writeCanonicalMap(cwd, {
    ...map,
    explorer_receipts: tracker.attestation(repositoryCommit, runId),
  }, {
    stateDir,
    mapFilename: DEFAULT_MAP_FILENAME,
  });
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
  const log = context.auditLog ?? new AgentifyLog({ cwd: context.cwd, configDir: defaultConfigDir() });
  const ownsLog = context.auditLog === undefined;
  const deferLogCompletion = context.deferAuditLogCompletion === true;
  if (deferLogCompletion && ownsLog) {
    throw new Error("deferred audit logging requires a caller-owned AgentifyLog");
  }
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

  const preExistingMap = loadCanonicalMapAt(context.cwd, stateDir);
  const bootstrappedGapDraft = preExistingMap === null;
  if (bootstrappedGapDraft) {
    writeCanonicalMap(context.cwd, context.repositoryPreflight
      ? createRepositoryEvidenceDraft(context.cwd, context.repositoryPreflight)
      : createGapDraftMap(), {
      stateDir,
      mapFilename: DEFAULT_MAP_FILENAME,
    });
  }
  const specialistEvidenceTopUp = preExistingMap !== null
    && assessCoverageClosure(preExistingMap, { cwd: context.cwd }).unresolved.length === 0
    && !specialistEvidenceRecorded(preExistingMap);

  const spinner: SpinnerHandle = startSpinner("starting focused repository audit");
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (context.signal?.aborted) forwardAbort();
  else context.signal?.addEventListener("abort", forwardAbort, { once: true });
  let controlledClosure = false;
  let spinnerStopped = false;
  let observedTurns = 0;
  let observedCost = 0;
  const explorerReceipts = new ExplorerReceiptTracker();
  const initialCommit = currentRepositoryCommit(context.cwd);
  if (
    initialCommit !== null
    && preExistingMap?.explorer_receipts?.repository_commit === initialCommit
  ) {
    explorerReceipts.loadAttestation(preExistingMap.explorer_receipts);
  }
  const initialReceiptAssessment = explorerReceipts.assess(preExistingMap);
  const resourceBudget = context.auditResourceBudget
    ?? new AuditResourceBudget(context.config.auditBudgets);
  context.ui.status("agentify: auditing existing repository");

  try {
    const baseSessionDurationMs = resourceBudget.remainingDurationMs();
    const baseSessionBudget = resourceBudget.beginSession(baseSessionDurationMs);
    const baseDeadline = setTimeout(() => {
      try {
        resourceBudget.exhaustSession(baseSessionBudget);
      } catch {
        controller.abort();
      }
    }, baseSessionDurationMs);
    let runtimeResult: AgentRuntimeResult;
    try {
      runtimeResult = await context.runtime.runSession({
      cwd: context.cwd,
      configDir: defaultConfigDir(),
      config: context.config,
      systemPrompt: promptContent,
      userPrompt: specialistEvidenceTopUp
        ? specialistEvidenceTopUpPrompt()
        : focusedAuditPrompt(
          initialReceiptAssessment.successful_scouts > 0
            ? initialReceiptAssessment.reasons
            : [],
        ),
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
      auditResourceBudget: resourceBudget,
      signal: controller.signal,
      inactivityTimeoutMs: 5 * 60 * 1000,
      timeoutMs: baseSessionDurationMs,
      maxOutputTokens: resourceBudget.remainingOutputTokens(AUDIT_MAX_OUTPUT_TOKENS),
      recoveryPromptIfToolNotCalled: {
        requiredToolName: bootstrappedGapDraft || specialistEvidenceTopUp ? "write_map_delta" : "write_map",
        maxAttempts: 2,
        userPrompt: "Read the current map and submit the strongest evidence already gathered through write_map_delta. Leave genuinely unsupported dimensions as gaps; do not return prose.",
        shouldRecover: () => {
          const map = loadCanonicalMapAt(context.cwd, stateDir);
          return map !== null && !assessAuditCompletion(map, { cwd: context.cwd }).complete;
        },
      },
      onEvent: (event) => {
        try {
          resourceBudget.observeParentEvent(event, baseSessionBudget);
        } catch {
          controller.abort();
        }
        const eventType = (event as { type?: string }).type ?? "unknown";
        checkpointExplorerConcernEvidence(context.cwd, stateDir, event);
        explorerReceipts.observe(event);
        checkpointExplorerReceipts(context.cwd, stateDir, log.runId, explorerReceipts, event);
        log.sessionEvent({ pi_event_type: eventType, event });
        if (eventType === "message_start" && (event as { message?: { role?: string } }).message?.role === "user") {
          log.recordTurnStart();
        } else if (eventType === "message_end") {
          const usage = extractUsage(event);
          const role = (event as { message?: { role?: string } }).message?.role;
          log.recordMessageEnd(role, usage);
          if (role === "assistant") {
            observedTurns += 1;
            if (typeof usage?.cost?.total === "number") observedCost += usage.cost.total;
          }
          const currentMap = loadCanonicalMapAt(context.cwd, stateDir);
          if (
            currentMap
            && assessAuditCompletion(currentMap, { cwd: context.cwd }).complete
            && explorerReceipts.assess(currentMap).complete
          ) {
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
                && written.specialist_evidence_recorded
              ) {
                controlledClosure = true;
                controller.abort();
              }
            }
          }
        }
      },
      });
    } finally {
      clearTimeout(baseDeadline);
    }
    resourceBudget.finishParentSession(baseSessionBudget, runtimeResult);
    resourceBudget.assertWithinBudget();

    let map = loadCanonicalMapAt(context.cwd, stateDir);
    let closure = map === null
      ? { closed: [] as string[], unresolved: [...COVERAGE_DIMENSIONS], reasons: {} as Record<string, string> }
      : assessCoverageClosure(map, { cwd: context.cwd });
    let receiptAssessment = explorerReceipts.assess(map);

    const maxRecoveryPasses = resourceBudget.limits.maxCoverageRecoveryPasses;
    let recoveryPass = 0;
    while (
      map !== null
      && (
        closure.unresolved.length > 0
        || !specialistEvidenceRecorded(map)
        || !receiptAssessment.complete
      )
      && recoveryPass < maxRecoveryPasses
      && !context.signal?.aborted
      && !providerAuthFailure(runtimeResult.diagnostics)
    ) {
      resourceBudget.reserveCoverageRecoveryPass();
      recoveryPass += 1;
      const specialistEvidenceMissing = !specialistEvidenceRecorded(map);
      spinner.update(
        closure.unresolved.length > 0
          ? `recovering ${closure.unresolved.length} unresolved audit dimension(s) (pass ${recoveryPass}/${maxRecoveryPasses})`
          : `recording specialist evidence (pass ${recoveryPass}/${maxRecoveryPasses})`,
      );
      const recoveryController = new AbortController();
      const recoveryForwardAbort = (): void => recoveryController.abort();
      if (context.signal?.aborted) recoveryForwardAbort();
      else context.signal?.addEventListener("abort", recoveryForwardAbort, { once: true });
      const recoveryPrompt = buildAuditRecoveryPrompt(closure, {
        specialistEvidenceMissing,
        explorerReceiptReasons: receiptAssessment.reasons,
      });
      try {
        const recoverySessionDurationMs = resourceBudget.remainingDurationMs();
        const recoverySessionBudget = resourceBudget.beginSession(recoverySessionDurationMs);
        const recoveryDeadline = setTimeout(() => {
          try {
            resourceBudget.exhaustSession(recoverySessionBudget);
          } catch {
            recoveryController.abort();
          }
        }, recoverySessionDurationMs);
        let recoveryResult: AgentRuntimeResult;
        try {
          recoveryResult = await context.runtime.runSession({
          cwd: context.cwd,
          configDir: defaultConfigDir(),
          config: context.config,
          systemPrompt: promptContent,
          userPrompt: recoveryPrompt,
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
          auditResourceBudget: resourceBudget,
          signal: recoveryController.signal,
          inactivityTimeoutMs: 5 * 60 * 1000,
          timeoutMs: recoverySessionDurationMs,
          maxOutputTokens: resourceBudget.remainingOutputTokens(AUDIT_MAX_OUTPUT_TOKENS),
          onEvent: (event) => {
            try {
              resourceBudget.observeParentEvent(event, recoverySessionBudget);
            } catch {
              recoveryController.abort();
            }
            const eventType = (event as { type?: string }).type ?? "unknown";
            checkpointExplorerConcernEvidence(context.cwd, stateDir, event);
            explorerReceipts.observe(event);
            checkpointExplorerReceipts(context.cwd, stateDir, log.runId, explorerReceipts, event);
            log.sessionEvent({ pi_event_type: eventType, event });
            if (eventType === "message_start" && (event as { message?: { role?: string } }).message?.role === "user") {
              log.recordTurnStart();
            } else if (eventType === "message_end") {
              const usage = extractUsage(event);
              const role = (event as { message?: { role?: string } }).message?.role;
              log.recordMessageEnd(role, usage);
              if (role === "assistant") {
                observedTurns += 1;
                if (typeof usage?.cost?.total === "number") observedCost += usage.cost.total;
              }
              const currentMap = loadCanonicalMapAt(context.cwd, stateDir);
              if (
                currentMap
                && assessAuditCompletion(currentMap, { cwd: context.cwd }).complete
                && explorerReceipts.assess(currentMap).complete
              ) {
                controlledClosure = true;
                recoveryController.abort();
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
                    && written.specialist_evidence_recorded
                    && (() => {
                      const currentMap = loadCanonicalMapAt(context.cwd, stateDir);
                      return currentMap !== null && explorerReceipts.assess(currentMap).complete;
                    })()
                  ) {
                    controlledClosure = true;
                    recoveryController.abort();
                  }
                }
              }
            }
          },
          });
        } finally {
          clearTimeout(recoveryDeadline);
        }
        resourceBudget.finishParentSession(recoverySessionBudget, recoveryResult);
        resourceBudget.assertWithinBudget();
      } finally {
        context.signal?.removeEventListener("abort", recoveryForwardAbort);
      }

      map = loadCanonicalMapAt(context.cwd, stateDir);
      closure = map === null
        ? { closed: [] as string[], unresolved: [...COVERAGE_DIMENSIONS], reasons: {} as Record<string, string> }
        : assessCoverageClosure(map, { cwd: context.cwd });
      receiptAssessment = explorerReceipts.assess(map);
    }

    const specialistRecorded = map !== null && specialistEvidenceRecorded(map);
    const receiptsComplete = receiptAssessment.complete;
    const intentionallyStopped = (runtimeResult.aborted || controlledClosure)
      && closure.unresolved.length === 0
      && specialistRecorded
      && receiptsComplete;
    const success = map !== null
      && closure.unresolved.length === 0
      && specialistRecorded
      && receiptsComplete;
    const status = success ? "success" : runtimeResult.aborted ? "aborted" : "partial";
    if (!deferLogCompletion) {
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
    }
    if (!success) {
      const failedProvider = providerAuthFailure(runtimeResult.diagnostics);
      if (failedProvider) {
        throw new ProviderAuthFailedError(failedProvider, closure.closed.length, COVERAGE_DIMENSIONS.length);
      }
      const reasons = closure.unresolved
        .slice(0, 8)
        .map((dimension) => `${dimension}: ${closure.reasons[dimension] ?? "not closed"}`);
      if (closure.unresolved.length === 0 && !specialistRecorded) {
        reasons.push(
          "specialist evidence: concern_evidence.concerns was not recorded; "
          + "an honest empty list is valid but the field must be present",
        );
      }
      reasons.push(...receiptAssessment.reasons.map((reason) => `explorer receipt: ${reason}`));
      throw new Error(
        `repository audit did not reach structured closure (${closure.closed.length}/${COVERAGE_DIMENSIONS.length}); ${reasons.join("; ")}`,
      );
    }

    const repositoryCommit = currentRepositoryCommit(context.cwd);
    if (repositoryCommit === null || map === null) {
      throw new Error("cannot bind explorer receipts to the current repository commit");
    }
    map = {
      ...map,
      explorer_receipts: explorerReceipts.attestation(repositoryCommit, log.runId),
    };
    writeCanonicalMap(context.cwd, map, {
      stateDir,
      mapFilename: DEFAULT_MAP_FILENAME,
    });

    spinner.stop("repository audit complete", "success");
    spinnerStopped = true;
    context.ui.info(`agentify: validated codebase map written to ${stateDir}/${DEFAULT_MAP_FILENAME}`);
    if (!deferLogCompletion) context.ui.info(`agentify: audit log written to ${log.logPath}`);
    return {
      map_path: `${stateDir}/${DEFAULT_MAP_FILENAME}`,
      covered_dimensions: closure.closed.length,
      total_dimensions: COVERAGE_DIMENSIONS.length,
      turns: runtimeResult.turns || observedTurns,
      cost_usd: runtimeResult.costUsd ?? (observedCost > 0 ? observedCost : null),
    };
  } catch (error) {
    if (!deferLogCompletion) {
      log.runEnd({
        exit_code: -1,
        status: "error",
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    context.signal?.removeEventListener("abort", forwardAbort);
    if (!spinnerStopped) spinner.stop("repository audit failed", "error");
    if (ownsLog) await log.close();
  }
}
