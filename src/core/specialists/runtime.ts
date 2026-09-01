import { loadCanonicalMapAt } from "../audit/write-map-tool.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { compileSpecialistEvidence } from "../audit/schema.ts";
import {
  hasRecognizedManifestMarker,
  readTeamMemoryManifest,
} from "../memory/index.ts";
import type { MaterializedPortfolioResult, SpecialistPortfolio } from "./contracts.ts";
import { discoverSpecialistPortfolio } from "./discovery.ts";
import { listTrackedFilesAtCommit, readGitHeadCommit } from "./evidence.ts";
import { materializeSpecialistPortfolio } from "./persistence.ts";
import { readInstalledTrustedValidationArgv } from "./trusted-commands.ts";

export type RepositorySpecialistSyncResult =
  | { status: "memory_absent" }
  | { status: "map_absent"; state_dir: string | null }
  | {
      status: "synchronized";
      state_dir: string;
      portfolio: SpecialistPortfolio;
      materialized: MaterializedPortfolioResult;
    };

export interface SynchronizeRepositorySpecialistsOptions {
  trustedValidationArgv?: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Synchronize deterministic specialist and procedure expertise when the
 * vendor-neutral team-memory store has already been established by the trusted
 * installer. Repositories without that recognized store remain untouched.
 */
export function synchronizeRepositorySpecialists(
  cwd: string,
  options: SynchronizeRepositorySpecialistsOptions = {},
): RepositorySpecialistSyncResult {
  if (!hasRecognizedManifestMarker(cwd)) return { status: "memory_absent" };

  readTeamMemoryManifest(cwd);
  const map = loadCanonicalMapAt(cwd, AUDIT_STATE_RELATIVE_DIR);
  if (map === null) return { status: "map_absent", state_dir: null };
  const compilation = compileSpecialistEvidence(map, { cwd });
  if (!compilation.complete) {
    throw new Error(
      `specialist compilation is incomplete; materialization refused: ${compilation.reasons.join("; ")}`,
    );
  }
  if (compilation.map !== map) {
    throw new Error(
      "specialist compilation is not at an idempotent fixed point; persist the compiled canonical map before materialization",
    );
  }

  const supportingCommit = readGitHeadCommit(cwd);
  const trustedValidationArgv = options.trustedValidationArgv
    ?? readInstalledTrustedValidationArgv(cwd);
  const portfolio = discoverSpecialistPortfolio(
    compilation.map,
    supportingCommit,
    listTrackedFilesAtCommit(cwd, supportingCommit),
    { trustedValidationArgv },
  );
  const materialized = materializeSpecialistPortfolio({
    cwd,
    portfolio,
    actor: "knowledge-maintainer",
    source_type: "validated_bootstrap",
    evidence_actor: "agentify-specialist-discovery",
  });
  return {
    status: "synchronized",
    state_dir: AUDIT_STATE_RELATIVE_DIR,
    portfolio,
    materialized,
  };
}
