import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ensureAgentifyConfig } from "./agentify-config.ts";
import {
  AGENTIFY_MANAGED_MARKERS,
  addMarkdownManagedMarker,
  exportAgenticSurface,
} from "./artifact-exporters.ts";
import { packageRoot } from "./pi-sdk-runtime.ts";
import { ProjectClassifier } from "./project-classifier.ts";
import { installScaffoldRuntime } from "./scaffold-installer.ts";
import { formatGitHubReadiness, inspectGitHubReadiness } from "./github-readiness.ts";
import { writeProjectState } from "./project-state.ts";
import type {
  AgentifyConfig,
  AgentifyTarget,
  ProjectKind,
  RunAgentifyOptions,
  ArtifactWrite,
} from "./types.ts";
import { AgentifyLog } from "./audit/log.ts";
import { loadBuilderPrompt } from "./audit/prompt.ts";
import {
  COVERAGE_DIMENSIONS,
} from "./audit/schema.ts";
import {
  getOrCreateSessionId,
  setAgentifySessionActive,
  setThinkingLevel,
} from "./audit/state.ts";
import { createSpawnExplorerTool } from "./audit/spawn-explorer-tool.ts";
import { writeMapDeltaTool, writeMapTool } from "./audit/write-map-tool.ts";

const AGENTS_MD_PATH = "AGENTS.md";
const INTERNAL_MAP_DIR = path.join(".pi", "agentify");
const BUILDER_TOOL_ALLOWLIST = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "write",
  "edit",
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
};

type AuditArtifactSnapshot = Map<string, "managed" | "unmanaged">;

const ALWAYS_ON_ARTIFACTS = [
  "specs/README.md",
  "ai_docs/README.md",
] as const;

const RESERVED_AGENT_NAMES = new Set([
  "scout.md",
  "review.md",
  "implement.md",
  "test.md",
  "fix.md",
  "document.md",
]);

function cleanupInternalScaffolding(cwd: string): void {
  try {
    fs.rmSync(path.join(cwd, INTERNAL_MAP_DIR), { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
}

function toRel(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath).split(path.sep).join("/");
}

function listExistingAgentMarkdown(cwd: string): string[] {
  const agentsDir = path.join(cwd, ".pi", "agents");
  if (!fs.existsSync(agentsDir)) return [];
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(agentsDir, entry.name));
}

function collectAuditArtifactSnapshot(cwd: string): AuditArtifactSnapshot {
  const snapshot: AuditArtifactSnapshot = new Map();
  const candidates = [
    path.join(cwd, AGENTS_MD_PATH),
    ...ALWAYS_ON_ARTIFACTS.map((rel) => path.join(cwd, rel)),
    ...listExistingAgentMarkdown(cwd),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    snapshot.set(
      toRel(cwd, filePath),
      content.includes(AGENTIFY_MANAGED_MARKERS.markdown) ? "managed" : "unmanaged",
    );
  }
  return snapshot;
}

function listAuditArtifacts(cwd: string): string[] {
  return [
    path.join(cwd, AGENTS_MD_PATH),
    ...ALWAYS_ON_ARTIFACTS.map((rel) => path.join(cwd, rel)),
    ...listExistingAgentMarkdown(cwd),
  ];
}

function markAuditArtifacts(
  cwd: string,
  snapshot: AuditArtifactSnapshot,
): ArtifactWrite[] {
  const writes: ArtifactWrite[] = [];
  for (const filePath of listAuditArtifacts(cwd)) {
    if (!fs.existsSync(filePath)) continue;
    const rel = toRel(cwd, filePath);
    if (snapshot.get(rel) === "unmanaged") {
      writes.push({
        path: filePath,
        action: "conflict",
        reason: "existing file is not agentify-managed",
      });
      continue;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.includes(AGENTIFY_MANAGED_MARKERS.markdown)) {
      writes.push({ path: filePath, action: "skipped" });
      continue;
    }
    fs.writeFileSync(filePath, addMarkdownManagedMarker(content), { mode: 0o644 });
    writes.push({ path: filePath, action: "written" });
  }
  return writes;
}

function loadAgentifyVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(packageRoot(), "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
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

function readFinalAuditState(cwd: string): FinalAuditState {
  const agentsMdExists = fs.existsSync(path.join(cwd, AGENTS_MD_PATH));
  let alwaysOnWritten = 0;
  for (const rel of ALWAYS_ON_ARTIFACTS) {
    if (fs.existsSync(path.join(cwd, rel))) alwaysOnWritten += 1;
  }

  let featureAgentsWritten = 0;
  const agentsDir = path.join(cwd, ".pi", "agents");
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir)) {
      if (entry.endsWith(".md") && !RESERVED_AGENT_NAMES.has(entry)) {
        featureAgentsWritten += 1;
      }
    }
  }

  const success = agentsMdExists && alwaysOnWritten === ALWAYS_ON_ARTIFACTS.length;
  return {
    status: success ? "success" : "partial",
    covered: agentsMdExists ? COVERAGE_DIMENSIONS.length : 0,
    gap: agentsMdExists ? 0 : COVERAGE_DIMENSIONS.length,
    total: COVERAGE_DIMENSIONS.length,
    agentsMdExists,
    alwaysOnWritten,
    alwaysOnTotal: ALWAYS_ON_ARTIFACTS.length,
    featureAgentsWritten,
  };
}

function buildBrownfieldUserPrompt(targets: ReadonlyArray<AgentifyTarget>): string {
  return [
    "Audit this existing codebase and bootstrap its agentic surface.",
    "Explore the codebase, fill the structured codebase map via write_map, and close every coverage area before writing user-facing files.",
    "The map is internal scaffolding and must not be treated as a deliverable.",
    "Emit codebase-emergent intelligence only: AGENTS.md, specs/README.md, ai_docs/README.md, feature-specialized .pi/agents/<feature>.md files, conditional docs, feedback-loop state, expert prompts, and proposed domain model artifacts when warranted.",
    "Do not emit generic build-chain primitives; those ship as agentify skills and will be exported separately.",
    `The standalone CLI will export the audited intelligence for these harness targets after the audit: ${targets.join(", ")}.`,
    "Skip user-owned files. Honest sparseness beats padding.",
  ].join(" ");
}

async function chooseAmbiguousKind(options: RunAgentifyOptions): Promise<ProjectKind> {
  const value = await options.ui.promptSelect(
    "This repository is ambiguous. Should agentify audit existing files or start a new-project chat?",
    [
      { label: "Audit existing files", value: "brownfield" },
      { label: "Start new project chat", value: "greenfield" },
    ],
  );
  return value === "greenfield" ? "greenfield" : "brownfield";
}

function getGitHubReadiness(options: RunAgentifyOptions) {
  return options.githubReadinessOverride
    ?? inspectGitHubReadiness({ cwd: options.cwd });
}

function reportGitHubReadiness(options: RunAgentifyOptions): void {
  const readiness = getGitHubReadiness(options);
  for (const line of formatGitHubReadiness(readiness)) {
    options.ui.info(line);
  }
}

function persistProjectState(options: RunAgentifyOptions, params: {
  projectKind: "brownfield" | "greenfield" | "unknown";
  runStatus: "success" | "partial" | "aborted" | "error";
  repoMode: "brownfield" | "greenfield" | "unknown";
  repoStatus: "uninitialized" | "partial" | "ready";
  featureAgentCount: number;
  latestLogPath: string | null;
}): void {
  const readiness = getGitHubReadiness(options);
  writeProjectState(options.configDir, {
    cwd: options.cwd,
    lastRunAt: new Date().toISOString(),
    projectKind: params.projectKind,
    runStatus: params.runStatus,
    repoMode: params.repoMode,
    repoStatus: params.repoStatus,
    featureAgentCount: params.featureAgentCount,
    latestLogPath: params.latestLogPath,
    github: {
      hasGitDirectory: readiness.hasGitDirectory,
      hasGitHubRemote: readiness.hasGitHubRemote,
      ghCliAvailable: readiness.ghCliAvailable,
      originUrl: readiness.originUrl,
    },
  });
}

async function runBrownfieldAudit(
  options: RunAgentifyOptions,
  config: AgentifyConfig,
): Promise<void> {
  cleanupInternalScaffolding(options.cwd);
  const artifactSnapshot = collectAuditArtifactSnapshot(options.cwd);
  const promptContent = loadBuilderPrompt();
  const promptSha = crypto.createHash("sha256").update(promptContent).digest("hex");
  const log = new AgentifyLog({ cwd: options.cwd, configDir: options.configDir });
  const start = Date.now();
  const sessionId = getOrCreateSessionId();
  setThinkingLevel(config.thinkingLevel ?? "high");

  log.runStart({
    cwd: options.cwd,
    args: options.args ?? "",
    model: config.model ?? "auto",
    thinking_level: config.thinkingLevel ?? "high",
    agentify_version: loadAgentifyVersion(),
    sdk_version: PI_SDK_VERSION,
    system_prompt_sha256: promptSha,
    system_prompt_path: "src/core/audit/prompts/builder.md",
    tool_allowlist: BUILDER_TOOL_ALLOWLIST,
  });

  options.ui.status("agentify: auditing existing codebase");
  setAgentifySessionActive(sessionId, true);
  try {
    const runtimeResult = await options.runtime.runSession({
      cwd: options.cwd,
      configDir: options.configDir,
      config,
      systemPrompt: promptContent,
      userPrompt: buildBrownfieldUserPrompt(options.targets),
      tools: BUILDER_TOOL_ALLOWLIST,
      customTools: [
        writeMapTool,
        writeMapDeltaTool,
        createSpawnExplorerTool({ agentDir: options.configDir }),
      ],
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

    const finalState = runtimeResult.aborted
      ? {
          status: "aborted" as const,
          covered: 0,
          gap: COVERAGE_DIMENSIONS.length,
          total: COVERAGE_DIMENSIONS.length,
          agentsMdExists: false,
          alwaysOnWritten: 0,
          alwaysOnTotal: ALWAYS_ON_ARTIFACTS.length,
          featureAgentsWritten: 0,
        }
      : readFinalAuditState(options.cwd);

    cleanupInternalScaffolding(options.cwd);
    if (finalState.status === "success") {
      const ownershipWrites = markAuditArtifacts(options.cwd, artifactSnapshot);
      const exportResults = exportAgenticSurface({
        cwd: options.cwd,
        packageRoot: packageRoot(),
        targets: options.targets,
      });
      const scaffoldWrites = installScaffoldRuntime({
        cwd: options.cwd,
        packageRoot: packageRoot(),
      });
      const conflicts = [
        ...ownershipWrites,
        ...exportResults.flatMap((result) => result.writes),
        ...scaffoldWrites,
      ]
        .filter((write) => write.action === "conflict");
      const scaffoldInstalled = scaffoldWrites.filter((write) => write.action === "written").length;
      options.ui.info(
        `agentify: audit complete. ${finalState.featureAgentsWritten} feature agent(s), ` +
          `${exportResults.length} harness export(s), ${scaffoldInstalled} scaffold file(s) installed, ` +
          `${conflicts.length} conflict(s).`,
      );
      reportGitHubReadiness(options);
      persistProjectState(options, {
        projectKind: "brownfield",
        runStatus: "success",
        repoMode: "brownfield",
        repoStatus: "ready",
        featureAgentCount: finalState.featureAgentsWritten,
        latestLogPath: log.logPath,
      });
    } else {
      options.ui.error("agentify: audit did not complete; no harness export was run.");
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
      status: finalState.status,
    });
    log.runEnd({
      exit_code: runtimeResult.aborted ? -1 : 0,
      status: finalState.status,
      coverage: {
        covered: finalState.covered,
        gap: finalState.gap,
        total: finalState.total,
      },
      agents_md_path: finalState.agentsMdExists
        ? path.join(options.cwd, AGENTS_MD_PATH)
        : null,
    });
    options.ui.info(`agentify: log written to ${log.logPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.runEnd({ exit_code: -1, status: "error", error_message: message });
    options.ui.error(`agentify: ${message}`);
    throw err;
  } finally {
    setAgentifySessionActive(sessionId, false);
    await log.close();
  }
}

async function runGreenfield(options: RunAgentifyOptions, config: AgentifyConfig): Promise<void> {
  options.ui.status("agentify: starting greenfield chat");
  const result = await options.runtime.runGreenfield({
    cwd: options.cwd,
    configDir: options.configDir,
    config,
    signal: options.signal,
  });
  let scaffoldInstalled = 0;
  let scaffoldConflicts = 0;
  if (!result.aborted) {
    const scaffoldWrites = installScaffoldRuntime({
      cwd: options.cwd,
      packageRoot: packageRoot(),
    });
    scaffoldInstalled = scaffoldWrites.filter((write) => write.action === "written").length;
    scaffoldConflicts = scaffoldWrites.filter((write) => write.action === "conflict").length;
  }
  options.ui.info(
    `agentify: greenfield session complete (${result.turns} turn(s)` +
      `${result.costUsd === null ? "" : `, $${result.costUsd.toFixed(4)}`}` +
      `${result.aborted ? ")" : `, ${scaffoldInstalled} scaffold file(s) installed, ${scaffoldConflicts} conflict(s))`}.`,
  );
  if (!result.aborted) {
    reportGitHubReadiness(options);
    persistProjectState(options, {
      projectKind: "greenfield",
      runStatus: "success",
      repoMode: "greenfield",
      repoStatus: "ready",
      featureAgentCount: 0,
      latestLogPath: null,
    });
  } else {
    persistProjectState(options, {
      projectKind: "greenfield",
      runStatus: "aborted",
      repoMode: "greenfield",
      repoStatus: "partial",
      featureAgentCount: 0,
      latestLogPath: null,
    });
  }
}

export async function runAgentify(options: RunAgentifyOptions): Promise<void> {
  const config = options.configOverride
    ?? await ensureAgentifyConfig(options.configDir, options.ui);
  const classification = options.assumeProjectKind
    ? { kind: options.assumeProjectKind }
    : ProjectClassifier.classify(options.cwd);
  let kind = classification.kind;
  if (kind === "ambiguous") {
    kind = await chooseAmbiguousKind(options);
  }

  if (kind === "greenfield") {
    await runGreenfield(options, config);
    return;
  }
  await runBrownfieldAudit(options, config);
}
