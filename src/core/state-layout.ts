import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const LEGACY_PI_STATE_RELATIVE_DIR = ".pi/agentify";

export const KNOWN_STATE_RELATIVE_DIRS = [
  ".claude/agentify",
  ".agents/agentify",
  LEGACY_PI_STATE_RELATIVE_DIR,
] as const;

export type StateTreeStatus =
  | "absent"
  | "valid"
  | "partial"
  | "user_owned"
  | "permission_denied"
  | "unreadable"
  | "symlink_unsafe";

export interface StateTreeInspection {
  relativeDir: string;
  absoluteDir: string;
  status: StateTreeStatus;
  detail: string | null;
  fingerprint: string | null;
  ownershipEvidence: string[];
  manifestStateDir: string | null;
}

export type StateLayoutKind =
  | "empty"
  | "legacy_only"
  | "canonical_only"
  | "dual_identical"
  | "dual_divergent"
  | "partial"
  | "user_owned"
  | "permission_denied"
  | "unreadable"
  | "symlink_unsafe";

export interface StateLayoutClassification {
  kind: StateLayoutKind;
  selectedRelativeDir: string;
  sourceRelativeDir: string;
  fallback: boolean;
  legacy: StateTreeInspection;
  canonical: StateTreeInspection;
  otherProviderStateDirs: string[];
  blockingInspection: StateTreeInspection | null;
}

export interface DiscoveredStateDir {
  relativeDir: string;
  inspection: StateTreeInspection;
  duplicateLegacyDir: string | null;
}

export class StateLayoutError extends Error {
  readonly code: StateLayoutKind | "multiple_state_dirs";

  constructor(code: StateLayoutKind | "multiple_state_dirs", message: string) {
    super(message);
    this.name = "StateLayoutError";
    this.code = code;
  }
}

const PRIMARY_STATE_FILES = new Set([
  "manifest.json",
  "codebase_map.json",
  "greenfield-state.json",
  "greenfield-formation.json",
]);

const OWNERSHIP_ROOTS = new Set([
  ".agentify",
  "agents",
  "extensions",
  "history",
  "logs",
  "prompts",
  "runs",
  "skills",
  "workflows",
]);

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeRelativeDir(value: string): string {
  if (path.isAbsolute(value)) {
    throw new StateLayoutError("user_owned", `state path must be repository-relative: ${value}`);
  }
  const normalized = path.normalize(value);
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new StateLayoutError("user_owned", `state path escapes the repository: ${value}`);
  }
  return toPosix(normalized);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function failedInspection(
  relativeDir: string,
  absoluteDir: string,
  status: Extract<StateTreeStatus, "permission_denied" | "unreadable" | "symlink_unsafe" | "user_owned">,
  detail: string,
): StateTreeInspection {
  return {
    relativeDir,
    absoluteDir,
    status,
    detail,
    fingerprint: null,
    ownershipEvidence: [],
    manifestStateDir: null,
  };
}

function classifyFsError(
  relativeDir: string,
  absoluteDir: string,
  operation: string,
  error: unknown,
): StateTreeInspection {
  const code = errorCode(error);
  const detail = `${operation}: ${code ?? (error instanceof Error ? error.message : String(error))}`;
  return failedInspection(
    relativeDir,
    absoluteDir,
    code === "EACCES" || code === "EPERM" ? "permission_denied" : "unreadable",
    detail,
  );
}

function isOwnershipEvidence(relativePath: string): boolean {
  const normalized = toPosix(relativePath);
  if (PRIMARY_STATE_FILES.has(normalized)) return true;
  const first = normalized.split("/")[0];
  return first !== undefined && OWNERSHIP_ROOTS.has(first);
}

function parseJsonObject(content: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content.toString("utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function inspectStateTree(cwd: string, requestedRelativeDir: string): StateTreeInspection {
  const root = path.resolve(cwd);
  const relativeDir = normalizeRelativeDir(requestedRelativeDir);
  const absoluteDir = path.resolve(root, relativeDir);
  const rootRelative = path.relative(root, absoluteDir);
  if (rootRelative === "" || rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) {
    return failedInspection(relativeDir, absoluteDir, "user_owned", "path escapes repository root");
  }

  const segments = relativeDir.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return {
          relativeDir,
          absoluteDir,
          status: "absent",
          detail: null,
          fingerprint: null,
          ownershipEvidence: [],
          manifestStateDir: null,
        };
      }
      return classifyFsError(relativeDir, absoluteDir, `lstat ${toPosix(path.relative(root, current))}`, error);
    }
    if (stat.isSymbolicLink()) {
      return failedInspection(
        relativeDir,
        absoluteDir,
        "symlink_unsafe",
        `ancestor ${toPosix(path.relative(root, current))} is a symlink`,
      );
    }
    if (!stat.isDirectory()) {
      return failedInspection(
        relativeDir,
        absoluteDir,
        "user_owned",
        `${toPosix(path.relative(root, current))} is not a directory`,
      );
    }
  }

  const fingerprintEntries: string[] = [];
  const ownershipEvidence = new Set<string>();
  let manifestStateDir: string | null = null;
  let primaryFound = false;
  let malformedPrimary = false;
  let entryCount = 0;

  const walk = (directory: string, relativeBase: string): StateTreeInspection | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      return classifyFsError(relativeDir, absoluteDir, `readdir ${relativeBase || relativeDir}`, error);
    }

    for (const entry of entries) {
      entryCount += 1;
      const childAbsolute = path.join(directory, entry.name);
      const childRelative = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(childAbsolute);
      } catch (error) {
        return classifyFsError(relativeDir, absoluteDir, `lstat ${relativeDir}/${childRelative}`, error);
      }
      if (stat.isSymbolicLink()) {
        return failedInspection(
          relativeDir,
          absoluteDir,
          "symlink_unsafe",
          `${relativeDir}/${childRelative} is a symlink`,
        );
      }
      if (isOwnershipEvidence(childRelative)) ownershipEvidence.add(childRelative);
      if (stat.isDirectory()) {
        fingerprintEntries.push(`d|${childRelative}|${stat.mode & 0o777}`);
        const failure = walk(childAbsolute, childRelative);
        if (failure) return failure;
        continue;
      }
      if (!stat.isFile()) {
        return failedInspection(
          relativeDir,
          absoluteDir,
          "user_owned",
          `${relativeDir}/${childRelative} is not a regular file or directory`,
        );
      }
      let content: Buffer;
      try {
        content = fs.readFileSync(childAbsolute);
      } catch (error) {
        return classifyFsError(relativeDir, absoluteDir, `read ${relativeDir}/${childRelative}`, error);
      }
      const digest = crypto.createHash("sha256").update(content).digest("hex");
      fingerprintEntries.push(`f|${childRelative}|${stat.mode & 0o777}|${stat.size}|${digest}`);
      if (PRIMARY_STATE_FILES.has(childRelative)) {
        primaryFound = true;
        const parsed = parseJsonObject(content);
        if (!parsed) {
          malformedPrimary = true;
        } else if (childRelative === "manifest.json") {
          const value = parsed.state_dir;
          manifestStateDir = typeof value === "string" ? normalizeRelativeDir(value) : null;
        }
      }
    }
    return null;
  };

  const failure = walk(absoluteDir, "");
  if (failure) return failure;

  const fingerprint = crypto.createHash("sha256")
    .update(fingerprintEntries.join("\n"))
    .digest("hex");
  const evidence = [...ownershipEvidence].sort();
  if (entryCount === 0) {
    // An empty directory carries no recoverable Agentify state or ownership
    // evidence. Treat it exactly like an absent path so a leftover directory
    // never triggers migration guidance, a recovery prompt, or a warning.
    return {
      relativeDir,
      absoluteDir,
      status: "absent",
      detail: null,
      fingerprint: null,
      ownershipEvidence: [],
      manifestStateDir: null,
    };
  }
  if (evidence.length === 0) {
    return {
      relativeDir,
      absoluteDir,
      status: "user_owned",
      detail: "directory has no Agentify ownership evidence",
      fingerprint,
      ownershipEvidence: evidence,
      manifestStateDir,
    };
  }
  if (!primaryFound || malformedPrimary) {
    return {
      relativeDir,
      absoluteDir,
      status: "partial",
      detail: malformedPrimary
        ? "a primary state JSON file is malformed"
        : "Agentify ownership evidence exists without a primary state file",
      fingerprint,
      ownershipEvidence: evidence,
      manifestStateDir,
    };
  }
  return {
    relativeDir,
    absoluteDir,
    status: "valid",
    detail: null,
    fingerprint,
    ownershipEvidence: evidence,
    manifestStateDir,
  };
}

function occupied(inspection: StateTreeInspection): boolean {
  return inspection.status === "valid" || inspection.status === "partial";
}

function blockingKind(inspection: StateTreeInspection): StateLayoutKind | null {
  if (
    inspection.status === "user_owned" ||
    inspection.status === "permission_denied" ||
    inspection.status === "unreadable" ||
    inspection.status === "symlink_unsafe"
  ) {
    return inspection.status;
  }
  return null;
}

function firstBlockingInspection(inspections: StateTreeInspection[]): StateTreeInspection | null {
  const priority: StateTreeStatus[] = [
    "symlink_unsafe",
    "permission_denied",
    "unreadable",
    "user_owned",
  ];
  for (const status of priority) {
    const match = inspections
      .filter((inspection) => inspection.status === status)
      .sort((left, right) => left.relativeDir.localeCompare(right.relativeDir))[0];
    if (match) return match;
  }
  return null;
}

function inspectOtherProviderTrees(
  cwd: string,
  selectedRelativeDir: string,
  legacyActsAsFallback: boolean,
): { dirs: string[]; blocking: StateTreeInspection | null } {
  const inspections = KNOWN_STATE_RELATIVE_DIRS
    .filter((relativeDir) => relativeDir !== selectedRelativeDir)
    .filter((relativeDir) => relativeDir !== LEGACY_PI_STATE_RELATIVE_DIR || !legacyActsAsFallback)
    .map((relativeDir) => inspectStateTree(cwd, relativeDir));
  return {
    dirs: inspections.filter(occupied).map((inspection) => inspection.relativeDir).sort(),
    blocking: firstBlockingInspection(inspections),
  };
}

function classification(
  kind: StateLayoutKind,
  selectedRelativeDir: string,
  sourceRelativeDir: string,
  fallback: boolean,
  legacy: StateTreeInspection,
  canonical: StateTreeInspection,
  otherProviderStateDirs: string[],
  blockingInspection: StateTreeInspection | null,
): StateLayoutClassification {
  return {
    kind,
    selectedRelativeDir,
    sourceRelativeDir,
    fallback,
    legacy,
    canonical,
    otherProviderStateDirs,
    blockingInspection,
  };
}

export function classifyStateLayout(
  cwd: string,
  requestedSelectedRelativeDir: string,
): StateLayoutClassification {
  const selectedRelativeDir = normalizeRelativeDir(requestedSelectedRelativeDir);
  const canonical = inspectStateTree(cwd, selectedRelativeDir);
  const sameAsLegacy = selectedRelativeDir === LEGACY_PI_STATE_RELATIVE_DIR;
  const legacy = sameAsLegacy
    ? canonical
    : inspectStateTree(cwd, LEGACY_PI_STATE_RELATIVE_DIR);
  const legacyManifestMismatch = !sameAsLegacy
    && occupied(legacy)
    && legacy.manifestStateDir !== null
    && legacy.manifestStateDir !== LEGACY_PI_STATE_RELATIVE_DIR;
  const canonicalManifestMismatch = occupied(canonical)
    && canonical.manifestStateDir !== null
    && canonical.manifestStateDir !== selectedRelativeDir;
  const legacyIsPiCanonical = !sameAsLegacy
    && occupied(legacy)
    && legacy.manifestStateDir === LEGACY_PI_STATE_RELATIVE_DIR;
  const legacyActsAsFallback = !sameAsLegacy && !legacyIsPiCanonical;
  if (legacyManifestMismatch) {
    const mismatch: StateTreeInspection = {
      ...legacy,
      status: "user_owned",
      detail: `manifest state_dir ${legacy.manifestStateDir} does not match physical state directory ${LEGACY_PI_STATE_RELATIVE_DIR}`,
    };
    return classification(
      "user_owned",
      selectedRelativeDir,
      selectedRelativeDir,
      false,
      mismatch,
      canonical,
      [],
      mismatch,
    );
  }
  if (canonicalManifestMismatch) {
    const mismatch: StateTreeInspection = {
      ...canonical,
      status: "user_owned",
      detail: `manifest state_dir ${canonical.manifestStateDir} does not match physical state directory ${selectedRelativeDir}`,
    };
    return classification(
      "user_owned",
      selectedRelativeDir,
      selectedRelativeDir,
      false,
      legacy,
      mismatch,
      [],
      mismatch,
    );
  }
  const other = inspectOtherProviderTrees(cwd, selectedRelativeDir, legacyActsAsFallback);
  const blocking = firstBlockingInspection(sameAsLegacy ? [canonical] : [legacy, canonical])
    ?? other.blocking;
  if (blocking) {
    const kind = blockingKind(blocking);
    if (!kind) throw new Error("blocking state inspection lacked a blocking kind");
    return classification(
      kind,
      selectedRelativeDir,
      selectedRelativeDir,
      false,
      legacy,
      canonical,
      other.dirs,
      blocking,
    );
  }

  if (sameAsLegacy) {
    const kind: StateLayoutKind = canonical.status === "absent"
      ? "empty"
      : canonical.status === "partial"
        ? "partial"
        : "canonical_only";
    return classification(
      kind,
      selectedRelativeDir,
      selectedRelativeDir,
      false,
      legacy,
      canonical,
      other.dirs,
      null,
    );
  }

  const legacyOccupied = legacyActsAsFallback && occupied(legacy);
  const canonicalOccupied = occupied(canonical);
  if (!legacyOccupied && !canonicalOccupied) {
    return classification(
      "empty",
      selectedRelativeDir,
      selectedRelativeDir,
      false,
      legacy,
      canonical,
      other.dirs,
      null,
    );
  }
  if (legacyOccupied && canonicalOccupied) {
    if (canonical.manifestStateDir === selectedRelativeDir) {
      return classification(
        "canonical_only",
        selectedRelativeDir,
        selectedRelativeDir,
        false,
        legacy,
        canonical,
        other.dirs,
        null,
      );
    }
    const identical = legacy.fingerprint !== null && legacy.fingerprint === canonical.fingerprint;
    return classification(
      identical ? "dual_identical" : "dual_divergent",
      selectedRelativeDir,
      selectedRelativeDir,
      false,
      legacy,
      canonical,
      other.dirs,
      null,
    );
  }
  if (legacyOccupied) {
    return classification(
      legacy.status === "partial" ? "partial" : "legacy_only",
      selectedRelativeDir,
      LEGACY_PI_STATE_RELATIVE_DIR,
      true,
      legacy,
      canonical,
      other.dirs,
      null,
    );
  }
  return classification(
    canonical.status === "partial" ? "partial" : "canonical_only",
    selectedRelativeDir,
    selectedRelativeDir,
    false,
    legacy,
    canonical,
    other.dirs,
    null,
  );
}

export function assertStateLayoutUsable(layout: StateLayoutClassification): void {
  if (layout.kind === "dual_divergent") {
    throw new StateLayoutError(
      layout.kind,
      `conflicting state trees found at ${LEGACY_PI_STATE_RELATIVE_DIR} and ${layout.selectedRelativeDir}; no files were changed. Move or archive one tree, then rerun.`,
    );
  }
  if (layout.blockingInspection) {
    const kind = blockingKind(layout.blockingInspection);
    if (!kind) throw new Error("blocking state inspection lacked a blocking kind");
    throw new StateLayoutError(
      kind,
      `unsafe state path ${layout.blockingInspection.relativeDir}: ${layout.blockingInspection.detail ?? kind.replaceAll("_", " ")}; no files were changed.`,
    );
  }
}

export function formatStateLayoutGuidance(layout: StateLayoutClassification): string[] {
  const messages: string[] = [];
  if (layout.fallback) {
    messages.push(
      `agentify: legacy state detected at ${LEGACY_PI_STATE_RELATIVE_DIR}; selected state directory is ${layout.selectedRelativeDir}. Migration is required before canonical writes.`,
    );
  } else if (layout.kind === "dual_identical") {
    messages.push(
      `agentify: canonical and legacy state are identical; using ${layout.selectedRelativeDir} and retaining ${LEGACY_PI_STATE_RELATIVE_DIR}.`,
    );
  } else if (
    layout.kind === "canonical_only"
    && layout.legacy.status === "valid"
    && layout.canonical.manifestStateDir === layout.selectedRelativeDir
  ) {
    messages.push(
      `agentify: using explicit canonical state at ${layout.selectedRelativeDir}; retained legacy state remains at ${LEGACY_PI_STATE_RELATIVE_DIR}.`,
    );
  } else if (layout.kind === "partial") {
    const inspection = layout.sourceRelativeDir === LEGACY_PI_STATE_RELATIVE_DIR
      ? layout.legacy
      : layout.canonical;
    messages.push(
      `agentify: partial state detected at ${layout.sourceRelativeDir}: ${inspection.detail ?? "incomplete state"}. Compatibility behavior remains active; no state was moved or deleted.`,
    );
  }
  if (layout.otherProviderStateDirs.length > 0) {
    messages.push(
      `agentify: existing state at ${layout.otherProviderStateDirs.join(", ")} belongs to a different provider; selected state directory is ${layout.selectedRelativeDir}. No fallback was attempted and no state was moved or deleted.`,
    );
  }
  return messages;
}

export function discoverExistingStateDir(cwd: string): DiscoveredStateDir | null {
  const inspections = KNOWN_STATE_RELATIVE_DIRS.map((relativeDir) => inspectStateTree(cwd, relativeDir));
  const blocking = firstBlockingInspection(inspections);
  if (blocking) {
    const kind = blockingKind(blocking);
    if (!kind) throw new Error("blocking state inspection lacked a blocking kind");
    throw new StateLayoutError(
      kind,
      `unsafe state path ${blocking.relativeDir}: ${blocking.detail ?? kind.replaceAll("_", " ")}; no files were changed.`,
    );
  }
  const occupiedInspections = inspections.filter(occupied);
  if (occupiedInspections.length === 0) return null;
  if (occupiedInspections.length === 1) {
    return {
      relativeDir: occupiedInspections[0]!.relativeDir,
      inspection: occupiedInspections[0]!,
      duplicateLegacyDir: null,
    };
  }

  const fingerprints = new Set(occupiedInspections.map((inspection) => inspection.fingerprint));
  const canonicalInspections = occupiedInspections.filter(
    (inspection) => inspection.relativeDir !== LEGACY_PI_STATE_RELATIVE_DIR,
  );
  const legacyInspection = occupiedInspections.find(
    (inspection) => inspection.relativeDir === LEGACY_PI_STATE_RELATIVE_DIR,
  );
  if (
    canonicalInspections.length === 1 &&
    legacyInspection !== undefined &&
    (
      fingerprints.size === 1
      || canonicalInspections[0]!.manifestStateDir === canonicalInspections[0]!.relativeDir
    )
  ) {
    return {
      relativeDir: canonicalInspections[0]!.relativeDir,
      inspection: canonicalInspections[0]!,
      duplicateLegacyDir: LEGACY_PI_STATE_RELATIVE_DIR,
    };
  }

  throw new StateLayoutError(
    "multiple_state_dirs",
    `multiple Agentify state directories require explicit resolution: ${occupiedInspections.map((inspection) => inspection.relativeDir).sort().join(", ")}; no files were changed.`,
  );
}
