import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTIFY_MANAGED_MARKERS } from "./artifact-exporters.ts";
import type { AgentifyRepoMode } from "./repo-status.ts";
import type { ManagedArtifactKind } from "./artifacts/renderers.ts";

export const MANIFEST_RELATIVE_PATH = ".pi/agentify/manifest.json";
export const CODEBASE_MAP_RELATIVE_PATH = ".pi/agentify/codebase_map.json";

export const REQUIRED_BROWNFIELD_FILES = [
  "AGENTS.md",
  "specs/README.md",
  "ai_docs/README.md",
  CODEBASE_MAP_RELATIVE_PATH,
  "SETUP.md",
  ".github/workflows/agent-implement.yml",
  ".github/actions/run-pi/action.yml",
  ".github/scripts/setup-agentify.sh",
] as const;

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
}

export interface ManagedManifest {
  schema_version: "1";
  agentify_version: string;
  generated_at: string;
  mode: Exclude<AgentifyRepoMode, "unknown">;
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
}

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function manifestPath(cwd: string): string {
  return path.join(cwd, MANIFEST_RELATIVE_PATH);
}

export function markerForPath(relativePath: string): string {
  const normalized = normalizePath(relativePath);
  if (normalized.endsWith(".md")) return AGENTIFY_MANAGED_MARKERS.markdown;
  if (normalized.endsWith(".json")) return "sha256";
  return AGENTIFY_MANAGED_MARKERS.toml;
}

export function kindForPath(relativePath: string): ManagedArtifactKind {
  const normalized = normalizePath(relativePath);
  if (normalized.startsWith(".agents/") || normalized.startsWith(".claude/")) return "skill";
  if (normalized.startsWith(".codex/") || normalized === "CLAUDE.md") return "harness_export";
  if (normalized.startsWith(".github/") || normalized === "SETUP.md") return "scaffold";
  if (normalized.startsWith(".pi/prompts/experts/")) return "expert";
  if (normalized.startsWith(".pi/prompts/")) return "prompt";
  if (normalized.startsWith(".pi/workflows/")) return "workflow";
  if (normalized.startsWith(".pi/extensions/")) return "extension";
  if (normalized.startsWith(".pi/agentify/")) return "state";
  return "audit";
}

export function isRequiredManagedPath(relativePath: string, mode: Exclude<AgentifyRepoMode, "unknown">): boolean {
  const normalized = normalizePath(relativePath);
  const required = mode === "greenfield" ? REQUIRED_GREENFIELD_FILES : REQUIRED_BROWNFIELD_FILES;
  return required.includes(normalized as never);
}

export function manifestFileFromContent(
  input: ManifestFileInput,
  mode: Exclude<AgentifyRepoMode, "unknown"> = "brownfield",
): ManagedManifestFile {
  const relativePath = normalizePath(input.relativePath);
  return {
    path: relativePath,
    kind: input.kind ?? kindForPath(relativePath),
    required: input.required ?? isRequiredManagedPath(relativePath, mode),
    marker: input.marker ?? markerForPath(relativePath),
    sha256: sha256(input.content),
    source: input.source ?? "managed-bundle",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManifestFile(value: unknown): value is ManagedManifestFile {
  if (!isRecord(value)) return false;
  return typeof value.path === "string"
    && typeof value.kind === "string"
    && typeof value.required === "boolean"
    && typeof value.marker === "string"
    && typeof value.sha256 === "string"
    && typeof value.source === "string";
}

function isManifest(value: unknown): value is ManagedManifest {
  if (!isRecord(value)) return false;
  return value.schema_version === "1"
    && typeof value.agentify_version === "string"
    && typeof value.generated_at === "string"
    && (value.mode === "brownfield" || value.mode === "greenfield")
    && Array.isArray(value.files)
    && value.files.every(isManifestFile);
}

export function readManifest(cwd: string): ManagedManifest | null {
  const filePath = manifestPath(cwd);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeManifest(cwd: string, manifest: ManagedManifest): void {
  const filePath = manifestPath(cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
}

function fileCarriesMarker(content: string, marker: string): boolean {
  return marker === "sha256" || content.includes(marker);
}

export function verifyManifest(cwd: string): ManifestVerification {
  const manifest = readManifest(cwd);
  if (!manifest) {
    return {
      manifest: null,
      valid: false,
      mode: "unknown",
      found: [],
      missing: [],
      mismatched: [],
      unmanaged: [],
    };
  }

  const found: string[] = [];
  const missing: string[] = [];
  const mismatched: string[] = [];
  const unmanaged: string[] = [];

  for (const file of manifest.files) {
    if (!file.required) continue;
    const filePath = path.join(cwd, file.path);
    if (!fs.existsSync(filePath)) {
      missing.push(file.path);
      continue;
    }
    const content = fs.readFileSync(filePath);
    const text = content.toString("utf-8");
    found.push(file.path);
    if (!fileCarriesMarker(text, file.marker)) {
      unmanaged.push(file.path);
      continue;
    }
    if (sha256(content) !== file.sha256) {
      mismatched.push(file.path);
    }
  }

  return {
    manifest,
    valid: missing.length === 0 && mismatched.length === 0 && unmanaged.length === 0,
    mode: manifest.mode,
    found,
    missing,
    mismatched,
    unmanaged,
  };
}
