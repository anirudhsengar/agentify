/**
 * Exact provenance of the running Agentify build. `agentify_version` alone
 * cannot distinguish two builds of the same version, which matters when an
 * installation report is used to reproduce or triage a result.
 */
declare const __AGENTIFY_SOURCE_COMMIT__: string | null | undefined;
declare const __AGENTIFY_SOURCE_DIRTY__: boolean | null | undefined;

export interface BuildProvenance {
  /** Git commit the distribution was built from, when it was built from a checkout. */
  source_commit: string | null;
  /** Whether that checkout had uncommitted changes at build time. */
  source_dirty: boolean | null;
}

export function buildProvenance(): BuildProvenance {
  return {
    source_commit: typeof __AGENTIFY_SOURCE_COMMIT__ === "string" ? __AGENTIFY_SOURCE_COMMIT__ : null,
    source_dirty: typeof __AGENTIFY_SOURCE_DIRTY__ === "boolean" ? __AGENTIFY_SOURCE_DIRTY__ : null,
  };
}
