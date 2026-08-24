#!/usr/bin/env node
// agentify:managed
// Verifies the Agentify memory manifest against the bytes on disk. The manifest
// asserting its own promotion proves nothing, so every digest it records is
// recomputed here before the trusted controller acts on it.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

function readBoundedJson(filePath, maximum = MAX_MANIFEST_BYTES) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > maximum) throw new Error("not one bounded regular JSON file");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const MEMORY_VISIBLE_DIRECTORIES = ["agents", "knowledge", "policies", "history"];

export function memoryEntryKind(relativePath) {
  if (relativePath === ".agentify/.gitignore") return "ignore_rules";
  if (relativePath.startsWith(".agentify/agents/")) return "agent_identity";
  if (relativePath.startsWith(".agentify/history/candidates/")) return "candidate_decision";
  if (relativePath.startsWith(".agentify/history/")) return "history_event";
  return "memory_record";
}

function walkMemoryFiles(root, relativeDirectory, into) {
  const absolute = path.join(root, ...relativeDirectory.split("/"));
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) walkMemoryFiles(root, child, into);
    else if (entry.isFile()) into.push(child);
  }
}

function memoryFileIntegrity(root, relativePath) {
  const absolute = path.join(root, ...relativePath.split("/"));
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const content = fs.readFileSync(absolute);
    return {
      path: relativePath,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
    };
  } catch {
    return null;
  }
}

export function memoryRootDigest(entries, canonicalMap, installationReport, activation) {
  const surface = entries
    .map((entry) => `${entry.path}\0${entry.kind}\0${entry.sha256}\0${entry.bytes}`)
    .join("\n");
  const attached = (label, record) =>
    record ? `\n\0${label}\0${record.path}\0${record.sha256}\0${record.bytes}` : "";
  const activationPart = activation
    ? `\n\0activation\0${activation.state}\0${activation.disposition}\0${activation.promoted_at ?? ""}`
    : "";
  return crypto.createHash("sha256")
    .update(surface + attached("canonical_map", canonicalMap) + attached("installation_report", installationReport) + activationPart)
    .digest("hex");
}

/**
 * Verify the memory manifest against what is actually on disk. Reading the
 * manifest's own fields proves nothing: a hand-written document asserting
 * promotion would otherwise satisfy the gate. Returns null when valid, or the
 * reason it is not.
 */
export function verifyMemoryManifest(root, repository) {
  const manifestPath = path.join(root, ".agentify", "manifest.json");
  if (!fs.existsSync(manifestPath)) return "its repository memory manifest is missing";
  let manifest;
  try {
    manifest = readBoundedJson(manifestPath);
  } catch {
    return "its repository memory manifest is unreadable";
  }
  if (manifest?.format !== "agentify_team_memory" || manifest?.schema_version !== "1") {
    return "its repository memory manifest has an unrecognized format or schema version";
  }
  if (String(manifest.repository_id ?? "") !== repository) {
    return `its repository memory belongs to ${String(manifest.repository_id ?? "an unknown repository")}, not ${repository}`;
  }
  if (!Array.isArray(manifest.entries)) return "its repository memory manifest lists no entries";

  // Every listed entry must match the bytes on disk.
  for (const entry of manifest.entries) {
    const actual = memoryFileIntegrity(root, String(entry?.path ?? ""));
    if (actual === null) return `a manifest entry is missing from disk: ${String(entry?.path ?? "")}`;
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) {
      return `a manifest entry no longer matches its recorded digest: ${entry.path}`;
    }
    if (entry.kind !== memoryEntryKind(entry.path)) {
      return `a manifest entry records the wrong kind: ${entry.path}`;
    }
  }

  // And every visible file must be listed, so nothing can be added unrecorded.
  const present = [".agentify/.gitignore"];
  for (const directory of MEMORY_VISIBLE_DIRECTORIES) walkMemoryFiles(root, `.agentify/${directory}`, present);
  const listed = new Set(manifest.entries.map((entry) => String(entry.path)));
  const unlisted = present.filter((candidate) =>
    !listed.has(candidate) && fs.existsSync(path.join(root, ...candidate.split("/"))));
  if (unlisted.length > 0) return `repository memory contains files the manifest does not record: ${unlisted.slice(0, 3).join(", ")}`;

  const canonicalMap = memoryFileIntegrity(root, ".agentify/runtime/audit/codebase_map.json");
  const installationReport = memoryFileIntegrity(root, ".agentify/installation-report.json");
  const recordedMap = manifest.canonical_map ?? null;
  const recordedReport = manifest.installation_report ?? null;
  if (recordedMap && (!canonicalMap || canonicalMap.sha256 !== recordedMap.sha256)) {
    return "the canonical audit map no longer matches the digest recorded for it";
  }
  if (recordedReport && (!installationReport || installationReport.sha256 !== recordedReport.sha256)) {
    return "the installation report no longer matches the digest recorded for it";
  }

  const activation = manifest.activation;
  if (!activation || activation.state !== "promoted" || activation.disposition !== "ready") {
    return "its repository memory was produced by an installation that never completed activation";
  }
  if (typeof activation.promoted_at !== "string" || !Number.isFinite(Date.parse(activation.promoted_at))) {
    return "its repository memory records promotion without a valid promotion time";
  }
  if (memoryRootDigest(manifest.entries, recordedMap, recordedReport, activation) !== manifest.root_digest) {
    return "its repository memory manifest root digest does not match its contents";
  }

  // The report is the document that declares the installation succeeded.
  if (installationReport === null) return "its installation report is missing";
  let report;
  try {
    report = readBoundedJson(path.join(root, ".agentify", "installation-report.json"));
  } catch {
    return "its installation report is unreadable";
  }
  if (report?.disposition !== "ready" || report?.policy_configured !== true || report?.agentify_enabled !== true) {
    return "its installation report does not record a completed, enabled installation";
  }
  return null;
}

