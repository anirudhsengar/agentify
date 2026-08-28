import * as fs from "node:fs";
import * as path from "node:path";
import { currentRepositoryCommit } from "../audit/explorer-receipts.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { loadCanonicalMapAt } from "../audit/write-map-tool.ts";
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
  const map = loadCanonicalMapAt(cwd, AUDIT_STATE_RELATIVE_DIR);
  const currentCommit = currentRepositoryCommit(cwd);
  if (
    map?.explorer_receipts === undefined
    || currentCommit === null
    || map.explorer_receipts.repository_commit !== currentCommit
    || map.explorer_receipts.receipts.length === 0
  ) {
    return null;
  }
  return fs.readFileSync(mapPath);
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
