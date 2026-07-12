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
import {
  LEGACY_PI_STATE_RELATIVE_DIR,
  resolveCanonicalStateDir,
} from "../state-dir.ts";
import type { AgentifyTarget } from "../types.ts";
import { AgentifyLog } from "../audit/log.ts";
import { loadBuilderPrompt } from "../audit/prompt.ts";
import {
  AGENTS_MD_MAX_LINES,
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
import { createReadOnlyExecutionPolicy } from "../security/execution-policy.ts";
import { beginStateTransaction } from "../state-transaction.ts";
import {
  collectAuditArtifactSnapshot,
  rollbackGeneratedSurface,
} from "../generation/artifact-snapshot.ts";
import { applyStagedBundle, withAbortOnRequired } from "../generation/apply-bundle.ts";
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
  /** Why the audit did not reach `success`, when applicable. */
  gapReasons: string[];
};

const ALWAYS_ON_ARTIFACTS = [
  "specs/README.md",
  "ai_docs/README.md",
] as const;

// Provider-scoped state is resolved once at run entry and threaded through
// structured writers, renderers, cleanup, persistence, and transactions.

// Remove only the transient draft/history transport, preserving the
// canonical codebase_map.json. Run at the END of a run so the map
// survives as a managed audit artifact: AGENTS.md points to it,
// and partial/aborted runs keep their progress for inspection.

/**
 * State-dir-aware transient cleanup. Mirrors
 * `cleanupTransientScaffolding` but targets the resolved state dir.
 */
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

function countFileLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.length === 0) return 0;
    const withoutTrailingNewline = content.endsWith("\n")
      ? content.slice(0, -1)
      : content;
    return withoutTrailingNewline.split("\n").length;
  } catch {
    return 0;
  }
}

function toRel(cwd: string, filePath: string): string {
  return normalizeArtifactPath(path.relative(cwd, filePath));
}

/**
 * Diff the previous manifest's skill paths against the new shipped
 * set, and delete any skill file that was previously installed but
 * is no longer in the current tier. Only touches files that carry the
 * `<!-- agentify:managed -->` marker — user-authored skill files in
 * `.claude/skills/` are left alone.
 *
 * Skill dotfolders shipped to: see the three premium exporters in
 * `artifact-exporters.ts`. The set below mirrors those literals.
 */
const SKILL_DIRS = [".agents/skills", ".claude/skills", ".pi/skills"] as const;

function removeStaleSkills(
  cwd: string,
  previousManifest: ManagedManifest | null,
  shippedSkills: ReadonlySet<string>,
  log: (msg: string) => void,
): void {
  if (!previousManifest) return; // First run — nothing to remove.

  const prevSkillPaths = new Set(
    previousManifest.files
      .filter((f) => f.kind === "skill")
      .map((f) => f.path),
  );
  if (prevSkillPaths.size === 0) return;

  // Compute what the new run wrote (skill SKILL.md files, since
  // copyDirManaged only writes the skill directory's contents).
  const newSkillPaths = new Set<string>();
  for (const name of shippedSkills) {
    for (const dir of SKILL_DIRS) {
      newSkillPaths.add(`${dir}/${name}/SKILL.md`);
    }
  }

  const stale: string[] = [];
  for (const rel of prevSkillPaths) {
    if (newSkillPaths.has(rel)) continue;
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) continue;
    // Only delete agentify-managed files. A user-owned file at the
    // same path would not be in the previous manifest anyway, but
    // belt-and-braces against manifest corruption.
    const head = fs.readFileSync(abs, "utf-8").slice(0, 64);
    if (!head.includes("<!-- agentify:managed -->")) continue;
    fs.rmSync(abs, { force: true });
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

// Decide audit success from the validated structured state, not from
// user-facing files. Renderers own AGENTS.md and always-on docs after
// the map closes, so the builder can complete without writing them.
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
      if (isFeatureAgentFilename(entry)) {
        featureAgentsWritten += 1;
      }
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
    for (const dim of closure.unresolved) {
      gapReasons.push(`${dim}: ${closure.reasons[dim] ?? "not closed"}`);
    }
  }

  if (agentsMdExists) {
    const lines = countFileLines(agentsMdPath);
    if (lines > AGENTS_MD_MAX_LINES) {
      gapReasons.push(
        `legacy AGENTS.md write is ${lines} lines, exceeds the ${AGENTS_MD_MAX_LINES}-line cap`,
      );
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
    "Explore the codebase, fill the structured codebase map via write_map, and close every coverage area before emitting artifact_intents.",
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
  const sourceStateDir = toRel(options.cwd, stateDirResolved.absoluteDir);
  const previousManifest = readManifestAt(options.cwd, sourceStateDir);
  if (stateDirResolved.legacy) {
    options.ui.info(
      `agentify: detected legacy state at ${LEGACY_PI_STATE_RELATIVE_DIR}/; future runs will use ${stateDir}`,
    );
  }
  // Capture the resolved state directory in run-owned tools and rendering context.
  // Deprecated mutable adapters remain available only for direct legacy callers.
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
  });
  let commitState = false;
  let artifactSnapshotForRollback: RunArtifactSnapshot | null = null;
  try {
    const artifactSnapshot = collectAuditArtifactSnapshot(options.cwd);
    artifactSnapshotForRollback = artifactSnapshot;
    // Absolute paths of pre-existing user-owned artifacts the builder
    // must not overwrite mid-session (B4 / defense repo protection).
    const protectedPaths = [...artifactSnapshot.entries()]
      .filter(([, entry]) => entry.ownership === "unmanaged")
      .map(([rel]) => path.resolve(options.cwd, rel));

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

    options.ui.status("agentify: auditing existing codebase");
    setAgentifySessionActive(sessionId, true);
    const runtimeResult = await options.runtime.runSession({
      cwd: options.cwd,
      configDir: defaultConfigDir(),
      config,
      systemPrompt: promptContent,
      userPrompt: buildBrownfieldUserPrompt(options.targets, options.additionalAgents),
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
        // spawn_explorer is created inside PiSdkRuntime.runSession so it
        // can use the same ModelRegistry + explorer slot the rest of
        // the session uses.
      ],
      spawnExplorerAgentDir: defaultConfigDir(),
      spawnExplorerStateDir: stateDir,
      signal: options.signal,
      onEvent: (event) => {
        const piType = (event as { type?: string }).type ?? "unknown";
        log.sessionEvent({ pi_event_type: piType, event });
        if (piType === "message_start" && (event as { message?: { role?: string } }).message?.role === "user") {
          log.recordTurnStart();
        } else if (piType === "message_end") {
          log.incrementTurns();
          log.recordTurnEnd(extractUsage(event));
        } else if (piType === "tool_execution_end") {
          const toolEvent = event as { toolName?: string; result?: WriteMapResult };
          if (toolEvent.toolName === "write_map") {
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
            }
          } else if (toolEvent.toolName === "spawn_explorer") {
            log.subagentSpawned({
              tool_name: "spawn_explorer",
              details: (toolEvent.result as { details?: unknown } | undefined)?.details ?? null,
              is_error: toolEvent.result?.isError ?? false,
            });
          }
        }
      },
    });

    const finalState: FinalAuditState = runtimeResult.aborted
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

    // Preserve the canonical codebase map; remove only the
    // transient draft/history/logs transport.
    cleanupTransientScaffoldingAt(options.cwd, stateDir);
    // Capture session-written feature agents BEFORE the rollback
    // below wipes `.pi/agents/` (it's in GENERATED_SURFACE_PATHS
    // and any file not in the pre-run snapshot gets removed). The
    // harness exporters read from a separate `stagingRoot` built
    // later in this function, so they need the runtime's agent
    // files mirrored across. The temp dir is cleaned up after
    // apply.
    const sessionAgentsSnapshotDir = captureSessionAgentFiles(options.cwd);
    // User-owned AGENTS.md: if the user already had an unmanaged
    // AGENTS.md in the target repo before this run, agentify
    // must not silently overwrite it. The renderer still emits a
    // managed AGENTS.md into staging; the apply step needs to
    // recognize the conflict and abort (which fires the existing
    // "required generated file conflict" UI error), and the
    // exporter needs to skip CLAUDE.md so we don't write a
    // derived file that contradicts the user's own AGENTS.md.
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
          writeRenderedArtifactsToStaging(stagingRoot, renderResult.artifacts, metadata);
          copyCanonicalMapToStaging(options.cwd, stagingRoot, stateDir, metadata);
          // Mirror the runtime's `.pi/agents/*.md` writes (captured
          // before the rollback above wiped them from `options.cwd`)
          // into the staging tree so the exporters can find them.
          mirrorSessionOutputToStaging(sessionAgentsSnapshotDir, stagingRoot);
          // Skill curation: classify the project and decide which
          // skills ship. The set is passed to the exporter so tier-
          // excluded skills never reach the staging tree. After
          // the apply, `removeStaleSkills` (below) deletes any
          // previously-installed skills that dropped out of tier
          // since the last run.
          const classification = ProjectClassifier.classify(options.cwd);
          const skillTiers = readPackagedSkillTiers(packageRoot());
          const { shipped: shippedSkills } = skillsForClassification(classification, skillTiers);
          const exportResults = exportAgenticSurface({
            cwd: stagingRoot,
            packageRoot: packageRoot(),
            targets: options.targets,
            additionalAgents: options.additionalAgents,
            allowedSkills: shippedSkills,
            userOwnedAgentsMd,
          });
          for (const result of exportResults) {
            addWriteMetadata(stagingRoot, result.writes, `harness-export:${result.target}`, metadata);
          }
          const scaffoldWrites = installScaffoldRuntime({
            cwd: stagingRoot,
            packageRoot: packageRoot(),
          });
          addWriteMetadata(stagingRoot, scaffoldWrites, "scaffold-installer", metadata);

          // Persist the pre-run snapshot so `agentify revert` can
          // restore the user's originals. Uses the same runId
          // that the manifest will carry. The previous manifest is
          // also read for the stale-skill removal step (see below).
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
            policy: userOwnedAgentsMd
              ? withAbortOnRequired(resolveApplyPolicy(options.cwd, stateDir))
              : resolveApplyPolicy(options.cwd, stateDir),
            runId,
            stateDir,
          });
          cleanupSessionAgentSnapshot(sessionAgentsSnapshotDir);
          const conflicts = applyResult.writes.filter((write) => write.action === "conflict");
          const scaffoldInstalled = applyResult.writes
            .filter((write) => write.action === "written")
            .filter((write) => {
              const rel = toRel(options.cwd, write.path);
              return rel === "SETUP.md" || rel.startsWith(".github/");
            })
            .length;

          if (applyResult.requiredConflictCount > 0) {
            reportedStatus = "partial";
            stateTransaction.rollback();
            options.ui.error(
              `agentify: required generated file conflict(s) blocked apply; no bundle files were written.`,
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
            const repoState = inspectAgentifyRepoState(options.cwd, defaultConfigDir());
            reportedStatus = repoState.status === "ready" ? "success" : "partial";
            // Tier-down: delete any previously-installed skill that
            // the new classifier / tier frontmatter no longer ships.
            removeStaleSkills(options.cwd, previousManifest, shippedSkills, options.ui.info);
            options.ui.info(
              `agentify: audit complete. ${repoState.featureAgentCount} feature agent(s), ` +
                `${exportResults.length} harness export(s), ${scaffoldInstalled} scaffold file(s) installed, ` +
                `${conflicts.length} optional conflict(s).`,
            );
            for (const line of formatApplyReport(applyResult.writes, options.cwd)) {
              options.ui.info(line);
            }
            reportGitHubReadiness(options);
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

    log.sessionEnd({
      duration_ms: Date.now() - start,
      was_aborted: runtimeResult.aborted,
      status: reportedStatus,
    });
    log.runEnd({
      exit_code: runtimeResult.aborted ? -1 : 0,
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (artifactSnapshotForRollback) {
      rollbackGeneratedSurface(options.cwd, artifactSnapshotForRollback);
    }
    stateTransaction.rollback();
    log.runEnd({ exit_code: -1, status: "error", error_message: message });
    options.ui.error(`agentify: ${message}`);
    throw err;
  } finally {
    setAgentifySessionActive(sessionId, false);
    await log.close();
  }
}
