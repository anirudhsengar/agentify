import * as fs from "node:fs";
import * as path from "node:path";
import {
  TEAM_MEMORY_MAX_MANIFEST_ENTRIES,
  TeamMemoryManifestSchema,
  type TeamMemoryActivation,
  type TeamMemoryCanonicalMap,
  type TeamMemoryManifest,
  type TeamMemoryManifestEntry,
} from "../schema.ts";
import {
  TEAM_MEMORY_CANONICAL_MAP_RELATIVE,
  TEAM_MEMORY_IGNORE_RELATIVE,
  TEAM_MEMORY_INSTALLATION_REPORT_RELATIVE,
  TEAM_MEMORY_MANIFEST_RELATIVE,
  isTeamMemoryVisiblePath,
  normalizeMemoryRepositoryPath,
  validateMemoryId,
} from "../paths.ts";
import { canonicalJson, sha256Hex } from "../serialization.ts";
import { TeamMemoryError, type MemoryStoreOptions } from "../contracts.ts";
import { nowIso, validateSchema } from "../validation.ts";
import {
  MAX_ENTITY_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_VISIBLE_BYTES,
  TEAM_IGNORE_CONTENT,
  assertEntitySize,
  errorCode,
  readRelativeJson,
  repositoryRoot,
  resolveExistingSafeDirectory,
  resolveExistingSafeFile,
  writeJsonAtomic,
} from "./files.ts";
import {
  hasRecognizedManifestMarker,
} from "./initialization.ts";

export function directoryEntriesIfPresent(cwd: string, relativeDirectory: string): fs.Dirent[] {
  let absolute: string;
  try {
    absolute = resolveExistingSafeDirectory(cwd, relativeDirectory);
  } catch (error) {
    if (error instanceof TeamMemoryError && error.code === "not_found") return [];
    throw error;
  }
  return fs.readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function assertJsonLeafDirectory(cwd: string, relativeDirectory: string): void {
  for (const entry of directoryEntriesIfPresent(cwd, relativeDirectory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new TeamMemoryError(
        "unsafe_path",
        `${relativeDirectory} contains unsupported entry ${entry.name}`,
      );
    }
    resolveExistingSafeFile(cwd, `${relativeDirectory}/${entry.name}`);
  }
}

export function assertVisibleLayout(cwd: string): void {
  const agentsAllowed = new Set(["orchestrator.json", "roles", "specialists"]);
  for (const entry of directoryEntriesIfPresent(cwd, ".agentify/agents")) {
    if (!agentsAllowed.has(entry.name)) {
      throw new TeamMemoryError("unsafe_path", `.agentify/agents contains unsupported entry ${entry.name}`);
    }
    if (entry.name === "orchestrator.json" ? !entry.isFile() : !entry.isDirectory()) {
      throw new TeamMemoryError("unsafe_path", `.agentify/agents/${entry.name} has the wrong entry type`);
    }
  }
  assertJsonLeafDirectory(cwd, ".agentify/agents/roles");
  assertJsonLeafDirectory(cwd, ".agentify/agents/specialists");

  const knowledgeAllowed = new Set([
    "codebase", "procedures", "episodes", "specialists", "orchestrator",
  ]);
  for (const entry of directoryEntriesIfPresent(cwd, ".agentify/knowledge")) {
    if (!knowledgeAllowed.has(entry.name) || !entry.isDirectory()) {
      throw new TeamMemoryError(
        "unsafe_path",
        `.agentify/knowledge contains unsupported entry ${entry.name}`,
      );
    }
  }
  for (const directory of knowledgeAllowed) {
    assertJsonLeafDirectory(cwd, `.agentify/knowledge/${directory}`);
  }
  assertJsonLeafDirectory(cwd, ".agentify/policies");

  const historyAllowed = new Set(["agents", "memory", "candidates"]);
  for (const entry of directoryEntriesIfPresent(cwd, ".agentify/history")) {
    if (!historyAllowed.has(entry.name) || !entry.isDirectory()) {
      throw new TeamMemoryError(
        "unsafe_path",
        `.agentify/history contains unsupported entry ${entry.name}`,
      );
    }
  }
  assertJsonLeafDirectory(cwd, ".agentify/history/candidates");
  for (const entityType of ["agents", "memory"] as const) {
    const base = `.agentify/history/${entityType}`;
    for (const entity of directoryEntriesIfPresent(cwd, base)) {
      if (!entity.isDirectory()) {
        throw new TeamMemoryError("unsafe_path", `${base}/${entity.name} must be a directory`);
      }
      validateMemoryId(entity.name, "history entity ID");
      for (const event of directoryEntriesIfPresent(cwd, `${base}/${entity.name}`)) {
        if (!event.isFile() || !/^\d{12}\.json$/.test(event.name)) {
          throw new TeamMemoryError(
            "unsafe_path",
            `${base}/${entity.name} contains invalid event ${event.name}`,
          );
        }
        resolveExistingSafeFile(cwd, `${base}/${entity.name}/${event.name}`);
      }
    }
  }

  try {
    const ignore = fs.readFileSync(resolveExistingSafeFile(cwd, TEAM_MEMORY_IGNORE_RELATIVE), "utf-8");
    if (ignore !== TEAM_IGNORE_CONTENT) {
      throw new TeamMemoryError(
        "corrupt_state",
        `${TEAM_MEMORY_IGNORE_RELATIVE} does not contain the canonical operational-state exclusions`,
      );
    }
  } catch (error) {
    if (!(error instanceof TeamMemoryError) || error.code !== "not_found") throw error;
  }
}

export function manifestEntryKind(relativePath: string): TeamMemoryManifestEntry["kind"] {
  if (relativePath === TEAM_MEMORY_IGNORE_RELATIVE) return "ignore_rules";
  if (relativePath.startsWith(".agentify/agents/")) return "agent_identity";
  if (relativePath.startsWith(".agentify/history/candidates/")) return "candidate_decision";
  if (relativePath.startsWith(".agentify/history/")) return "history_event";
  return "memory_record";
}

export function walkVisibleDirectory(
  cwd: string,
  relativeDirectory: string,
  entries: TeamMemoryManifestEntry[],
  totals: { bytes: number },
): void {
  const root = repositoryRoot(cwd);
  const normalized = normalizeMemoryRepositoryPath(relativeDirectory);
  const absolute = path.join(root, ...normalized.split("/"));
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new TeamMemoryError("corrupt_state", `cannot list ${normalized}`, { cause: error });
  }
  for (const child of children) {
    const childRelative = `${normalized}/${child.name}`;
    const childAbsolute = path.join(absolute, child.name);
    const stat = fs.lstatSync(childAbsolute);
    if (stat.isSymbolicLink()) {
      throw new TeamMemoryError("unsafe_path", `team memory cannot contain symlink ${childRelative}`);
    }
    if (stat.isDirectory()) {
      walkVisibleDirectory(cwd, childRelative, entries, totals);
      continue;
    }
    if (!stat.isFile()) {
      throw new TeamMemoryError("unsafe_path", `team memory contains unsupported entry ${childRelative}`);
    }
    if (!child.name.endsWith(".json")) {
      throw new TeamMemoryError("unsafe_path", `team memory visible directory contains non-JSON file ${childRelative}`);
    }
    if (stat.size > MAX_ENTITY_BYTES) {
      throw new TeamMemoryError("capacity_exceeded", `${childRelative} exceeds the durable entity limit`);
    }
    totals.bytes += stat.size;
    if (totals.bytes > MAX_VISIBLE_BYTES) {
      throw new TeamMemoryError("capacity_exceeded", "team memory visible state exceeds the 64 MiB limit");
    }
    entries.push({
      path: childRelative,
      kind: manifestEntryKind(childRelative),
      sha256: sha256Hex(fs.readFileSync(childAbsolute)),
      bytes: stat.size,
    });
  }
}

export function scanVisibleEntries(cwd: string): TeamMemoryManifestEntry[] {
  assertVisibleLayout(cwd);
  const entries: TeamMemoryManifestEntry[] = [];
  const totals = { bytes: 0 };
  const ignorePath = path.join(repositoryRoot(cwd), TEAM_MEMORY_IGNORE_RELATIVE);
  try {
    const stat = fs.lstatSync(ignorePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TeamMemoryError("unsafe_path", `${TEAM_MEMORY_IGNORE_RELATIVE} must be a regular file`);
    }
    const content = fs.readFileSync(ignorePath);
    totals.bytes += content.byteLength;
    entries.push({
      path: TEAM_MEMORY_IGNORE_RELATIVE,
      kind: "ignore_rules",
      sha256: sha256Hex(content),
      bytes: content.byteLength,
    });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  for (const directory of [
    ".agentify/agents",
    ".agentify/knowledge",
    ".agentify/policies",
    ".agentify/history",
  ]) {
    walkVisibleDirectory(cwd, directory, entries, totals);
  }
  if (entries.length > TEAM_MEMORY_MAX_MANIFEST_ENTRIES) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `team memory contains more than ${TEAM_MEMORY_MAX_MANIFEST_ENTRIES} durable files`,
    );
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export interface VisibleWriteProjection {
  relativePath: string;
  value: unknown;
}

function projectedVisibleContent(value: unknown, label: string): Buffer {
  return Buffer.from(assertEntitySize(value, label), "utf-8");
}

/**
 * Fail before an immutable event is committed when the resulting durable tree
 * or its manifest would exceed the bounded retention contract.
 */
export function assertVisibleWriteCapacity(
  cwd: string,
  writes: ReadonlyArray<VisibleWriteProjection>,
): void {
  const projected = new Map(
    scanVisibleEntries(cwd).map((entry) => [entry.path, entry] as const),
  );
  for (const write of writes) {
    const relativePath = normalizeMemoryRepositoryPath(write.relativePath, "projected memory path");
    if (!isTeamMemoryVisiblePath(relativePath) || relativePath === TEAM_MEMORY_MANIFEST_RELATIVE) {
      throw new TeamMemoryError(
        "policy_violation",
        `capacity projection is outside durable team memory: ${relativePath}`,
      );
    }
    const content = projectedVisibleContent(write.value, relativePath);
    projected.set(relativePath, {
      path: relativePath,
      kind: manifestEntryKind(relativePath),
      sha256: sha256Hex(content),
      bytes: content.byteLength,
    });
  }

  const entries = [...projected.values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length > TEAM_MEMORY_MAX_MANIFEST_ENTRIES) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `memory mutation would exceed ${TEAM_MEMORY_MAX_MANIFEST_ENTRIES} durable files`,
    );
  }
  const totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  if (totalBytes > MAX_VISIBLE_BYTES) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      "memory mutation would exceed the 64 MiB durable-state limit",
    );
  }

  const currentManifest = readManifestIfPresent(cwd);
  if (currentManifest !== null) {
    const projectedManifest: TeamMemoryManifest = {
      ...currentManifest,
      revision: currentManifest.revision + 1,
      entries,
      root_digest: manifestRootDigest(
        entries,
        currentManifest.canonical_map,
        currentManifest.installation_report,
      ),
    };
    assertEntitySize(
      projectedManifest,
      TEAM_MEMORY_MANIFEST_RELATIVE,
      MAX_MANIFEST_BYTES,
    );
  }
}

/**
 * Digest of the durable memory surface. The canonical audit map participates
 * when it is recorded, so specialist routing and learning cannot be re-pointed
 * at a different map without invalidating the manifest. Manifests written
 * before the map was covered omit it and hash exactly as they did.
 */
export function manifestRootDigest(
  entries: ReadonlyArray<TeamMemoryManifestEntry>,
  canonicalMap?: TeamMemoryCanonicalMap | null,
  installationReport?: TeamMemoryCanonicalMap | null,
  activation?: TeamMemoryActivation | null,
): string {
  const surface = entries.map((entry) =>
    `${entry.path}\0${entry.kind}\0${entry.sha256}\0${entry.bytes}`
  ).join("\n");
  const attached = (label: string, record: TeamMemoryCanonicalMap | null | undefined): string =>
    record ? `\n\0${label}\0${record.path}\0${record.sha256}\0${record.bytes}` : "";
  return sha256Hex(
    surface
    + attached("canonical_map", canonicalMap)
    + attached("installation_report", installationReport)
    + (activation
      ? `\n\0activation\0${activation.state}\0${activation.disposition}\0${activation.promoted_at ?? ""}`
      : ""),
  );
}

/** Integrity record for the committed installation report, or null when absent. */
export function installationReportIntegrity(cwd: string): TeamMemoryCanonicalMap | null {
  return fileIntegrity(cwd, TEAM_MEMORY_INSTALLATION_REPORT_RELATIVE);
}

/** Integrity record for the canonical audit map, or null when it is absent. */
export function canonicalMapIntegrity(cwd: string): TeamMemoryCanonicalMap | null {
  return fileIntegrity(cwd, TEAM_MEMORY_CANONICAL_MAP_RELATIVE);
}

function fileIntegrity(cwd: string, relativePath: string): TeamMemoryCanonicalMap | null {
  const absolute = path.join(repositoryRoot(cwd), ...relativePath.split("/"));
  let content: Buffer;
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    content = fs.readFileSync(absolute);
  } catch {
    return null;
  }
  return { path: relativePath, sha256: sha256Hex(content), bytes: content.byteLength };
}

export function validateManifestSemantics(manifest: TeamMemoryManifest): TeamMemoryManifest {
  for (const entry of manifest.entries) {
    if (!isTeamMemoryVisiblePath(entry.path) || entry.path === TEAM_MEMORY_MANIFEST_RELATIVE) {
      throw new TeamMemoryError("corrupt_state", `manifest path is outside durable team memory: ${entry.path}`);
    }
    if (entry.kind !== manifestEntryKind(entry.path)) {
      throw new TeamMemoryError("corrupt_state", `manifest kind does not match path ${entry.path}`);
    }
  }
  const sortedEntries = [...manifest.entries].sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalJson(sortedEntries) !== canonicalJson(manifest.entries)) {
    throw new TeamMemoryError("corrupt_state", "team memory manifest entries are not sorted");
  }
  if (new Set(manifest.entries.map((entry) => entry.path)).size !== manifest.entries.length) {
    throw new TeamMemoryError("corrupt_state", "team memory manifest contains duplicate paths");
  }
  if (
    manifest.root_digest !== manifestRootDigest(
      manifest.entries,
      manifest.canonical_map,
      manifest.installation_report,
      manifest.activation,
    )
  ) {
    throw new TeamMemoryError("corrupt_state", "team memory manifest root digest does not match its entries");
  }
  return manifest;
}

export function readTeamMemoryManifest(cwd: string): TeamMemoryManifest {
  let parsed: unknown;
  try {
    parsed = readRelativeJson(cwd, TEAM_MEMORY_MANIFEST_RELATIVE, MAX_MANIFEST_BYTES);
  } catch (error) {
    if (error instanceof TeamMemoryError && error.code === "not_found") {
      throw new TeamMemoryError("not_initialized", "team memory is not initialized");
    }
    throw error;
  }
  return validateManifestSemantics(
    validateSchema<TeamMemoryManifest>(TeamMemoryManifestSchema, parsed, "team memory manifest"),
  );
}

export function memoryManifestExists(cwd: string): boolean {
  return hasRecognizedManifestMarker(cwd);
}

export function readManifestIfPresent(cwd: string): TeamMemoryManifest | null {
  if (!memoryManifestExists(cwd)) return null;
  return readTeamMemoryManifest(cwd);
}

export function writeManifest(
  cwd: string,
  input: Omit<TeamMemoryManifest, "entries" | "root_digest" | "canonical_map" | "installation_report">,
  options?: MemoryStoreOptions,
): TeamMemoryManifest {
  const activation = input.activation ?? null;
  const entries = scanVisibleEntries(cwd);
  const canonicalMap = canonicalMapIntegrity(cwd);
  const report = installationReportIntegrity(cwd);
  const manifest: TeamMemoryManifest = {
    ...input,
    entries,
    root_digest: manifestRootDigest(entries, canonicalMap, report, activation),
    ...(canonicalMap ? { canonical_map: canonicalMap } : {}),
    ...(report ? { installation_report: report } : {}),
    ...(activation ? { activation } : {}),
  };
  validateSchema<TeamMemoryManifest>(TeamMemoryManifestSchema, manifest, "team memory manifest");
  writeJsonAtomic(cwd, TEAM_MEMORY_MANIFEST_RELATIVE, manifest, options, MAX_MANIFEST_BYTES);
  return manifest;
}

export function refreshManifestInternal(
  cwd: string,
  options?: MemoryStoreOptions,
  override?: { activation?: TeamMemoryActivation | null },
): TeamMemoryManifest {
  const current = readTeamMemoryManifest(cwd);
  const entries = scanVisibleEntries(cwd);
  const canonicalMap = canonicalMapIntegrity(cwd);
  const report = installationReportIntegrity(cwd);
  const activation = override?.activation ?? current.activation ?? null;
  const rootDigest = manifestRootDigest(entries, canonicalMap, report, activation);
  if (
    current.root_digest === rootDigest
    && canonicalJson(current.entries) === canonicalJson(entries)
    && canonicalJson(current.canonical_map ?? null) === canonicalJson(canonicalMap)
    && canonicalJson(current.installation_report ?? null) === canonicalJson(report)
    && canonicalJson(current.activation ?? null) === canonicalJson(activation)
  ) {
    return current;
  }
  const next: TeamMemoryManifest = {
    ...current,
    revision: current.revision + 1,
    updated_at: nowIso(options),
    entries,
    root_digest: rootDigest,
    ...(canonicalMap ? { canonical_map: canonicalMap } : {}),
    ...(report ? { installation_report: report } : {}),
    ...(activation ? { activation } : {}),
  };
  validateSchema<TeamMemoryManifest>(TeamMemoryManifestSchema, next, "team memory manifest");
  writeJsonAtomic(cwd, TEAM_MEMORY_MANIFEST_RELATIVE, next, options, MAX_MANIFEST_BYTES);
  return next;
}
