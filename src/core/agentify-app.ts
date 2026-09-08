import { defaultConfigDir, ensureAgentifyConfig, runFullProviderSetup } from "./agentify-config.ts";
import { DEFAULT_MAP_FILENAME, writeCanonicalMap } from "./audit/map-storage.ts";
import { runRepositoryAudit, ProviderAuthFailedError, type FocusedAuditResult } from "./runs/repository-audit-run.ts";
import { NoAuthForProviderError } from "./models/resolver.ts";
import { loadCanonicalMapAt } from "./audit/write-map-tool.ts";
import {
  assessAuditCompletion,
  compileSpecialistEvidence,
  specialistEvidenceRecorded,
} from "./audit/schema.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "./audit/paths.ts";
import type { AgentifyLog } from "./audit/log.ts";
import { rollbackPendingInstallation } from "./installer/installation-transaction.ts";
import { assessExplorerReceiptAttestation } from "./audit/explorer-receipts.ts";
import { assessSpecialistReviews } from "./audit/specialist-review.ts";
import { createRepositoryEvidenceDraft } from "./audit/repository-evidence-bootstrap.ts";
import type {
  AgentifyConfig,
  AgentifyUi,
  AgentRuntime,
} from "./types.ts";
import type { RepositoryInstallationPreflight } from "./installer/contracts.ts";

export interface RunAgentifyAppOptions {
  args: ReadonlyArray<string>;
  cwd: string;
  ui: AgentifyUi;
  runtime: AgentRuntime;
  signal?: AbortSignal;
  configOverride?: AgentifyConfig;
  repositoryPreflight?: RepositoryInstallationPreflight;
  /** Installer-owned log remains open until materialization and validation finish. */
  auditLog?: AgentifyLog;
}

/** Provider slug a failure blamed, if the failure is credential-shaped. */
function failedAuthProvider(error: unknown): string | undefined {
  if (error instanceof ProviderAuthFailedError) return error.provider;
  if (error instanceof NoAuthForProviderError) return error.provider;
  return undefined;
}

/**
 * The first accounted audit request establishes reachability. Credential
 * failures still enter the full provider picker once; no unlogged model probe
 * is needed before the real audit's resource budget exists.
 */
async function runAuditWithCredentialRecovery(
  options: RunAgentifyAppOptions,
  config: AgentifyConfig,
): Promise<FocusedAuditResult> {
  const runOnce = (activeConfig: AgentifyConfig): Promise<FocusedAuditResult> => runRepositoryAudit({
    cwd: options.cwd,
    ui: options.ui,
    runtime: options.runtime,
    config: activeConfig,
    signal: options.signal,
    repositoryPreflight: options.repositoryPreflight,
    auditLog: options.auditLog,
    deferAuditLogCompletion: options.auditLog !== undefined,
  });
  try {
    return await runOnce(config);
  } catch (error) {
    if (!failedAuthProvider(error)) throw error;
    options.ui.info("agentify: the audit hit a provider error — let's fix your credentials.");
    const updated = await runFullProviderSetup(defaultConfigDir(), options.ui, config);
    return runOnce(updated);
  }
}

/** Run the single focused model-backed operation: a read-only repository map. */
export async function runAgentifyApp(options: RunAgentifyAppOptions): Promise<FocusedAuditResult> {
  try {
    if (options.args.length > 0) {
      throw new Error(
        `agentify does not accept '${options.args[0]}'. Known subcommands: login, logout, models. Run \`agentify --help\` for usage.`,
      );
    }
    const config = options.configOverride
      ?? await ensureAgentifyConfig(defaultConfigDir(), options.ui);
    let existingMap = loadCanonicalMapAt(options.cwd, AUDIT_STATE_RELATIVE_DIR);
    if (existingMap !== null && options.repositoryPreflight !== undefined) {
      const refreshed = createRepositoryEvidenceDraft(
        options.cwd,
        options.repositoryPreflight,
        existingMap,
      );
      if (refreshed !== existingMap) {
        writeCanonicalMap(options.cwd, refreshed, {
          stateDir: AUDIT_STATE_RELATIVE_DIR,
          mapFilename: DEFAULT_MAP_FILENAME,
        });
        existingMap = refreshed;
      }
    }
    if (existingMap !== null) {
      const completion = assessAuditCompletion(existingMap, { cwd: options.cwd });
      const evidenceRecorded = specialistEvidenceRecorded(existingMap);
      if (
        completion.coverage.unresolved.length === 0
        && evidenceRecorded
      ) {
        const compilation = compileSpecialistEvidence(existingMap, { cwd: options.cwd });
        const receiptAssessment = assessExplorerReceiptAttestation(
          compilation.map,
          options.cwd,
        );
        if (compilation.map !== existingMap) {
          writeCanonicalMap(options.cwd, compilation.map, {
            stateDir: AUDIT_STATE_RELATIVE_DIR,
            mapFilename: DEFAULT_MAP_FILENAME,
          });
        }
        if (compilation.complete && receiptAssessment.complete
          && assessSpecialistReviews(compilation.map, options.cwd).length === 0) {
          options.ui.info(
            `agentify: retained ${compilation.assessment.accepted_concerns.length} tracked specialist concern(s) and recorded ${compilation.assessment.rejected_concerns.length} ungrounded candidate(s) as rejected`,
          );
          options.ui.status("agentify: verified existing repository audit evidence");
          options.ui.info("agentify: verified the existing structured codebase map; no model audit was rerun");
          return {
            map_path: `${AUDIT_STATE_RELATIVE_DIR}/codebase_map.json`,
            covered_dimensions: completion.coverage.closed.length,
            total_dimensions: completion.coverage.closed.length,
            turns: 0,
            cost_usd: null,
          };
        }
        if (compilation.complete) {
          options.ui.info(
            `agentify: existing specialist evidence lacks current explorer attestation (${receiptAssessment.reasons.join("; ")}); running a bounded receipt repair audit`,
          );
        }
        options.ui.info(
          "agentify: deterministic specialist compilation reopened unresolved ownership; running a bounded repair audit",
        );
      } else if (
        completion.coverage.unresolved.length === 0
        && !evidenceRecorded
      ) {
        options.ui.info(
          "agentify: the existing codebase map predates specialist evidence; running a bounded top-up audit",
        );
      }
    }
    return await runAuditWithCredentialRecovery(options, config);
  } catch (error) {
    rollbackPendingInstallation(options.cwd);
    throw error;
  }
}
