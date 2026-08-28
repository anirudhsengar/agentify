import { DEFAULT_MAP_FILENAME, writeCanonicalMap } from "../audit/map-storage.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { compileSpecialistEvidence } from "../audit/schema.ts";
import { assessExplorerReceiptAttestation } from "../audit/explorer-receipts.ts";
import { loadCanonicalMapAt } from "../audit/write-map-tool.ts";
import type {
  InstallerBlocker,
  OneTimeInstallationReport,
} from "./contracts.ts";
import {
  finalizeOneTimeInstallation as finalizeBaseInstallation,
  formatOneTimeInstallationReport as formatBaseInstallationReport,
  type FinalizeOneTimeInstallationInput,
} from "./finalization.ts";
import {
  beginPendingInstallation,
  commitPendingInstallation,
  rollbackPendingInstallation,
} from "./installation-transaction.ts";

export type { FinalizeOneTimeInstallationInput };

const ATOMIC_ROLLBACK_PREFIX = "Atomic installation rolled back";

function auditIntentionallyDeferred(input: FinalizeOneTimeInstallationInput): boolean {
  return input.preflight.blockers.some((blocker) =>
    blocker.code === "validation_consent_required"
    || blocker.code === "validation_policy_stale"
  );
}

function atomicBlocker(message: string): InstallerBlocker {
  return {
    code: "installation_canary_failed",
    message: `${ATOMIC_ROLLBACK_PREFIX}: ${message}`,
    remediation:
      "Repair the compiled specialist evidence or Agentify-owned installation conflict, then rerun Agentify. No partial repository team was retained.",
  };
}

function reportAfterRollback(
  input: FinalizeOneTimeInstallationInput,
  report: OneTimeInstallationReport,
  reason: string,
): OneTimeInstallationReport {
  const blocker = atomicBlocker(reason);
  return {
    ...report,
    disposition: input.preflight.analysis_allowed ? "analyzable-only" : "blocked",
    specialists_installed: 0,
    procedures_installed: 0,
    github_issue_intake_enabled: false,
    draft_pr_publication_enabled: false,
    automatic_knowledge_refresh_enabled: false,
    automatic_application_merge_enabled: false,
    blockers: [
      ...report.blockers.filter((entry) => !entry.message.startsWith(ATOMIC_ROLLBACK_PREFIX)),
      blocker,
    ],
  };
}

function structuralFailure(report: OneTimeInstallationReport): string | null {
  const critical = report.blockers.filter((blocker) =>
    blocker.code === "installation_canary_failed"
    || blocker.code === "ambiguous_agentify_state"
    || blocker.code === "user_owned_workflow_conflict"
  );
  if (critical.length === 0) return null;
  return critical.map((blocker) => `[${blocker.code}] ${blocker.message}`).join("; ");
}

/**
 * Finalize only the exact fixed-point map that passed deterministic specialist
 * compilation. Repository writes are committed only after specialist
 * materialization and installation canaries agree with that compiled map.
 */
export function finalizeOneTimeInstallation(
  input: FinalizeOneTimeInstallationInput,
): OneTimeInstallationReport {
  const map = loadCanonicalMapAt(input.cwd, AUDIT_STATE_RELATIVE_DIR);
  let expectedSpecialists: number | null = null;

  if (map === null) {
    if (!auditIntentionallyDeferred(input)) {
      rollbackPendingInstallation(input.cwd);
      throw new Error(
        "cannot finalize Agentify without a canonical codebase map that passed specialist compilation",
      );
    }
  } else {
    const compilation = compileSpecialistEvidence(map, { cwd: input.cwd });
    if (compilation.map !== map) {
      writeCanonicalMap(input.cwd, compilation.map, {
        stateDir: AUDIT_STATE_RELATIVE_DIR,
        mapFilename: DEFAULT_MAP_FILENAME,
      });
    }
    if (!compilation.complete) {
      rollbackPendingInstallation(input.cwd);
      throw new Error(
        "repository specialist compilation failed before installation: "
          + compilation.reasons.join("; "),
      );
    }
    const receiptAttestation = assessExplorerReceiptAttestation(
      compilation.map,
      input.cwd,
    );
    if (!receiptAttestation.complete) {
      rollbackPendingInstallation(input.cwd);
      throw new Error(
        "repository specialist compilation failed before installation: explorer attestation: "
          + receiptAttestation.reasons.join("; "),
      );
    }
    if (compilation.assessment.source === "concern_evidence") {
      expectedSpecialists = compilation.assessment.accepted_concerns.length;
    }
  }

  beginPendingInstallation(input.cwd);
  try {
    const report = finalizeBaseInstallation(input);
    const mismatch = expectedSpecialists !== null
      && report.specialists_installed !== expectedSpecialists;
    const failure = structuralFailure(report);

    if (mismatch || failure !== null) {
      rollbackPendingInstallation(input.cwd);
      return reportAfterRollback(
        input,
        report,
        mismatch
          ? `compiled ${expectedSpecialists} specialist concern(s), but materialization installed ${report.specialists_installed}`
          : failure!,
      );
    }

    commitPendingInstallation(input.cwd);
    return report;
  } catch (error) {
    rollbackPendingInstallation(input.cwd);
    throw error;
  }
}

export function formatOneTimeInstallationReport(
  report: OneTimeInstallationReport,
): string[] {
  const rolledBack = report.blockers.some((blocker) =>
    blocker.message.startsWith(ATOMIC_ROLLBACK_PREFIX)
  );
  const lines = formatBaseInstallationReport(report);
  if (!rolledBack) return lines;
  return lines.map((line) =>
    line === "Persistent orchestrator installed"
      ? "No persistent repository team installed; diagnostic audit evidence retained"
      : line
  );
}
