import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeArtifactPath } from "./artifacts/generated-surface.ts";
import { markerForArtifactPath } from "./artifacts/managed-markers.ts";
import type { AgentifyRepoMode } from "./repo-status.ts";
import type { ManagedArtifactKind } from "./artifacts/renderers.ts";

/**
 * Posix-style relative path of the canonical codebase map under the
 * supplied agentify state dir. The audit now derives its state dir
 * from the user's selected targets, so this is a function rather
 * than a constant.
 */
export function codebaseMapRelativePath(stateDir: string): string {
  return path.join(stateDir, "codebase_map.json");
}

/** Posix-style relative path of the managed manifest under the
 * supplied state dir. */
export function manifestRelativePath(stateDir: string): string {
  return path.join(stateDir, "manifest.json");
}

/**
 * Required brownfield files for an audit that resolves to
 * `<stateDir>/...`. The canonical map path is computed from
 * `stateDir` rather than the legacy `.pi/agentify/` constant.
 */
export function requiredBrownfieldFiles(stateDir: string): readonly string[] {
  return [
    "AGENTS.md",
    "specs/README.md",
    "ai_docs/README.md",
    codebaseMapRelativePath(stateDir),
    "SETUP.md",
    ".github/workflows/agent-implement.yml",
    ".github/actions/run-pi/action.yml",
    ".github/scripts/setup-agentify.sh",
  ];
}

export const REQUIRED_GREENFIELD_FILES = [
  "GOALS.md",
  "CONTEXT.md",
  "SETUP.md",
  ".github/workflows/agent-implement.yml",
  ".github/actions/run-pi/action.yml",
  ".github/scripts/setup-agentify.sh",
] as const;

export interface ManagedManifestFile {
  path: string;
  kind: ManagedArtifactKind;
  required: boolean;
  marker: string;
  sha256: string;
  source: string;
  /**
   * v2: set when the canonical file at `path` was left untouched
   * (the user owns it) and agentify's version was saved to this
   * sibling path. Naming is deterministic — see
   * `alongsidePathFor` in `apply-policy.ts`. The presence of
   * `alongsidePath` is what tells `verifyManifest` and `revert`
   * that the user's file is the canonical one.
   */
  alongsidePath?: string;
  /**
   * v2: sha256 of the user's pre-existing file content, captured
   * when the file was preserved (alongside or kept-without-save).
   * Lets `revert` confirm what the user had at the start of the
   * run even if they've since edited the file.
   */
  preservedSha256?: string;
}

export interface ManagedManifest {
  /** v1 = legacy, pre-alongside. v2 = current. `verifyManifest`
   *  accepts both; `revert` requires v2 (must carry `run_id`). */
  schema_version: "1" | "2";
  agentify_version: string;
  generated_at: string;
  mode: Exclude<AgentifyRepoMode, "unknown">;
  /**
   * Provider-scoped state directory (relative, no trailing slash)
   * recorded at apply time. New manifests always carry this;
   * installed-upgrade manifests may omit it. Callers still supply the
   * physical state directory explicitly to the compatibility reader.
   */
  state_dir?: string;
  /**
   * v2: stable id (uuid) for the run that produced this manifest.
   * `revert` reads the snapshot at
   * `<stateDir>/runs/<run_id>/snapshot.json` to know what to
   * restore. Absent on v1 manifests; those are not revertable.
   */
  run_id?: string;
  files: ManagedManifestFile[];
}

export interface ManifestVerification {
  manifest: ManagedManifest | null;
  valid: boolean;
  mode: AgentifyRepoMode;
  found: string[];
  missing: string[];
  mismatched: string[];
  unmanaged: string[];
}

export interface ManifestFileInput {
  relativePath: string;
  content: string | Buffer;
  kind?: ManagedArtifactKind;
  required?: boolean;
  marker?: string;
  source?: string;
  /** v2: alongside path (see `alongsidePathFor`). */
  alongsidePath?: string;
  /** v2: sha256 of the user's pre-existing file. */
  preservedSha256?: string;
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Absolute path of the managed manifest at the supplied state dir.
 *  Use this from any site that knows the resolved state dir. */
export function manifestPathFor(cwd: string, stateDir: string): string {
  return path.join(cwd, manifestRelativePath(stateDir));
}

/** Absolute path of the canonical codebase map at the supplied
 *  state dir. */
export function codebaseMapPathFor(cwd: string, stateDir: string): string {
  return path.join(cwd, codebaseMapRelativePath(stateDir));
}

export function markerForPath(relativePath: string): string {
  return markerForArtifactPath(relativePath);
}

/**
 * Classify a managed file based on the active state dir. The
 * state-dir prefix (`<stateDir>/prompts/experts`,
 * `<stateDir>/prompts`, `<stateDir>/workflows`,
 * `<stateDir>/extensions`, `<stateDir>` itself) replaces the
 * historical `.pi/` literal at the corresponding positions.
 *
 * `<stateDir>/agents/*.md` (feature-agent scratch) falls through to
 * `audit` for the same reason `.pi/agents/*.md` does in the legacy
 * classifier (no slot in the 9-kind taxonomy matches; `audit`
 * serves as the catch-all for repo-level brownfield files).
 *
 * Per-harness skill/harness_export/scaffold classification is
 * unchanged — those dotdirs are independent of the audit's state
 * dir.
 */
export function dynamicKindForPath(relativePath: string, stateDir: string): ManagedArtifactKind {
  const normalized = normalizeArtifactPath(relativePath);
  const normalizedStateDir = normalizeArtifactPath(stateDir);
  const statePrefix = normalizedStateDir.endsWith("/") ? normalizedStateDir : `${normalizedStateDir}/`;
  if (normalized.startsWith(`${statePrefix}prompts/experts/`)) return "expert";
  if (normalized.startsWith(`${statePrefix}prompts/`)) return "prompt";
  if (normalized.startsWith(`${statePrefix}workflows/`)) return "workflow";
  if (normalized.startsWith(`${statePrefix}extensions/`)) return "extension";
  if (normalized.startsWith(statePrefix)) return "state";
  if (normalized.startsWith(".agents/") || normalized.startsWith(".claude/") || normalized.startsWith(".pi/skills/")) return "skill";
  if (normalized.startsWith(".codex/") || normalized === "CLAUDE.md") return "harness_export";
  if (normalized.startsWith(".github/") || normalized === "SETUP.md") return "scaffold";
  if (normalized.startsWith(".pi/prompts/experts/")) return "expert";
  if (normalized.startsWith(".pi/prompts/")) return "prompt";
  if (normalized.startsWith(".pi/workflows/")) return "workflow";
  if (normalized.startsWith(".pi/extensions/")) return "extension";
  return "audit";
}

/**
 * Required-path check that honors the supplied state dir. Replaces
 * the literal `.pi/agentify/codebase_map.json` member of
 * `REQUIRED_BROWNFIELD_FILES` with the dynamic
 * `<stateDir>/codebase_map.json` path. The brownfield scaffold
 * entries (`.github/*`, `SETUP.md`, `AGENTS.md`, …) are still
 * relative to the repo root and do not depend on the state dir.
 */
export function isRequiredManagedPathFor(
  relativePath: string,
  mode: Exclude<AgentifyRepoMode, "unknown">,
  stateDir: string,
): boolean {
  if (mode === "greenfield") {
    return REQUIRED_GREENFIELD_FILES.includes(normalizeArtifactPath(relativePath) as never);
  }
  return requiredBrownfieldFiles(stateDir).includes(normalizeArtifactPath(relativePath));
}

export function manifestFileFromContent(
  input: ManifestFileInput,
  mode: Exclude<AgentifyRepoMode, "unknown">,
  stateDir: string,
): ManagedManifestFile {
  const relativePath = normalizeArtifactPath(input.relativePath);
  const kind = input.kind ?? dynamicKindForPath(relativePath, stateDir);
  const required = input.required ?? isRequiredManagedPathFor(relativePath, mode, stateDir);
  return {
    path: relativePath,
    kind,
    required,
    marker: input.marker ?? markerForPath(relativePath),
    sha256: sha256(input.content),
    source: input.source ?? "managed-bundle",
    alongsidePath: input.alongsidePath,
    preservedSha256: input.preservedSha256,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManifestFile(value: unknown): value is ManagedManifestFile {
  if (!isRecord(value)) return false;
  const baseShape = typeof value.path === "string"
    && typeof value.kind === "string"
    && typeof value.required === "boolean"
    && typeof value.marker === "string"
    && typeof value.sha256 === "string"
    && typeof value.source === "string";
  if (!baseShape) return false;
  // v2 optional fields — silently drop unknown values during read.
  if (value.alongsidePath !== undefined && typeof value.alongsidePath !== "string") return false;
  if (value.preservedSha256 !== undefined && typeof value.preservedSha256 !== "string") return false;
  return true;
}

function isManifest(value: unknown): value is ManagedManifest {
  if (!isRecord(value)) return false;
  return (value.schema_version === "1" || value.schema_version === "2")
    && typeof value.agentify_version === "string"
    && typeof value.generated_at === "string"
    && (value.mode === "brownfield" || value.mode === "greenfield")
    // state_dir is optional. Absence means a legacy manifest
    // accepted for installed-upgrade compatibility. The physical reader path
    // remains explicit even when the recorded state directory is absent.
    && (value.state_dir === undefined || typeof value.state_dir === "string")
    // run_id is v2-only. Absent on v1 manifests (which are not
    // revertable but otherwise readable).
    && (value.run_id === undefined || typeof value.run_id === "string")
    && Array.isArray(value.files)
    && value.files.every(isManifestFile);
}

/**
 * Read the managed manifest at `<stateDir>/manifest.json`. New
 * The physical state directory is always explicit.
 */
export function readManifestAt(cwd: string, stateDir: string): ManagedManifest | null {
  const filePath = manifestPathFor(cwd, stateDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write the managed manifest at `<stateDir>/manifest.json` and
 * record the state dir on the manifest so the scaffold scripts
 * can discover it without a shell-side probe.
 */
export function writeManifestAt(
  cwd: string,
  manifest: ManagedManifest,
  stateDir: string,
): void {
  const stamped: ManagedManifest = {
    ...manifest,
    state_dir: stateDir,
  };
  const filePath = manifestPathFor(cwd, stateDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(stamped, null, 2)}\n`, { mode: 0o644 });
}
