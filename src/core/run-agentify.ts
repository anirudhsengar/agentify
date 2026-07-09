import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { defaultConfigDir, ensureAgentifyConfig } from "./agentify-config.ts";
import {
  alongsidePathFor,
  resolveActionForPath,
  type ApplyPolicy,
} from "./apply-policy.ts";
import { resolveApplyPolicy } from "./agentifyrc.ts";
import { exportAgenticSurface } from "./artifact-exporters.ts";
import { newRunId, persistRunArtifacts } from "./revert.ts";
import { packageRoot } from "./pi-sdk-runtime.ts";
import { ProjectClassifier } from "./project-classifier.ts";
import { installScaffoldRuntime } from "./scaffold-installer.ts";
import { formatGitHubReadiness, inspectGitHubReadiness } from "./github-readiness.ts";
import { inspectAgentifyRepoState } from "./repo-status.ts";
import { writeProjectState } from "./project-state.ts";
import {
  renderBrownfieldArtifacts,
  setRendererStateDir,
  type RenderedArtifact,
} from "./artifacts/renderers.ts";
import {
  codebaseMapRelativePath,
  kindForPath,
  manifestFileFromContent,
  manifestRelativePath,
  markerForPath,
  readManifestAt,
  sha256,
  writeManifestAt,
  type ManagedManifest,
  type ManagedManifestFile,
} from "./manifest.ts";
import {
  LEGACY_PI_STATE_RELATIVE_DIR,
  resolveCanonicalStateDir,
} from "./state-dir.ts";
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
  AGENTS_MD_MAX_LINES,
  COVERAGE_DIMENSIONS,
  assessCoverageClosure,
} from "./audit/schema.ts";
import {
  getOrCreateSessionId,
  setAgentifySessionActive,
  setThinkingLevel,
} from "./audit/state.ts";
// spawn_explorer is constructed inside PiSdkRuntime.runSession (ADR 0017),
// so the tool factory is imported only in pi-sdk-runtime.ts.
import {
  DRAFT_TRANSPORT_DIR,
  loadCanonicalMapAt,
  setMapSessionStateDir,
  writeMapDeltaTool,
  writeMapTool,
} from "./audit/write-map-tool.ts";
import {
  buildGreenfieldStateAt,
  validateGreenfieldArtifacts,
  writeGreenfieldStateAt,
} from "./greenfield-state.ts";
import {
  readGreenfieldFormationAt,
  renderGreenfieldArtifacts,
} from "./greenfield-artifacts.ts";

const AGENTS_MD_PATH = "AGENTS.md";
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
  /** Why the audit did not reach `success`, when applicable. */
  gapReasons: string[];
};

type AuditSnapshotEntry = {
  ownership: "managed" | "unmanaged";
  content: Buffer;
  mode: number;
};

type AuditArtifactSnapshot = Map<string, AuditSnapshotEntry>;

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

const GENERATED_SURFACE_PATHS = [
  AGENTS_MD_PATH,
  "CLAUDE.md",
  "CONTEXT.md",
  "specs/README.md",
  "ai_docs/README.md",
  "conditional_docs.md",
  ".pi/conditional_docs.md",
  "SETUP.md",
  ".pi/agents",
  ".pi/prompts",
  ".pi/workflows",
  ".pi/extensions",
  ".pi/skills",
  ".agents",
  ".claude",
  ".codex",
  ".github/actions",
  ".github/agent-prompts",
  ".github/scripts",
  ".github/workflows",
  "app_docs",
  "app_review",
  "app_fix_reports",
] as const;

// State-dir-aware paths. The audit resolves the active state dir
// once at the top of `runBrownfieldAudit` / `runGreenfield` and
// threads `stateDirRelative` through every writer. For cleanup
// we still use the legacy `.pi/agentify/` path because that's
// where the current code writes; the provider-scoped state dir
// migration will be wired in Step 5 when snapshot persistence
// lives under the resolved dir.
const INTERNAL_STATE_PATHS = [
  codebaseMapRelativePath(LEGACY_PI_STATE_RELATIVE_DIR),
  manifestRelativePath(LEGACY_PI_STATE_RELATIVE_DIR),
] as const;

/**
 * Internal state paths (canonical map + managed manifest) under
 * the supplied state dir. Used by the state-dir-aware snapshot
 * path (ADR 0020).
 */
function internalStatePathsFor(stateDir: string): readonly string[] {
  return [codebaseMapRelativePath(stateDir), manifestRelativePath(stateDir)];
}

function cleanupInternalScaffolding(cwd: string): void {
  try {
    fs.rmSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
}

/**
 * State-dir-aware cleanup of the entire audit state dir. Used by
 * the brownfield audit at the start of a run to ensure no stale
 * state from a previous provider choice is left behind (ADR 0020).
 */
function cleanupInternalScaffoldingAt(cwd: string, stateDir: string): void {
  try {
    fs.rmSync(path.join(cwd, stateDir), { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
}

// Remove only the transient draft/history transport, preserving the
// canonical codebase_map.json. Run at the END of a run so the map
// survives as a managed audit artifact (ADR 0014): AGENTS.md points to
// it, and partial/aborted runs keep their progress for inspection.
function cleanupTransientScaffolding(cwd: string): void {
  const transient = [
    path.join(cwd, DRAFT_TRANSPORT_DIR),
    path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, "history"),
    path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, "logs"),
  ];
  for (const target of transient) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }
}

/**
 * State-dir-aware transient cleanup. Mirrors
 * `cleanupTransientScaffolding` but targets the resolved state dir
 * (ADR 0020).
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
  return path.relative(cwd, filePath).split(path.sep).join("/");
}

function listFilesRecursively(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

function listGeneratedSurfaceFiles(cwd: string): string[] {
  const files = new Set<string>();
  for (const rel of GENERATED_SURFACE_PATHS) {
    for (const filePath of listFilesRecursively(path.join(cwd, rel))) {
      files.add(filePath);
    }
  }
  return [...files];
}

function fileHasManagedMarker(relativePath: string, content: Buffer): boolean {
  const marker = markerForPath(relativePath);
  if (marker === "sha256") return true;
  return content.toString("utf-8").includes(marker);
}

function collectAuditArtifactSnapshot(cwd: string): AuditArtifactSnapshot {
  const snapshot: AuditArtifactSnapshot = new Map();
  for (const filePath of listGeneratedSurfaceFiles(cwd)) {
    if (!fs.existsSync(filePath)) continue;
    const rel = toRel(cwd, filePath);
    const content = fs.readFileSync(filePath);
    snapshot.set(rel, {
      ownership: fileHasManagedMarker(rel, content) ? "managed" : "unmanaged",
      content,
      mode: fs.statSync(filePath).mode & 0o777,
    });
  }
  return snapshot;
}

function restoreSnapshotFile(cwd: string, relativePath: string, entry: AuditSnapshotEntry): void {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entry.content, { mode: entry.mode });
  try {
    fs.chmodSync(filePath, entry.mode);
  } catch {
    // Best effort on filesystems without chmod support.
  }
}

function cleanupEmptyGeneratedDirs(cwd: string): void {
  const dirs = GENERATED_SURFACE_PATHS
    .map((rel) => path.join(cwd, rel))
    .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory())
    .sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Directory was not empty or disappeared; both are fine.
    }
  }
}

function rollbackGeneratedSurface(
  cwd: string,
  snapshot: AuditArtifactSnapshot,
): { removed: number; restored: number } {
  let removed = 0;
  let restored = 0;
  for (const filePath of listGeneratedSurfaceFiles(cwd)) {
    const rel = toRel(cwd, filePath);
    const entry = snapshot.get(rel);
    if (entry) {
      restoreSnapshotFile(cwd, rel, entry);
      restored += 1;
      continue;
    }
    fs.rmSync(filePath, { force: true });
    removed += 1;
  }
  for (const [rel, entry] of snapshot) {
    const filePath = path.join(cwd, rel);
    if (!fs.existsSync(filePath)) {
      restoreSnapshotFile(cwd, rel, entry);
      restored += 1;
    }
  }
  cleanupEmptyGeneratedDirs(cwd);
  return { removed, restored };
}

function collectInternalStateSnapshot(cwd: string): AuditArtifactSnapshot {
  const snapshot: AuditArtifactSnapshot = new Map();
  for (const rel of INTERNAL_STATE_PATHS) {
    const filePath = path.join(cwd, rel);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath);
    snapshot.set(rel, {
      ownership: "managed",
      content,
      mode: fs.statSync(filePath).mode & 0o777,
    });
  }
  return snapshot;
}

function restoreInternalStateSnapshot(cwd: string, snapshot: AuditArtifactSnapshot): void {
  for (const rel of INTERNAL_STATE_PATHS) {
    const filePath = path.join(cwd, rel);
    const entry = snapshot.get(rel);
    if (entry) {
      restoreSnapshotFile(cwd, rel, entry);
    } else {
      fs.rmSync(filePath, { force: true });
    }
  }
}

/**
 * State-dir-aware variant of `restoreInternalStateSnapshot`. Used
 * when the audit is wired to a provider-scoped state dir (ADR 0020).
 * The snapshot itself is built against the legacy constants for
 * backward compat — the function shape matches the legacy version
 * but operates on the supplied `stateDir`.
 */
function restoreInternalStateSnapshotAt(
  cwd: string,
  snapshot: AuditArtifactSnapshot,
  stateDir: string,
): void {
  for (const rel of internalStatePathsFor(stateDir)) {
    const filePath = path.join(cwd, rel);
    const entry = snapshot.get(rel);
    if (entry) {
      restoreSnapshotFile(cwd, rel, entry);
    } else {
      fs.rmSync(filePath, { force: true });
    }
  }
}

function writeFileUnderRoot(root: string, relativePath: string, content: string | Buffer): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o644 });
}

function makeStagingRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-staging-"));
}

function writeRenderedArtifactsToStaging(
  stagingRoot: string,
  artifacts: readonly RenderedArtifact[],
  metadata: Map<string, ManagedManifestFile>,
): void {
  for (const artifact of artifacts) {
    writeFileUnderRoot(stagingRoot, artifact.relativePath, artifact.content);
    metadata.set(artifact.relativePath, manifestFileFromContent({
      relativePath: artifact.relativePath,
      content: artifact.content,
      kind: artifact.kind,
      required: artifact.required,
      marker: artifact.marker,
      source: artifact.source,
    }));
  }
}

function copyCanonicalMapToStaging(
  cwd: string,
  stagingRoot: string,
  stateDir: string,
  metadata: Map<string, ManagedManifestFile>,
): void {
  const mapRelPath = codebaseMapRelativePath(stateDir);
  const source = path.join(cwd, mapRelPath);
  if (!fs.existsSync(source)) return;
  const content = fs.readFileSync(source);
  writeFileUnderRoot(stagingRoot, mapRelPath, content);
  metadata.set(mapRelPath, manifestFileFromContent({
    relativePath: mapRelPath,
    content,
    kind: "state",
    required: true,
    marker: markerForPath(mapRelPath),
    source: "write_map",
  }));
}

function collectStagedFiles(stagingRoot: string, stateDir: string): Array<{ relativePath: string; content: Buffer }> {
  const manifestRelPath = manifestRelativePath(stateDir);
  return listFilesRecursively(stagingRoot)
    .map((filePath) => ({
      relativePath: toRel(stagingRoot, filePath),
      content: fs.readFileSync(filePath),
    }))
    .filter((file) => file.relativePath !== manifestRelPath);
}

function addWriteMetadata(
  stagingRoot: string,
  writes: readonly ArtifactWrite[],
  source: string,
  metadata: Map<string, ManagedManifestFile>,
): void {
  for (const write of writes) {
    if (write.action === "conflict") continue;
    // For "alongside" actions, the writer wrote the content to
    // `alongsidePath` (a sibling of the canonical). The manifest
    // entry should key on the canonical path and record the
    // alongside path so `verifyManifest` and `revert` can find it.
    const contentPath = write.action === "alongside" && write.alongsidePath
      ? write.alongsidePath
      : write.path;
    const canonicalRelative = toRel(stagingRoot, write.path);
    const contentRelative = toRel(stagingRoot, contentPath);
    const filePath = path.join(stagingRoot, contentRelative);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath);
    const alongsideRel = write.action === "alongside" ? contentRelative : undefined;
    metadata.set(canonicalRelative, manifestFileFromContent({
      relativePath: canonicalRelative,
      content,
      kind: kindForPath(canonicalRelative),
      required: undefined,
      marker: markerForPath(canonicalRelative),
      source,
      alongsidePath: alongsideRel,
    }));
  }
}

function isConflictingDestination(
  cwd: string,
  relativePath: string,
  snapshot: AuditArtifactSnapshot,
): boolean {
  const destination = path.join(cwd, relativePath);
  if (!fs.existsSync(destination)) return false;
  const snapshotEntry = snapshot.get(relativePath);
  if (snapshotEntry) return snapshotEntry.ownership === "unmanaged";
  const content = fs.readFileSync(destination);
  return !fileHasManagedMarker(relativePath, content);
}

/**
 * Format the post-run report from the apply step's writes array.
 * The summary shows counts of each action (created, kept-user,
 * saved-alongside, conflicts) and lists the alongside saves with
 * their target paths. Output goes through `ui.info` so it appears
 * in the same channel as the rest of the run's output.
 *
 * The report is deliberately deterministic and scannable: the
 * counts line first, then the alongside list (capped at 16
 * entries with a "… and N more" line), then any conflicts. The
 * goal is that a user can see what happened at a glance without
 * diffing the manifest.
 */
function formatApplyReport(
  writes: readonly ArtifactWrite[],
  cwd: string,
): string[] {
  const written = writes.filter((w) => w.action === "written");
  const kept = writes.filter((w) => w.action === "skipped");
  const alongside = writes.filter((w) => w.action === "alongside");
  const conflicts = writes.filter((w) => w.action === "conflict");

  const lines: string[] = [];
  const conflictSuffix = conflicts.length > 0
    ? `, ${conflicts.length} conflict(s)`
    : "";
  lines.push(
    `agentify: apply report: ` +
    `${written.length} created, ` +
    `${kept.length} kept-user, ` +
    `${alongside.length} saved-alongside` +
    conflictSuffix +
    ".",
  );

  if (alongside.length > 0) {
    lines.push(
      "agentify: agentify's versions saved alongside (suffix .agentify.<ext>):",
    );
    for (const w of alongside.slice(0, 16)) {
      const rel = toRel(cwd, w.path);
      const alongsideRel = w.alongsidePath ?? alongsidePathFor(rel);
      lines.push(`agentify:   - ${rel} -> ${alongsideRel}`);
    }
    if (alongside.length > 16) {
      lines.push(`agentify:   ... and ${alongside.length - 16} more`);
    }
  }

  if (conflicts.length > 0) {
    lines.push(
      "agentify: conflicts (not written; requiredAction=abort in rc file):",
    );
    for (const w of conflicts.slice(0, 8)) {
      lines.push(
        `agentify:   - ${toRel(cwd, w.path)}: ${w.reason ?? "conflict"}`,
      );
    }
  }

  return lines;
}

/**
 * Build the JSON shape for `--plan --json` output. Returns an
 * object with counts and the would-be file actions, ready for
 * `JSON.stringify`. The manifest is the dry-run manifest produced
 * by `applyStagedBundle` — fully formed, just not written to disk.
 */
function planToJson(
  applyResult: { writes: ArtifactWrite[]; manifest: ManagedManifest | null },
  cwd: string,
): unknown {
  const writes = applyResult.writes.map((w) => {
    const rel = toRel(cwd, w.path);
    return {
      path: rel,
      action: w.action,
      reason: w.reason ?? null,
      alongside_path: w.alongsidePath ?? null,
    };
  });
  return {
    dry_run: true,
    summary: {
      created: writes.filter((w) => w.action === "written").length,
      kept_user: writes.filter((w) => w.action === "skipped").length,
      saved_alongside: writes.filter((w) => w.action === "alongside").length,
      conflicts: writes.filter((w) => w.action === "conflict").length,
    },
    manifest: applyResult.manifest,
    writes,
  };
}

function applyStagedBundle(params: {
  cwd: string;
  stagingRoot: string;
  snapshot: AuditArtifactSnapshot;
  metadata: Map<string, ManagedManifestFile>;
  agentifyVersion: string;
  mode: Exclude<ProjectKind, "ambiguous">;
  policy: ApplyPolicy;
  runId: string;
  stateDir: string;
  dryRun?: boolean;
}): { writes: ArtifactWrite[]; requiredConflictCount: number; manifest: ManagedManifest | null } {
  const stagedFiles = collectStagedFiles(params.stagingRoot, params.stateDir);
  const writes: ArtifactWrite[] = [];
  const manifestFiles: ManagedManifestFile[] = [];
  let requiredConflictCount = 0;

  for (const file of stagedFiles) {
    const baseEntry = params.metadata.get(file.relativePath)
      ?? manifestFileFromContent({ relativePath: file.relativePath, content: file.content });
    const isRequired = baseEntry.required;

    if (!isConflictingDestination(params.cwd, file.relativePath, params.snapshot)) {
      // No conflict — write the canonical file in the repo and
      // record the manifest entry unchanged.
      const destination = path.join(params.cwd, file.relativePath);
      const existing = fs.existsSync(destination) ? fs.readFileSync(destination) : null;
      const writeAction = existing && Buffer.compare(existing, file.content) === 0 ? "skipped" : "written";
      if (!params.dryRun) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file.content, { mode: 0o644 });
      }
      writes.push({ path: destination, action: writeAction });
      manifestFiles.push(baseEntry);
      continue;
    }

    // Conflict at the canonical path. Resolve per policy.
    const action = resolveActionForPath(params.policy, file.relativePath, isRequired);

    if (action === "abort") {
      if (isRequired) requiredConflictCount += 1;
      writes.push({
        path: path.join(params.cwd, file.relativePath),
        action: "conflict",
        reason: isRequired
          ? "required file conflict; set requiredAction to \"alongside\" in .agentifyrc to save alongside"
          : "existing file is not agentify-managed",
      });
      continue;
    }

    if (action === "keep") {
      // Leave the user's file; do not save agentify's version
      // anywhere. Record the user's sha so `revert` knows the
      // file was deliberately preserved.
      const userContent = fs.readFileSync(path.join(params.cwd, file.relativePath));
      const preservedSha = sha256(userContent);
      writes.push({
        path: path.join(params.cwd, file.relativePath),
        action: "skipped",
        reason: "user file kept; agentify's version discarded",
      });
      manifestFiles.push({ ...baseEntry, preservedSha256: preservedSha });
      continue;
    }

    // action === "alongside" (default). Write the staged content
    // to a sibling file next to the user's, leave the user's
    // file untouched, and record both paths in the manifest.
    const alongsideRel = alongsidePathFor(file.relativePath);
    const alongsideDest = path.join(params.cwd, alongsideRel);
    const userContent = fs.readFileSync(path.join(params.cwd, file.relativePath));
    const preservedSha = sha256(userContent);
    if (!params.dryRun) {
      fs.mkdirSync(path.dirname(alongsideDest), { recursive: true });
      fs.writeFileSync(alongsideDest, file.content, { mode: 0o644 });
    }
    writes.push({
      path: path.join(params.cwd, file.relativePath),
      action: "alongside",
      reason: "user file preserved; agentify's version saved alongside",
      alongsidePath: alongsideRel,
    });
    manifestFiles.push({
      ...baseEntry,
      sha256: sha256(file.content),
      alongsidePath: alongsideRel,
      preservedSha256: preservedSha,
    });
  }

  if (requiredConflictCount > 0) {
    return { writes, requiredConflictCount, manifest: null };
  }

  // Dry-run (`--plan`): report the would-be plan but do not write
  // anything to the repo. The manifest is computed but not written.
  // The staging dir is still cleaned up by the caller.
  if (params.dryRun) {
    const dryManifest: ManagedManifest = {
      schema_version: "2",
      agentify_version: params.agentifyVersion,
      generated_at: new Date().toISOString(),
      mode: params.mode,
      run_id: params.runId,
      files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
    };
    return { writes, requiredConflictCount, manifest: dryManifest };
  }

  const manifest: ManagedManifest = {
    schema_version: "2",
    agentify_version: params.agentifyVersion,
    generated_at: new Date().toISOString(),
    mode: params.mode,
    run_id: params.runId,
    files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeManifestAt(params.cwd, manifest, params.stateDir);
  writes.push({ path: path.join(params.cwd, manifestRelativePath(params.stateDir)), action: "written" });
  return { writes, requiredConflictCount, manifest };
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

// Decide audit success from the validated structured state, not from
// user-facing files. Renderers own AGENTS.md and always-on docs after
// the map closes, so the builder can complete without writing them.
function readFinalAuditState(cwd: string): FinalAuditState {
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
      if (entry.endsWith(".md") && !RESERVED_AGENT_NAMES.has(entry)) {
        featureAgentsWritten += 1;
      }
    }
  }

  const total = COVERAGE_DIMENSIONS.length;
  const gapReasons: string[] = [];
  const map = loadCanonicalMapAt(cwd, LEGACY_PI_STATE_RELATIVE_DIR);

  if (!map) {
    gapReasons.push(
      `no valid codebase map at ${LEGACY_PI_STATE_RELATIVE_DIR}/codebase_map.json (write_map was never completed or failed schema validation)`,
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
  writeProjectState(defaultConfigDir(), {
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
  const stateDirResolved = resolveCanonicalStateDir(
    options.cwd, options.targets, options.additionalAgents,
  );
  const stateDir = stateDirResolved.relativeDir;
  if (stateDirResolved.legacy) {
    options.ui.info(
      `agentify: detected legacy state at ${LEGACY_PI_STATE_RELATIVE_DIR}/; future runs will use ${stateDir}`,
    );
  }
  // Pin the legacy `write_map` / `write_map_delta` tools to the
  // resolved state dir so canonical map writes land at
  // `<stateDir>/codebase_map.json` rather than the historical
  // `.pi/agentify/` location (ADR 0020).
  setMapSessionStateDir(stateDir);
  // Pin the artifact renderer session the same way so feature
  // agents / prompts / workflows / skills / extensions land under
  // the resolved state dir rather than the legacy
  // `.pi/agentify/...` defaults (ADR 0020).
  setRendererStateDir(stateDir);
  const internalStateSnapshot = collectInternalStateSnapshot(options.cwd);
  cleanupInternalScaffoldingAt(options.cwd, stateDir);
  const artifactSnapshot = collectAuditArtifactSnapshot(options.cwd);
  // Absolute paths of pre-existing user-owned artifacts the builder
  // must not overwrite mid-session (B4 / defense repo protection).
  const protectedPaths = [...artifactSnapshot.entries()]
    .filter(([, entry]) => entry.ownership === "unmanaged")
    .map(([rel]) => path.resolve(options.cwd, rel));
  const promptContent = loadBuilderPrompt(stateDir);
  const promptSha = crypto.createHash("sha256").update(promptContent).digest("hex");
  const log = new AgentifyLog({ cwd: options.cwd, configDir: defaultConfigDir() });
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
      configDir: defaultConfigDir(),
      config,
      systemPrompt: promptContent,
      userPrompt: buildBrownfieldUserPrompt(options.targets, options.additionalAgents),
      tools: BUILDER_TOOL_ALLOWLIST,
      repoJail: true,
      protectedPaths,
      customTools: [
        writeMapTool,
        writeMapDeltaTool,
        // spawn_explorer is created inside PiSdkRuntime.runSession so it
        // can use the same ModelRegistry + explorer slot the rest of
        // the session uses. ADR 0017.
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
      : readFinalAuditState(options.cwd);

    // Preserve the canonical codebase map (ADR 0014); remove only the
    // transient draft/history/logs transport.
    cleanupTransientScaffoldingAt(options.cwd, stateDir);
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
        ? renderBrownfieldArtifacts(map)
        : { artifacts: [], errors: ["validated codebase map disappeared before rendering"] };

      if (renderResult.errors.length > 0) {
        reportedStatus = "partial";
        restoreInternalStateSnapshotAt(options.cwd, internalStateSnapshot, stateDir);
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
          const exportResults = exportAgenticSurface({
            cwd: stagingRoot,
            packageRoot: packageRoot(),
            targets: options.targets,
            additionalAgents: options.additionalAgents,
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
          // that the manifest will carry.
          const runId = crypto.randomUUID();
          if (!options.dryRun) {
            const previousManifest = readManifestAt(options.cwd, stateDir);
            persistRunArtifacts({
              cwd: options.cwd,
              stateDir,
              runId,
              snapshot: artifactSnapshot as unknown as Record<string, { content: Buffer; mode: number; ownership: "managed" | "unmanaged" }>,
              previousManifest,
            });
          }

          const applyResult = applyStagedBundle({
            cwd: options.cwd,
            stagingRoot,
            snapshot: artifactSnapshot,
            metadata,
            agentifyVersion: loadAgentifyVersion(),
            mode: "brownfield",
            policy: resolveApplyPolicy(options.cwd, stateDir),
            runId,
            stateDir,
            dryRun: options.dryRun,
          });
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
            restoreInternalStateSnapshotAt(options.cwd, internalStateSnapshot, stateDir);
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
            if (options.dryRun && options.jsonOutput && applyResult.manifest) {
              // --plan --json: emit the would-be plan as JSON to
              // stdout (via ui.status which goes to stdout) and
              // skip the human-readable report. The manifest is
              // dry-run (not written to disk) but is fully formed.
              process.stdout.write(
                JSON.stringify(planToJson(applyResult, options.cwd), null, 2) + "\n",
              );
            } else {
              options.ui.info(
                `agentify: audit complete. ${repoState.featureAgentCount} feature agent(s), ` +
                  `${exportResults.length} harness export(s), ${scaffoldInstalled} scaffold file(s) installed, ` +
                  `${conflicts.length} optional conflict(s).`,
              );
              for (const line of formatApplyReport(applyResult.writes, options.cwd)) {
                options.ui.info(line);
              }
            }
            reportGitHubReadiness(options);
            if (options.dryRun) {
              // Dry-run: skip project state write so the next run
              // doesn't see a stale "last run" record for a run
              // that never actually wrote anything.
              options.ui.info("agentify: dry-run complete; no files written, no project state recorded.");
            } else {
              persistProjectState(options, {
                projectKind: "brownfield",
                runStatus: reportedStatus,
                repoMode: "brownfield",
                repoStatus: repoState.status,
                featureAgentCount: repoState.featureAgentCount,
                latestLogPath: log.logPath,
              });
            }
          }
        } finally {
          fs.rmSync(stagingRoot, { recursive: true, force: true });
          options.ui.info(`agentify: cleaned staging bundle at ${stagingRoot}`);
        }
      }
    } else {
      const rollback = rollbackGeneratedSurface(options.cwd, artifactSnapshot);
      restoreInternalStateSnapshotAt(options.cwd, internalStateSnapshot, stateDir);
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rollbackGeneratedSurface(options.cwd, artifactSnapshot);
    restoreInternalStateSnapshotAt(options.cwd, internalStateSnapshot, stateDir);
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
  const stateDir = resolveCanonicalStateDir(
    options.cwd, options.targets, options.additionalAgents,
  ).relativeDir;
  const artifactSnapshot = collectAuditArtifactSnapshot(options.cwd);
  setThinkingLevel(config.thinkingLevel ?? "high");
  // Activate the defense hook for the greenfield session too. Without
  // this, the hook is inert (state.ts) and the greenfield session runs
  // bash/write unguarded, unlike the hardened brownfield session.
  const sessionId = getOrCreateSessionId();
  setAgentifySessionActive(sessionId, true);
  let result: Awaited<ReturnType<typeof options.runtime.runGreenfield>>;
  try {
    result = await options.runtime.runGreenfield({
      cwd: options.cwd,
      configDir: defaultConfigDir(),
      config,
      signal: options.signal,
    });
  } finally {
    setAgentifySessionActive(sessionId, false);
  }
  let scaffoldInstalled = 0;
  let scaffoldConflicts = 0;
  let artifactsValid = false;
  let validationReported = false;
  if (!result.aborted) {
    const formation = readGreenfieldFormationAt(options.cwd, stateDir);
    if (!formation) {
      options.ui.error(
        "agentify: greenfield session did not submit structured artifacts with write_greenfield_artifacts; scaffold was not installed.",
      );
    } else {
      const renderResult = renderGreenfieldArtifacts(formation);
      if (renderResult.errors.length > 0) {
        options.ui.error("agentify: greenfield structured artifacts failed deterministic rendering; scaffold was not installed.");
        for (const reason of renderResult.errors.slice(0, 8)) {
          options.ui.error(`agentify:   - ${reason}`);
        }
      } else {
        const stagingRoot = makeStagingRoot();
        options.ui.info(`agentify: staging greenfield bundle at ${stagingRoot}`);
        try {
          const metadata = new Map<string, ManagedManifestFile>();
          writeRenderedArtifactsToStaging(stagingRoot, renderResult.artifacts, metadata);
          const stagedValidation = validateGreenfieldArtifacts(stagingRoot);
          if (!stagedValidation.ok) {
            options.ui.error(
              "agentify: greenfield artifacts did not pass the substance gate; scaffold was not installed.",
            );
            for (const reason of stagedValidation.reasons.slice(0, 8)) {
              options.ui.error(`agentify:   - ${reason}`);
            }
            validationReported = true;
          } else {
            const scaffoldWrites = installScaffoldRuntime({
              cwd: stagingRoot,
              packageRoot: packageRoot(),
            });
            addWriteMetadata(stagingRoot, scaffoldWrites, "scaffold-installer", metadata);
            // Persist the pre-run snapshot for `agentify revert`.
            const runId = crypto.randomUUID();
            if (!options.dryRun) {
              const previousManifest = readManifestAt(options.cwd, stateDir);
              persistRunArtifacts({
                cwd: options.cwd,
                stateDir,
                runId,
                snapshot: artifactSnapshot as unknown as Record<string, { content: Buffer; mode: number; ownership: "managed" | "unmanaged" }>,
                previousManifest,
              });
            }
            const applyResult = applyStagedBundle({
              cwd: options.cwd,
              stagingRoot,
              snapshot: artifactSnapshot,
              metadata,
              agentifyVersion: loadAgentifyVersion(),
              mode: "greenfield",
              policy: resolveApplyPolicy(options.cwd, stateDir),
              runId,
              stateDir,
              dryRun: options.dryRun,
            });
            const conflicts = applyResult.writes.filter((write) => write.action === "conflict");
            scaffoldInstalled = applyResult.writes
              .filter((write) => write.action === "written")
              .filter((write) => {
                const rel = toRel(options.cwd, write.path);
                return rel === "SETUP.md" || rel.startsWith(".github/");
              })
              .length;
            scaffoldConflicts = conflicts.length;
            if (options.dryRun && options.jsonOutput && applyResult.manifest) {
              process.stdout.write(
                JSON.stringify(planToJson(applyResult, options.cwd), null, 2) + "\n",
              );
            } else {
              for (const line of formatApplyReport(applyResult.writes, options.cwd)) {
                options.ui.info(line);
              }
            }
            if (applyResult.requiredConflictCount > 0) {
              options.ui.error(
                "agentify: required greenfield generated file conflict(s) blocked apply; no bundle files were written.",
              );
              for (const conflict of conflicts.slice(0, 8)) {
                options.ui.error(`agentify:   - ${toRel(options.cwd, conflict.path)}: ${conflict.reason ?? "conflict"}`);
              }
            } else {
              const greenfieldState = writeGreenfieldStateAt(options.cwd, {
                turns: result.turns,
                costUsd: result.costUsd,
                aborted: result.aborted,
              }, stateDir);
              artifactsValid = greenfieldState.artifact_validation.ok;
              if (!artifactsValid) {
                options.ui.error(
                  "agentify: greenfield artifacts did not pass the substance gate after apply; scaffold readiness was blocked.",
                );
                for (const reason of greenfieldState.artifact_validation.reasons.slice(0, 8)) {
                  options.ui.error(`agentify:   - ${reason}`);
                }
                validationReported = true;
              }
            }
          }
        } finally {
          fs.rmSync(stagingRoot, { recursive: true, force: true });
          options.ui.info(`agentify: cleaned greenfield staging bundle at ${stagingRoot}`);
        }
      }
    }
    if (!artifactsValid) {
      const greenfieldState = writeGreenfieldStateAt(options.cwd, {
        turns: result.turns,
        costUsd: result.costUsd,
        aborted: result.aborted,
      }, stateDir);
      if (!validationReported && !greenfieldState.artifact_validation.ok) {
        options.ui.error("agentify: greenfield artifacts did not pass the substance gate; scaffold was not installed.");
        for (const reason of greenfieldState.artifact_validation.reasons.slice(0, 8)) {
          options.ui.error(`agentify:   - ${reason}`);
        }
      }
    }
  }
  const scaffoldSummary = result.aborted
    ? ")"
    : artifactsValid
      ? `, ${scaffoldInstalled} scaffold file(s) installed, ${scaffoldConflicts} conflict(s))`
      : ", scaffold not installed: artifact substance gate failed)";
  options.ui.info(
    `agentify: greenfield session complete (${result.turns} turn(s)` +
      `${result.costUsd === null ? "" : `, $${result.costUsd.toFixed(4)}`}` +
      `${scaffoldSummary}.`,
  );
  if (options.dryRun) {
    // Dry-run: skip project state write so the next run doesn't
    // see a stale "last run" record for a run that never actually
    // wrote anything.
    options.ui.info("agentify: dry-run complete; no files written, no project state recorded.");
  } else if (!result.aborted && artifactsValid) {
    reportGitHubReadiness(options);
    // Derive repoStatus from the actual filesystem signals so the
    // persisted state agrees with what the next run's detection sees
    // (a greenfield session that only installed scaffold, with no
    // GOALS.md / docs planning artifacts, is not "ready").
    const repoState = inspectAgentifyRepoState(options.cwd, defaultConfigDir());
    persistProjectState(options, {
      projectKind: "greenfield",
      runStatus: "success",
      repoMode: "greenfield",
      repoStatus: repoState.status,
      featureAgentCount: repoState.featureAgentCount,
      latestLogPath: null,
    });
  } else if (!result.aborted) {
    persistProjectState(options, {
      projectKind: "greenfield",
      runStatus: "partial",
      repoMode: "greenfield",
      repoStatus: "partial",
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
    ?? await ensureAgentifyConfig(defaultConfigDir(), options.ui);
  const classification = options.mode
    ? { kind: options.mode }
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
