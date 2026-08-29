import { defaultConfigDir, ensureAgentifyConfig, runFullProviderSetup } from "./agentify-config.ts";
import { DEFAULT_MAP_FILENAME, writeCanonicalMap } from "./audit/map-storage.ts";
import { runRepositoryAudit, ProviderAuthFailedError, type FocusedAuditResult } from "./runs/repository-audit-run.ts";
import { probeProviderReachable } from "./runs/provider-probe.ts";
import { NoAuthForProviderError } from "./models/resolver.ts";
import { loadCanonicalMapAt } from "./audit/write-map-tool.ts";
import {
  assessAuditCompletion,
  compileSpecialistEvidence,
} from "./audit/schema.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "./audit/paths.ts";
import { rollbackPendingInstallation } from "./installer/installation-transaction.ts";
import { assessExplorerReceiptAttestation } from "./audit/explorer-receipts.ts";
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
}

/** Provider slug a failure blamed, if the failure is credential-shaped. */
function failedAuthProvider(error: unknown): string | undefined {
  if (error instanceof ProviderAuthFailedError) return error.provider;
  if (error instanceof NoAuthForProviderError) return error.provider;
  return undefined;
}

/**
 * Verify the configured model is actually reachable *before* the audit
 * banner, spinner, and gap-map bootstrap start. On failure this re-enters
 * the full provider picker (same as brand-new setup — every supported
 * provider, not just a re-prompt for the one that just failed), since a
 * rejected credential is as good a reason to reconsider the provider as
 * having none configured at all. Probes and re-setups run at most twice
 * total, so a genuinely broken environment fails loudly instead of looping.
 */
async function ensureProviderReachable(
  options: RunAgentifyAppOptions,
  config: AgentifyConfig,
): Promise<AgentifyConfig> {
  const configDir = defaultConfigDir();
  const first = await probeProviderReachable(options.runtime, options.cwd, configDir, config);
  if (first.ok) return config;

  options.ui.info(
    first.provider
      ? `agentify: could not reach ${first.provider}${first.detail ? `: ${first.detail}` : " — the stored credentials may be missing, invalid, or expired."}`
      : "agentify: could not verify the configured model provider.",
  );
  const updated = await runFullProviderSetup(configDir, options.ui, config);

  const second = await probeProviderReachable(options.runtime, options.cwd, configDir, updated);
  if (second.ok) return updated;
  throw new Error(
    `agentify: still could not reach ${second.provider ?? "the configured provider"} after re-entering setup`
    + `${second.detail ? `: ${second.detail}` : ". Double-check the API key and your network connection, then run `agentify` again."}`,
  );
}

/**
 * Run the audit; if it still fails on a credential-shaped error despite
 * passing the pre-flight probe (e.g. a key valid enough for one trivial
 * call but rejected under real load, or revoked mid-run), fall back to the
 * same full provider picker rather than a bare error.
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
    const existingMap = loadCanonicalMapAt(options.cwd, AUDIT_STATE_RELATIVE_DIR);
    if (existingMap !== null) {
      const completion = assessAuditCompletion(existingMap, { cwd: options.cwd });
      if (
        completion.coverage.unresolved.length === 0
        && completion.specialistEvidenceRecorded
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
        if (compilation.complete && receiptAssessment.complete) {
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
        && !completion.specialistEvidenceRecorded
      ) {
        options.ui.info(
          "agentify: the existing codebase map predates specialist evidence; running a bounded top-up audit",
        );
      }
    }
    const verifiedConfig = await ensureProviderReachable(options, config);
    return await runAuditWithCredentialRecovery(options, verifiedConfig);
  } catch (error) {
    rollbackPendingInstallation(options.cwd);
    throw error;
  }
}
