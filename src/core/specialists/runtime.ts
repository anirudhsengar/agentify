import * as fs from "node:fs";
import * as path from "node:path";
import { loadCanonicalMapAt } from "../audit/write-map-tool.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import {
  hasRecognizedManifestMarker,
  readTeamMemoryManifest,
} from "../memory/index.ts";
import type { MaterializedPortfolioResult, SpecialistPortfolio } from "./contracts.ts";
import { discoverSpecialistPortfolio } from "./discovery.ts";
import { listTrackedFilesAtCommit, readGitHeadCommit } from "./evidence.ts";
import { materializeSpecialistPortfolio } from "./persistence.ts";

export type RepositorySpecialistSyncResult =
  | { status: "memory_absent" }
  | { status: "map_absent"; state_dir: string | null }
  | {
      status: "synchronized";
      state_dir: string;
      portfolio: SpecialistPortfolio;
      materialized: MaterializedPortfolioResult;
    };

function installedValidationCommands(cwd: string): string[] | undefined {
  const policyPath = path.join(cwd, ".github", "agentify-task-policy.json");
  if (!fs.existsSync(policyPath)) return undefined;
  try {
    const configuration = JSON.parse(fs.readFileSync(policyPath, "utf8")) as {
      configured?: unknown;
      policy?: { validation_commands?: unknown } | null;
    };
    if (configuration.configured !== true) return [];
    const entries = configuration.policy?.validation_commands;
    if (!Array.isArray(entries)) return [];
    const commands = entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const argv = (entry as { argv?: unknown }).argv;
      if (
        !Array.isArray(argv)
        || argv.length === 0
        || !argv.every((argument) => typeof argument === "string" && argument.trim().length > 0)
      ) return [];
      return [argv.join(" ")];
    });
    return [...new Set(commands)].sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/**
 * Synchronize deterministic specialist and procedure expertise when the
 * vendor-neutral team-memory store has already been established by the trusted
 * installer. Repositories without that recognized store remain untouched.
 */
export function synchronizeRepositorySpecialists(
  cwd: string,
  authoritativeValidationCommands?: ReadonlyArray<string>,
): RepositorySpecialistSyncResult {
  if (!hasRecognizedManifestMarker(cwd)) return { status: "memory_absent" };

  readTeamMemoryManifest(cwd);
  const map = loadCanonicalMapAt(cwd, AUDIT_STATE_RELATIVE_DIR);
  if (map === null) return { status: "map_absent", state_dir: null };

  const supportingCommit = readGitHeadCommit(cwd);
  const portfolio = discoverSpecialistPortfolio(
    map,
    supportingCommit,
    listTrackedFilesAtCommit(cwd, supportingCommit),
    authoritativeValidationCommands ?? installedValidationCommands(cwd),
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
