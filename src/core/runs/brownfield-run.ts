import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { defaultConfigDir } from "../agentify-config.ts";
import { resolveApplyPolicy } from "../agentifyrc.ts";
import { exportAgenticSurface } from "../artifact-exporters.ts";
import { isFeatureAgentFilename } from "../artifacts/agent-file-conventions.ts";
import { normalizeArtifactPath } from "../artifacts/generated-surface.ts";
import { renderValidatedBrownfieldArtifacts } from "../artifacts/renderers.ts";
import { readPackageVersion } from "../package-version.ts";
import { persistRunArtifacts } from "../revert.ts";
import { packageRoot } from "../pi-sdk-runtime.ts";
import { ProjectClassifier } from "../project-classifier.ts";
import { readPackagedSkillTiers, skillsForClassification } from "../skill-curation.ts";
import { installScaffoldRuntime } from "../scaffold-installer.ts";
import { inspectAgentifyRepoState } from "../repo-status.ts";
import {
  readManifestAt,
  type ManagedManifest,
  type ManagedManifestFile,
} from "../manifest.ts";
import { resolveCanonicalStateDir } from "../state-dir.ts";
import type { AgentifyTarget } from "../types.ts";
import { AgentifyLog } from "../audit/log.ts";
import { loadBuilderPrompt } from "../audit/prompt.ts";
import {
  COVERAGE_DIMENSIONS,
  assessCoverageClosure,
} from "../audit/schema.ts";
import {
  getOrCreateSessionId,
  setAgentifySessionActive,
  setThinkingLevel,
} from "../audit/state.ts";
import {
  createWriteMapTools,
  loadCanonicalMapAt,
} from "../audit/write-map-tool.ts";
import { createGapDraftMap } from "../audit/map-draft.ts";
import { DEFAULT_MAP_FILENAME, writeCanonicalMap } from "../audit/map-storage.ts";
import { createReadOnlyExecutionPolicy } from "../security/execution-policy.ts";
import { beginStateTransaction } from "../state-transaction.ts";
import {
  collectAuditArtifactSnapshot,
  rollbackGeneratedSurface,
} from "../generation/artifact-snapshot.ts";
import { applyStagedBundle } from "../generation/apply-bundle.ts";
import { formatApplyReport } from "../generation/apply-report.ts";
import {
  captureSessionAgentFiles,
  cleanupSessionAgentSnapshot,
  mirrorSessionOutputToStaging,
} from "../generation/session-agent-snapshot.ts";
import {
  addWriteMetadata,
  copyCanonicalMapToStaging,
  makeStagingRoot,
  writeRenderedArtifactsToStaging,
} from "../generation/staging-bundle.ts";
import { startSpinner, type SpinnerHandle } from "../ui/spinner.ts";
import { linkLegacyPiSurface } from "../legacy-surface-links.ts";
import { persistProjectState, reportGitHubReadiness } from "./project-state-reporter.ts";
import type { RunArtifactSnapshot, RunContext } from "./run-context.ts";

const AGENTS_MD_PATH = "AGENTS.md";
const BUILDER_TOOL_ALLOWLIST = [
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

type FinalAuditState = {
  status: "success" | "partial" | "aborted" | "error";
  covered: number;
  gap: number;
  total: number;
  agentsMdExists: boolean;
  alwaysOnWritten: number;
  alwaysOnTotal: number;
  featureAgentsWritten: number;
  gapReasons: string[];
};

const ALWAYS_ON_ARTIFACTS = [
  "specs/README.md",
  "ai_docs/README.md",
] as const;

function cleanupTransientScaffoldingAt(cwd: string, stateDir: string): void {
  const transient = [
    path.join(cwd, stateDir, ".agentify"),
    path.join(cwd, stateDir, "history"),
    path.join(cwd, stateDir, "logs"),
  ];
  for (const target of transient) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }
}

function toRel(cwd: string, filePath: string): string {
  return normalizeArtifactPath(path.relative(cwd, filePath));
}

const SKILL_DIRS = [".agents/skills", ".claude/skills", ".pi/skills"] as const;

function removeStaleSkills(
  cwd: string,
  previousManifest: ManagedManifest | null,
  shippedSkills: ReadonlySet<string>,
  log: (msg: string) => void,
): void {
  if (!previousManifest) return;
  const prevSkillPaths = new Set(
    previousManifest.files
      .filter((file) => file.kind === "skill")
      .map((file) => file.path),
  );
  if (prevSkillPaths.size === 0) return;

  const newSkillPaths = new Set<string>();
  for (const name of shippedSkills) {
    for (const dir of SKILL_DIRS) {
      newSkillPaths.add(`${dir}/${name}/SKILL.md`);
    }
  }

  const stale: string[] = [];
  for (const rel of prevSkillPaths) {
    if (newSkillPaths.has(rel)) continue;
    const absolute = path.join(cwd, rel);
    if (!fs.existsSync(absolute)) continue;
    const head = fs.readFileSync(absolute, "utf-8").slice(0, 64);
    if (!head.includes("<!-- agentify:managed -->")) continue;
    fs.rmSync(absolute, { force: true });
    stale.push(rel);
  }

  if (stale.length > 0) {
    log(`agentify: removed ${stale.length} stale skill(s) (dropped from tier since last run):`);
    for (const rel of stale) log(`agentify:   - ${rel}`);
  }
}

function extractUsage(event: AgentSessionEvent): AssistantUsage | undefined {
  const maybe = event as {
    type?: string;
    message?: { usage?: AssistantUsage };
  };
  return maybe.type === "message_end" ? maybe.message?.usage : undefined;
}

function extractWriteMapResult(result: WriteMapResult | undefined): {
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

function auditActivityForTool(toolName: string): string {
  switch (toolName) {
    case "read":
    case "grep":
    case "find":
    case "ls":
      return "Inspecting repository files and source patterns…";
    case "write_map":
    case "write_map_delta":
      return "Recording the codebase map and evidence…";
    case "spawn_explorer":
      return "Launching a focused explorer for deeper analysis…";
    default:
      return "Reviewing the codebase and connecting findings…";
  }
}

function readFinalAuditState(cwd: string, stateDir: string): FinalAuditState {
  const agentsMdPath = path.join(cwd, AGENTS_MD_PATH);
  const agentsMdExists = fs.existsSync(agentsMdPath);
  let alwaysOnWritten = 0;
  for (const rel of ALWAYS_ON_ARTIFACTS) {
    if (fs.existsSync(path.join(cwd, rel))) alwaysOnWritten += 1;
  }

  let featureAgentsWritten = 0;
  const agentsDir = path.join(cwd, ".pi", "agents");
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir)) {
      if (isFeatureAgentFilename(entry)) featureAgentsWritten += 1;
    }
  }

  const total = COVERAGE_DIMENSIONS.length;
  const gapReasons: string[] = [];
  const map = loadCanonicalMapAt(cwd, stateDir);
  if (!map) {
    gapReasons.push(
      `no valid codebase map at ${stateDir}/codebase_map.json (write_map was never completed or failed schema validation)`,
    );
  }
  const closure = map
    ? assessCoverageClosure(map)
    : { closed: [], unresolved: [...COVERAGE_DIMENSIONS], reasons: {} as Record<string, string> };
  if (map) {
    for (const dimension of closure.unresolved) {
      gapReasons.push(`${dimension}: ${closure.reasons[dimension] ?? "not closed"}`);
    }
  }
  const success = gapReasons.length === 0;
  return {
    status: success ? "success" : "partial",
    covered: closure.closed.length,
    gap: closure.unresolved.length,
    total,
    agentsMdExists,
    alwaysOnWritten,
    alwaysOnTotal: ALWAYS_ON_ARTIFACTS.length,
    featureAgentsWritten,
    gapReasons,
  };
}

function buildBrownfieldUserPrompt(
  targets: ReadonlyArray<AgentifyTarget>,
  additionalAgents?: ReadonlyArray<string>,
): string {
  const allTargets = [...targets, ...(additionalAgents ?? [])];
  return [
    "Audit this existing codebase and bootstrap its agentic surface.",
    "A gap-marked canonical map has already been created for this audit. After the initial four scout reads, you MUST call write_map_delta with direct D1_topography evidence including at least one real repository entry point in skeleton.entry_points as { path, role, language, run_command } before calling spawn_explorer; then checkpoint further direct evidence as you explore.",
    "Explore the codebase, fill the structured codebase map via write_map_delta, and close every coverage area before emitting artifact_intents.",
    "The map and artifact_intents are internal structured state; TypeScript renderers write user-facing files after validation.",
    "Do not write AGENTS.md, specs/README.md, ai_docs/README.md, .pi/agents, .pi/prompts, .pi/extensions, scaffold, or harness exports directly.",
    "Describe codebase-emergent intelligence in artifact_intents: agent guide sections, always-on docs, feature specialists, prompt templates, expert prompts, and extension candidates when warranted.",
    "Do not emit generic build-chain primitives; those ship as agentify skills and will be exported separately.",
    `The standalone CLI will export the audited intelligence for these harness targets after the audit: ${allTargets.join(", ")}.`,
    "Skip user-owned files. Honest sparseness beats padding.",
  ].join(" ");
}

export async function runBrownfieldAudit(context: RunContext): Promise<void> {
  const options = context;
  const config = context.config;
  const stateDirResolved = resolveCanonicalStateDir(
    options.cwd, options.targets, options.additionalAgents,
  );
  const stateDir = stateDirResolved.relativeDir;
  const sourceStateDir = stateDirResolved.sourceRelativeDir;
  const previousManifest = readManifestAt(options.cwd, sourceStateDir);
  const mapTools = createWriteMapTools({ stateDir });
  const promptContent = loadBuilderPrompt(stateDir);
  const promptSha = crypto.createHash("sha256").update(promptContent).digest("hex");
  const log = new AgentifyLog({ cwd: options.cwd, configDir: defaultConfigDir() });
  const start = Date.now();
  const sessionId = getOrCreateSessionId();
  setThinkingLevel(config.thinkingLevel ?? "high");

  const stateTransaction = beginStateTransaction({
    cwd: options.cwd,
    sourceRelativeDir: sourceStateDir,
    destinationRelativeDir: stateDir,
    preserveExistingSource: stateDirResolved.layout.fallback,
  });
  let commitState = false;
  let artifactSnapshotForRollback: RunArtifactSnapshot | null = null;
  try {
    const artifactSnapshot = collectAuditArtifactSnapshot(options.cwd);
    artifactSnapshotForRollback = artifactSnapshot;
    const protectedPaths = [...artifactSnapshot.entries()]
      .filter(([, entry]) => entry.ownership === "unmanaged")
      .map(([relative]) => path.resolve(options.cwd, relative));

    log.runStart({
      cwd: options.cwd,
      args: options.args ?? "",
      model: config.model ?? "auto",
      thinking_level: config.thinkingLevel ?? "high",
      agentify_version: readPackageVersion(packageRoot()),
      sdk_version: PI_SDK_VERSION,
      system_prompt_sha256: promptSha,
      system_prompt_path: "src/core/audit/prompts/builder.md",
      tool_allowlist: BUILDER_TOOL_ALLOWLIST,
    });

    const bootstrappedGapDraft = loadCanonicalMapAt(options.cwd, stateDir) === null;
    if (bootstrappedGapDraft) {
      writeCanonicalMap(options.cwd, createGapDraftMap(), {
        stateDir,
        mapFilename: DEFAULT_MAP_FILENAME,
      });
    }

    options.ui.status("agentify: auditing existing codebase");
    setAgentifySessionActive(sessionId, true);
    const spinner: SpinnerHandle = startSpinner("starting audit…");
    let turnCount = 0;
    let costUsd = 0;
    let spinnerStopped = false;
    let sawMapWriteCall = false;
    let stoppedAfterCoverageClosure = false;
    const sessionAbortController = new AbortController();
    const forwardExternalAbort = (): void => sessionAbortController.abort();
    if (options.signal?.aborted) forwardExternalAbort();
    else options.signal?.addEventListener("abort", forwardExternalAbort, { once: true });
    let runtimeResult: Awaited<ReturnType<typeof options.runtime.runSession>>;
    try {
      runtimeResult = await options.runtime.runSession({
          cwd: options.cwd,
          configDir: defaultConfigDir(),
          config,
          systemPrompt: promptContent,
          userPrompt: [
            buildBrownfieldUserPrompt(options.targets, options.additionalAgents),
            ...(bootstrappedGapDraft ? [
              "Agentify has already persisted an honest 0/10 gap-marked canonical map for this audit. " +
              "Do not submit another initial write_map. Use write_map_delta to add evidence and close dimensions " +
              "incrementally; only mark a dimension covered when the repository evidence supports it.",
            ] : []),
          ].join(" "),
          tools: BUILDER_TOOL_ALLOWLIST,
          executionPolicy: createReadOnlyExecutionPolicy({
            cwd: options.cwd,
            mode: "audit-readonly",
            tools: BUILDER_TOOL_ALLOWLIST.filter((tool) =>
              tool === "read" || tool === "grep" || tool === "find" || tool === "ls"
            ),
            protectedPaths,
          }),
          customTools: [
            mapTools.writeMapTool,
            mapTools.writeMapDeltaTool,
          ],
          spawnExplorerAgentDir: defaultConfigDir(),
          spawnExplorerStateDir: stateDir,
          signal: sessionAbortController.signal,
          // A stalled provider must not leave a repository transaction open
          // forever. Normal streamed responses continuously reset this timer.
          inactivityTimeoutMs: 5 * 60 * 1000,
          recoveryPromptIfToolNotCalled: {
            requiredToolName: bootstrappedGapDraft ? "write_map_delta" : "write_map",
            maxAttempts: 2,
            userPrompt: [
              bootstrappedGapDraft
                ? "The canonical map still has coverage gaps. Do not explore further or write prose. Read the current map, then use write_map_delta to add the strongest evidence already gathered and close every supportable dimension."
                : "Your audit response ended without calling write_map, so no codebase map was recorded.",
              bootstrappedGapDraft
                ? [
                  "Leave genuinely unsupported dimensions as gaps; otherwise submit the structured delta now.",
                  "For D5, use `pitfalls: [{ module, what, consequence, line_ref }]` with a numeric line_ref.",
                  "For D8, use `security_surface: { damage_control_rules: [\"specific operational rule\"] }`; do not invent another field name.",
                  "For D2, use `module_graph: { edges: [{ from, to, kind: \"import\"|\"state\"|\"rpc\" }] }` with at least one real edge.",
                  "For D3, use `type_contract_surface: { pydantic_models: [{ path, name, fields: [\"field\"] }] }` or another concrete type-contract entry.",
                ].join(" ")
                : "Continue from the evidence already gathered and submit the complete structured map via write_map.",
              "Do not return a prose summary instead of the tool call.",
            ].join(" "),
            shouldRecover: () => {
              const map = loadCanonicalMapAt(options.cwd, stateDir);
              return map !== null && assessCoverageClosure(map).unresolved.length > 0;
            },
          },
          onEvent: (event) => {
            const piType = (event as { type?: string }).type ?? "unknown";
            log.sessionEvent({ pi_event_type: piType, event });
            if (piType === "message_start" && (event as { message?: { role?: string } }).message?.role === "user") {
              log.recordTurnStart();
            } else if (piType === "message_start") {
              spinner.update("Reviewing findings and planning the next analysis step…");
            } else if (piType === "message_end") {
              log.incrementTurns();
              log.recordTurnEnd(extractUsage(event));
              const usage = extractUsage(event);
              turnCount += 1;
              const cost = usage?.cost?.total;
              if (typeof cost === "number") costUsd += cost;
              spinner.update(
                `Analysis pass ${turnCount} complete • estimated spend $${costUsd.toFixed(4)}`,
              );
              const currentMap = loadCanonicalMapAt(options.cwd, stateDir);
              if (currentMap && assessCoverageClosure(currentMap).unresolved.length === 0) {
                stoppedAfterCoverageClosure = true;
                sessionAbortController.abort();
              }
            } else if (piType === "tool_execution_start") {
              const toolName = (event as { toolName?: string; tool_name?: string }).toolName
                ?? (event as { tool_name?: string }).tool_name
                ?? "unknown";
              if (toolName === "write_map" || toolName === "write_map_delta") sawMapWriteCall = true;
              spinner.update(auditActivityForTool(toolName));
            } else if (piType === "tool_execution_end") {
              const toolEvent = event as { toolName?: string; result?: WriteMapResult };
              if (toolEvent.toolName === "write_map" || toolEvent.toolName === "write_map_delta") {
                const mapResult = extractWriteMapResult(toolEvent.result);
                if (mapResult) {
                  log.mapWritten({
                    path: mapResult.path,
                    size_bytes: mapResult.size_bytes,
                    coverage_summary: {
                      covered: mapResult.covered,
                      gap: mapResult.gap,
                      total: mapResult.total,
                    },
                    gap_warning: mapResult.gap_warning,
                  });
                  spinner.update("Codebase map captured — checking coverage and gaps…");
                  if (
                    mapResult.covered.length === mapResult.total
                    && mapResult.gap.length === 0
                    && (mapResult.gap_warning?.length ?? 0) === 0
                  ) {
                    stoppedAfterCoverageClosure = true;
                    sessionAbortController.abort();
                  }
                }
              } else if (toolEvent.toolName === "spawn_explorer") {
                log.subagentSpawned({
                  tool_name: "spawn_explorer",
                  details: (toolEvent.result as { details?: unknown } | undefined)?.details ?? null,
                  is_error: toolEvent.result?.isError ?? false,
                });
                spinner.update("Explorer completed — incorporating its findings…");
              }
            } else if (piType === "agent_end" && !spinnerStopped) {
              spinner.update(
                sawMapWriteCall
                  ? `Audit analysis complete • ${turnCount} pass(es) • estimated spend $${costUsd.toFixed(4)}`
                  : "Map not recorded yet — continuing the audit…",
              );
            }
          },
        });
      spinner.stop("audit session finished — validating results", "success");
      spinnerStopped = true;
    } finally {
      if (!spinnerStopped) {
        spinner.stop("audit failed", "error");
        spinnerStopped = true;
      }
    }

    options.signal?.removeEventListener("abort", forwardExternalAbort);
    const finalState: FinalAuditState = runtimeResult.aborted && !stoppedAfterCoverageClosure
      ? {
          status: "aborted",
          covered: 0,
          gap: COVERAGE_DIMENSIONS.length,
          total: COVERAGE_DIMENSIONS.length,
          agentsMdExists: false,
          alwaysOnWritten: 0,
          alwaysOnTotal: ALWAYS_ON_ARTIFACTS.length,
          featureAgentsWritten: 0,
          gapReasons: ["run was aborted"],
        }
      : readFinalAuditState(options.cwd, stateDir);

    cleanupTransientScaffoldingAt(options.cwd, stateDir);
    const sessionAgentsSnapshotDir = captureSessionAgentFiles(options.cwd, stateDir);
    const userOwnedAgentsMdEntry = artifactSnapshot.get("AGENTS.md");
    const userOwnedAgentsMd = userOwnedAgentsMdEntry?.ownership === "unmanaged";
    let reportedStatus = finalState.status;
    if (finalState.status === "success") {
      const rollback = rollbackGeneratedSurface(options.cwd, artifactSnapshot);
      if (rollback.removed > 0 || rollback.restored > 0) {
        options.ui.info(
          `agentify: cleaned legacy generated writes (${rollback.removed} removed, ${rollback.restored} restored).`,
        );
      }

      const map = loadCanonicalMapAt(options.cwd, stateDir);
      const renderResult = map
        ? renderValidatedBrownfieldArtifacts(map, { stateDir })
        : { artifacts: [], errors: ["validated codebase map disappeared before rendering"] };

      if (renderResult.errors.length > 0) {
        reportedStatus = "partial";
        stateTransaction.rollback();
        options.ui.error("agentify: audit artifacts failed deterministic rendering; no bundle was applied.");
        for (const reason of renderResult.errors.slice(0, 8)) {
          options.ui.error(`agentify:   - ${reason}`);
        }
        persistProjectState(options, {
          projectKind: "brownfield",
          runStatus: "partial",
          repoMode: "brownfield",
          repoStatus: "partial",
          featureAgentCount: 0,
          latestLogPath: log.logPath,
        });
      } else {
        const stagingRoot = makeStagingRoot();
        options.ui.info(`agentify: staging generated bundle at ${stagingRoot}`);
        try {
          const metadata = new Map<string, ManagedManifestFile>();
          writeRenderedArtifactsToStaging(stagingRoot, renderResult.artifacts, metadata, "brownfield", stateDir);
          copyCanonicalMapToStaging(options.cwd, stagingRoot, stateDir, metadata);
          mirrorSessionOutputToStaging(sessionAgentsSnapshotDir, stagingRoot, stateDir);
          const classification = ProjectClassifier.classify(options.cwd);
          const skillTiers = readPackagedSkillTiers(packageRoot());
          const { shipped: shippedSkills } = skillsForClassification(classification, skillTiers);
          const exportResults = exportAgenticSurface({
            cwd: stagingRoot,
            packageRoot: packageRoot(),
            targets: options.targets,
            additionalAgents: options.additionalAgents,
            stateDir,
            allowedSkills: shippedSkills,
            userOwnedAgentsMd,
          });
          for (const result of exportResults) {
            addWriteMetadata(stagingRoot, result.writes, `harness-export:${result.target}`, metadata, "brownfield", stateDir);
          }
          if (options.githubRuntime) {
            const scaffoldWrites = installScaffoldRuntime({
              cwd: stagingRoot,
              packageRoot: packageRoot(),
            });
            addWriteMetadata(stagingRoot, scaffoldWrites, "scaffold-installer", metadata, "brownfield", stateDir);
          }

          const runId = crypto.randomUUID();
          persistRunArtifacts({
            cwd: options.cwd,
            stateDir,
            runId,
            snapshot: artifactSnapshot,
            previousManifest,
          });

          const applyResult = applyStagedBundle({
            cwd: options.cwd,
            stagingRoot,
            snapshot: artifactSnapshot,
            metadata,
            agentifyVersion: readPackageVersion(packageRoot()),
            mode: "brownfield",
            policy: resolveApplyPolicy(options.cwd, stateDir),
            runId,
            stateDir,
            manifestStateDir: stateDirResolved.layout.fallback ? null : stateDir,
          });
          cleanupSessionAgentSnapshot(sessionAgentsSnapshotDir);
          const conflicts = applyResult.writes.filter((write) => write.action === "conflict");
          const scaffoldInstalled = applyResult.writes
            .filter((write) => write.action === "written")
            .filter((write) => {
              const relative = toRel(options.cwd, write.path);
              return relative === "SETUP.md" || relative.startsWith(".github/");
            })
            .length;

          if (applyResult.requiredConflictCount > 0) {
            reportedStatus = "partial";
            stateTransaction.rollback();
            options.ui.error(
              "agentify: required generated file conflict(s) blocked apply; no bundle files were written.",
            );
            for (const conflict of conflicts.slice(0, 8)) {
              options.ui.error(`agentify:   - ${toRel(options.cwd, conflict.path)}: ${conflict.reason ?? "conflict"}`);
            }
            persistProjectState(options, {
              projectKind: "brownfield",
              runStatus: "partial",
              repoMode: "brownfield",
              repoStatus: "partial",
              featureAgentCount: 0,
              latestLogPath: log.logPath,
            });
          } else {
            const links = linkLegacyPiSurface(options.cwd, stateDir);
            if (links.created.length > 0) {
              options.ui.info(`agentify: linked compatibility paths: ${links.created.join(", ")}.`);
            }
            if (links.retained.length > 0) {
              options.ui.info(`agentify: retained existing compatibility paths: ${links.retained.join(", ")}.`);
            }
            const repoState = inspectAgentifyRepoState(options.cwd, defaultConfigDir(), stateDir);
            reportedStatus = repoState.status === "ready" ? "success" : "partial";
            removeStaleSkills(
              options.cwd,
              previousManifest,
              shippedSkills,
              (message) => options.ui.info(message),
            );
            options.ui.info(
              `agentify: audit complete. ${repoState.featureAgentCount} feature agent(s), ` +
                `${exportResults.length} harness export(s), ${scaffoldInstalled} scaffold file(s) installed, ` +
                `${conflicts.length} optional conflict(s).`,
            );
            for (const line of formatApplyReport(applyResult.writes, options.cwd)) {
              options.ui.info(line);
            }
            if (options.githubRuntime) {
              reportGitHubReadiness(options);
            } else {
              options.ui.info("agentify: GitHub runtime not installed. Re-run with --github-runtime when you want GitHub Actions automation.");
            }
            persistProjectState(options, {
              projectKind: "brownfield",
              runStatus: reportedStatus,
              repoMode: "brownfield",
              repoStatus: repoState.status,
              featureAgentCount: repoState.featureAgentCount,
              latestLogPath: log.logPath,
            });
            commitState = true;
          }
        } finally {
          fs.rmSync(stagingRoot, { recursive: true, force: true });
          options.ui.info(`agentify: cleaned staging bundle at ${stagingRoot}`);
        }
      }
    } else {
      const rollback = rollbackGeneratedSurface(options.cwd, artifactSnapshot);
      stateTransaction.rollback();
      options.ui.error(
        `agentify: audit did not complete (${finalState.covered}/${finalState.total} dimensions closed); ` +
          "no harness export was run.",
      );
      if (rollback.removed > 0 || rollback.restored > 0) {
        options.ui.error(
          `agentify: cleaned partial generated writes (${rollback.removed} removed, ${rollback.restored} restored).`,
        );
      }
      for (const reason of finalState.gapReasons.slice(0, 8)) {
        options.ui.error(`agentify:   - ${reason}`);
      }
      persistProjectState(options, {
        projectKind: "brownfield",
        runStatus: finalState.status,
        repoMode: "brownfield",
        repoStatus: "partial",
        featureAgentCount: finalState.featureAgentsWritten,
        latestLogPath: log.logPath,
      });
    }

    const intentionallyStoppedAfterCoverage = runtimeResult.aborted && stoppedAfterCoverageClosure;
    log.sessionEnd({
      duration_ms: Date.now() - start,
      was_aborted: runtimeResult.aborted && !intentionallyStoppedAfterCoverage,
      status: reportedStatus,
    });
    log.runEnd({
      exit_code: runtimeResult.aborted && !intentionallyStoppedAfterCoverage ? -1 : 0,
      status: reportedStatus,
      coverage: {
        covered: finalState.covered,
        gap: finalState.gap,
        total: finalState.total,
      },
      agents_md_path: fs.existsSync(path.join(options.cwd, AGENTS_MD_PATH))
        ? path.join(options.cwd, AGENTS_MD_PATH)
        : null,
    });
    options.ui.info(`agentify: log written to ${log.logPath}`);
    if (commitState) stateTransaction.commit();
    else stateTransaction.rollback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (artifactSnapshotForRollback) {
      rollbackGeneratedSurface(options.cwd, artifactSnapshotForRollback);
    }
    stateTransaction.rollback();
    log.runEnd({ exit_code: -1, status: "error", error_message: message });
    options.ui.error(`agentify: ${message}`);
    throw error;
  } finally {
    setAgentifySessionActive(sessionId, false);
    await log.close();
  }
}
