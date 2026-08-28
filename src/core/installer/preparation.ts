import type { RepositoryInstallationPreflight } from "./contracts.ts";
import {
  prepareOneTimeInstallationState as prepareBaseInstallationState,
} from "./finalization.ts";
import {
  beginPendingInstallation,
  rollbackPendingInstallation,
} from "./installation-transaction.ts";

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
    prepareBaseInstallationState(cwd, preflight);
  } catch (error) {
    rollbackPendingInstallation(cwd);
    throw error;
  }
}
