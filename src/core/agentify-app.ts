import { defaultConfigDir, ensureAgentifyConfig } from "./agentify-config.ts";
import { runRepositoryAudit, type FocusedAuditResult } from "./runs/repository-audit-run.ts";
import { loadCanonicalMapAt } from "./audit/write-map-tool.ts";
import { assessCoverageClosure } from "./audit/schema.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "./audit/paths.ts";
import type {
  AgentifyConfig,
  AgentifyUi,
  AgentRuntime,
} from "./types.ts";

export interface RunAgentifyAppOptions {
  args: ReadonlyArray<string>;
  cwd: string;
  ui: AgentifyUi;
  runtime: AgentRuntime;
  signal?: AbortSignal;
  configOverride?: AgentifyConfig;
}

/** Run the single focused model-backed operation: a read-only repository map. */
export async function runAgentifyApp(options: RunAgentifyAppOptions): Promise<FocusedAuditResult> {
  if (options.args.length > 0) {
    throw new Error(
      `agentify does not accept '${options.args[0]}'. Known subcommands: login, logout, models. Run \`agentify --help\` for usage.`,
    );
  }
  const config = options.configOverride
    ?? await ensureAgentifyConfig(defaultConfigDir(), options.ui);
  const existingMap = loadCanonicalMapAt(options.cwd, AUDIT_STATE_RELATIVE_DIR);
  if (existingMap !== null) {
    const closure = assessCoverageClosure(existingMap);
    if (closure.unresolved.length === 0) {
      options.ui.status("agentify: attached to the existing persistent repository team");
      options.ui.info("agentify: verified the existing structured codebase map; no model audit was rerun");
      return {
        map_path: `${AUDIT_STATE_RELATIVE_DIR}/codebase_map.json`,
        covered_dimensions: closure.closed.length,
        total_dimensions: closure.closed.length,
        turns: 0,
        cost_usd: null,
      };
    }
  }
  return runRepositoryAudit({
    cwd: options.cwd,
    ui: options.ui,
    runtime: options.runtime,
    config,
    signal: options.signal,
  });
}
