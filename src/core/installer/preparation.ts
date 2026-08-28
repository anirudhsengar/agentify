import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import {
  currentRepositoryCommit,
  normalizeScoutConcernProposal,
} from "../audit/explorer-receipts.ts";
import { MAX_MAP_FILE_BYTES } from "../audit/map-input.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { CodebaseMapSchema, type CodebaseMap } from "../audit/schema.ts";
import type { RepositoryInstallationPreflight } from "./contracts.ts";
import {
  prepareOneTimeInstallationState as prepareBaseInstallationState,
} from "./finalization.ts";
import {
  beginPendingInstallation,
  retainDiagnosticProgressOnRollback,
  rollbackPendingInstallation,
} from "./installation-transaction.ts";

function exactDirectoryEntries(
  directory: string,
  expected: ReadonlyArray<string>,
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const actual = fs.readdirSync(directory).sort();
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResumableDiagnosticMap(raw: Buffer): { map: CodebaseMap; bytes: Buffer } | null {
  if (raw.byteLength > MAX_MAP_FILE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (Value.Check(CodebaseMapSchema, parsed)) {
    return { map: parsed as CodebaseMap, bytes: raw };
  }

  if (!isRecord(parsed) || !isRecord(parsed.explorer_receipts)) return null;
  const receipts = parsed.explorer_receipts.receipts;
  if (!Array.isArray(receipts)) return null;
  let repaired = false;
  for (const receipt of receipts) {
    if (!isRecord(receipt) || receipt.proposed_concerns === undefined) continue;
    if (!Array.isArray(receipt.proposed_concerns)) return null;
    const proposals: string[] = [];
    for (const value of receipt.proposed_concerns) {
      if (typeof value !== "string") return null;
      const normalized = normalizeScoutConcernProposal(value);
      if (normalized !== null && !proposals.includes(normalized)) proposals.push(normalized);
      if (normalized !== value) repaired = true;
    }
    if (proposals.length !== receipt.proposed_concerns.length) repaired = true;
    receipt.proposed_concerns = proposals;
  }
  if (!repaired || !Value.Check(CodebaseMapSchema, parsed)) return null;
  const bytes = Buffer.from(JSON.stringify(parsed, null, 2), "utf8");
  return bytes.byteLength <= MAX_MAP_FILE_BYTES
    ? { map: parsed as CodebaseMap, bytes }
    : null;
}

function resumableDiagnosticMapBytes(cwd: string): Buffer | null {
  const root = path.join(cwd, ".agentify");
  const runtime = path.join(root, "runtime");
  const audit = path.join(runtime, "audit");
  const mapPath = path.join(audit, "codebase_map.json");
  if (
    !exactDirectoryEntries(root, ["runtime"])
    || !exactDirectoryEntries(runtime, ["audit"])
    || !exactDirectoryEntries(audit, ["codebase_map.json"])
  ) {
    return null;
  }
  let mapStat: fs.Stats;
  try {
    mapStat = fs.lstatSync(mapPath);
  } catch {
    return null;
  }
  if (mapStat.isSymbolicLink() || !mapStat.isFile()) return null;
  const diagnostic = parseResumableDiagnosticMap(fs.readFileSync(mapPath));
  const currentCommit = currentRepositoryCommit(cwd);
  if (
    diagnostic?.map.explorer_receipts === undefined
    || currentCommit === null
    || diagnostic.map.explorer_receipts.repository_commit !== currentCommit
    || diagnostic.map.explorer_receipts.receipts.length === 0
  ) {
    return null;
  }
  return diagnostic.bytes;
}

/**
 * Start one repository-side installation transaction before any persistent
 * identity or policy is materialized. Audit or finalization failure rolls this
 * transaction back to the exact pre-installation state.
 */
export function prepareOneTimeInstallationState(
  cwd: string,
  preflight: RepositoryInstallationPreflight,
): void {
  if (!preflight.analysis_allowed) {
    throw new Error("repository preflight forbids analysis; no installation transaction was started");
  }
  beginPendingInstallation(cwd);
  try {
    const diagnosticMap = resumableDiagnosticMapBytes(cwd);
    if (diagnosticMap !== null) {
      retainDiagnosticProgressOnRollback(cwd);
      fs.rmSync(path.join(cwd, ".agentify"), { recursive: true });
    }
    prepareBaseInstallationState(cwd, preflight);
    if (diagnosticMap !== null) {
      const mapPath = path.join(cwd, AUDIT_STATE_RELATIVE_DIR, "codebase_map.json");
      fs.mkdirSync(path.dirname(mapPath), { recursive: true });
      fs.writeFileSync(mapPath, diagnosticMap);
    }
  } catch (error) {
    rollbackPendingInstallation(cwd);
    throw error;
  }
}
