import { runAgentify } from "./run-agentify.ts";
import { formatGitHubReadiness, inspectGitHubReadiness } from "./github-readiness.ts";
import { readProjectState } from "./project-state.ts";
import { inspectAgentifyRepoState, type AgentifyRepoState } from "./repo-status.ts";
import { defaultConfigDir } from "./agentify-config.ts";
import { stdin as input } from "node:process";
import { getPremiumTargets, isKnownAgent } from "./agent-registry.ts";
import { promptTargets } from "./target-picker.ts";
import {
  discoverExistingStateDir,
  resolveCanonicalStateDir,
} from "./state-dir.ts";
import type {
  AgentifyTarget,
  RunAgentifyOptions,
} from "./types.ts";

const DEFAULT_TARGETS: ReadonlyArray<AgentifyTarget> = ["codex", "claude", "pi"];

export interface RunAgentifyAppOptions
  extends Omit<RunAgentifyOptions, "targets" | "additionalAgents" | "args"> {
  args: ReadonlyArray<string>;
  targets?: ReadonlyArray<AgentifyTarget>;
  targetsOverride?: ReadonlyArray<string>;
}

function reportGitHubReadiness(options: RunAgentifyAppOptions): void {
  const readiness = options.githubReadinessOverride
    ?? inspectGitHubReadiness({ cwd: options.cwd });
  for (const line of formatGitHubReadiness(readiness)) {
    options.ui.info(line);
  }
}

function attachToInitializedRepo(
  options: RunAgentifyAppOptions,
  repoState: AgentifyRepoState,
): void {
  const configDir = defaultConfigDir();
  const projectState = readProjectState(configDir, options.cwd);
  options.ui.status(`agentify: attached to initialized ${repoState.mode} repo`);
  options.ui.info(`agentify: inspecting state at ${repoState.stateDir}`);
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

function reportPartialRepo(
  options: RunAgentifyAppOptions,
  repoState: AgentifyRepoState,
): void {
  const projectState = readProjectState(defaultConfigDir(), options.cwd);
  options.ui.status("agentify: detected incomplete setup; recovering");
  options.ui.info(`agentify: inspecting state at ${repoState.stateDir}`);
  if (projectState) {
    options.ui.info(
      `agentify: previous run ended with ${projectState.runStatus} at ${projectState.lastRunAt}`,
    );
  }
  if (repoState.missing.length > 0) {
    options.ui.info(`agentify: missing ${repoState.missing.join(", ")}`);
  }
}

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
  const hasExplicitTargetSelection = options.targets !== undefined
    || options.targetsOverride !== undefined;
  let repoState: AgentifyRepoState | null = null;

  if (!hasExplicitTargetSelection) {
    const discovered = discoverExistingStateDir(options.cwd);
    if (discovered) {
      repoState = inspectAgentifyRepoState(options.cwd, configDir, discovered.relativeDir);
      if (discovered.duplicateLegacyDir) {
        options.ui.info(
          `agentify: canonical and legacy state are identical; inspecting ${discovered.relativeDir} and retaining ${discovered.duplicateLegacyDir}.`,
        );
      }
      if (repoState.status === "ready") {
        attachToInitializedRepo(options, repoState);
        return;
      }
    }
  }

  const resolved = await resolveTargets(options);
  const stateResolution = resolveCanonicalStateDir(
    options.cwd,
    resolved.targets,
    resolved.additionalAgents,
  );
  for (const message of stateResolution.guidance) {
    options.ui.info(message);
  }
  if (repoState === null || repoState.stateDir !== stateResolution.sourceRelativeDir) {
    repoState = inspectAgentifyRepoState(
      options.cwd,
      configDir,
      stateResolution.sourceRelativeDir,
    );
  }

  if (repoState.status === "ready") {
    attachToInitializedRepo(options, repoState);
    return;
  }
  if (repoState.status === "partial") {
    reportPartialRepo(options, repoState);
  }

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
