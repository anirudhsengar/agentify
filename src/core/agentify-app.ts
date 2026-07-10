import { runAgentify } from "./run-agentify.ts";
import { formatGitHubReadiness, inspectGitHubReadiness } from "./github-readiness.ts";
import { readProjectState } from "./project-state.ts";
import { inspectAgentifyRepoState } from "./repo-status.ts";
import { defaultConfigDir } from "./agentify-config.ts";
import { stdin as input } from "node:process";
import { getPremiumTargets, isKnownAgent } from "./agent-registry.ts";
import { promptTargets } from "./target-picker.ts";
import type {
  AgentifyTarget,
  RunAgentifyOptions,
} from "./types.ts";

const DEFAULT_TARGETS: ReadonlyArray<AgentifyTarget> = ["codex", "claude", "pi"];

export interface RunAgentifyAppOptions
  extends Omit<RunAgentifyOptions, "targets" | "additionalAgents" | "args"> {
  args: ReadonlyArray<string>;
  /**
   * Premium harness targets (Codex / Claude / Pi). When set, bypasses the
   * picker and runs with these targets. Tests and the `--targets` CLI
   * flag both set this. When unset, the picker drives resolution.
   */
  targets?: ReadonlyArray<AgentifyTarget>;
  /**
   * Override for the full picker output — registry IDs (premium +
   * non-premium). When set, the picker is bypassed entirely and these
   * IDs are split into `targets` (premium subset) and `additionalAgents`
   * (non-premium subset). Used by the `--targets` CLI flag.
   */
  targetsOverride?: ReadonlyArray<string>;
}

function reportGitHubReadiness(options: RunAgentifyAppOptions): void {
  const readiness = options.githubReadinessOverride
    ?? inspectGitHubReadiness({ cwd: options.cwd });
  for (const line of formatGitHubReadiness(readiness)) {
    options.ui.info(line);
  }
}

function attachToInitializedRepo(options: RunAgentifyAppOptions): void {
  const configDir = defaultConfigDir();
  const repoState = inspectAgentifyRepoState(options.cwd, configDir);
  const projectState = readProjectState(configDir, options.cwd);
  options.ui.status(`agentify: attached to initialized ${repoState.mode} repo`);
  options.ui.info(
    `agentify: status=ready, feature_agents=${repoState.featureAgentCount}, workflows=${repoState.workflowCount}, experts=${repoState.expertCount}, skills=${repoState.skillCount}, found=${repoState.found.length}`,
  );
  if (projectState) {
    options.ui.info(
      `agentify: last_run=${projectState.lastRunAt}, last_status=${projectState.runStatus}, project_kind=${projectState.projectKind}`,
    );
  }
  if (repoState.latestLogPath) {
    options.ui.info(`agentify: latest log ${repoState.latestLogPath}`);
  }
  options.ui.info("agentify: use GitHub issues, comments, and PRs as the async inbox.");
  reportGitHubReadiness(options);
}

/**
 * Resolve which agents to target for this run. Resolution order:
 *
 * 1. `targetsOverride` (the `--targets` CLI flag) — already-validated
 *    registry IDs; bypass picker entirely.
 * 2. `targets` (programmatic caller — tests) — premium targets only.
 *    Non-premium agents default to none.
 * 3. Interactive TTY — run the picker.
 * 4. Non-interactive without override — fall back to the three premium
 *    defaults. We never fail just because stdin isn't a TTY: existing
 *    CI scripts that ran without `--targets` should keep working.
 */
async function resolveTargets(
  options: RunAgentifyAppOptions,
): Promise<{ targets: ReadonlyArray<AgentifyTarget>; additionalAgents: ReadonlyArray<string> }> {
  if (options.targetsOverride !== undefined) {
    const allIds = options.targetsOverride.filter(isKnownAgent);
    const premium = getPremiumTargets(allIds);
    const additional = allIds.filter(
      (id) => !premium.includes(id as AgentifyTarget),
    );
    return { targets: premium, additionalAgents: additional };
  }

  if (options.targets !== undefined) {
    return { targets: options.targets, additionalAgents: [] };
  }

  if (!input.isTTY) {
    return { targets: DEFAULT_TARGETS, additionalAgents: [] };
  }

  const selected = await promptTargets(options.ui);
  const premium = getPremiumTargets(selected);
  const additional = selected.filter(
    (id) => !premium.includes(id as AgentifyTarget),
  );
  return { targets: premium, additionalAgents: additional };
}

export async function runAgentifyApp(options: RunAgentifyAppOptions): Promise<void> {
  if (options.args.length > 0) {
    const first = options.args[0];
    throw new Error(
      `agentify does not accept '${first}'. Known subcommands: login, logout, models, revert. Run \`agentify --help\` for usage.`,
    );
  }

  const configDir = defaultConfigDir();
  const repoState = inspectAgentifyRepoState(options.cwd, configDir);
  if (repoState.status === "ready") {
    attachToInitializedRepo(options);
    return;
  }
  if (repoState.status === "partial") {
    const projectState = readProjectState(configDir, options.cwd);
    options.ui.status("agentify: detected incomplete setup; recovering");
    if (projectState) {
      options.ui.info(
        `agentify: previous run ended with ${projectState.runStatus} at ${projectState.lastRunAt}`,
      );
    }
    if (repoState.missing.length > 0) {
      options.ui.info(`agentify: missing ${repoState.missing.join(", ")}`);
    }
  }

  const resolved = await resolveTargets(options);

  await runAgentify({
    cwd: options.cwd,
    ui: options.ui,
    runtime: options.runtime,
    targets: resolved.targets,
    additionalAgents: resolved.additionalAgents,
    signal: options.signal,
    mode: options.mode,
    configOverride: options.configOverride,
    githubReadinessOverride: options.githubReadinessOverride,
  });
}