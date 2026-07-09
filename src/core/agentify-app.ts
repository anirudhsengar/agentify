import { runAgentify } from "./run-agentify.ts";
import { formatGitHubReadiness, inspectGitHubReadiness } from "./github-readiness.ts";
import { readProjectState } from "./project-state.ts";
import { inspectAgentifyRepoState } from "./repo-status.ts";
import { defaultConfigDir } from "./agentify-config.ts";
import type { AgentifyTarget, RunAgentifyOptions } from "./types.ts";

const DEFAULT_TARGETS: ReadonlyArray<AgentifyTarget> = ["codex", "claude", "pi"];

export interface RunAgentifyAppOptions
  extends Omit<RunAgentifyOptions, "targets" | "args"> {
  args: ReadonlyArray<string>;
  targets?: ReadonlyArray<AgentifyTarget>;
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

export async function runAgentifyApp(options: RunAgentifyAppOptions): Promise<void> {
  if (options.args.length > 0) {
    const first = options.args[0];
    throw new Error(
      `agentify does not accept '${first}'. Known subcommands: login, logout, models. Run \`agentify --help\` for usage.`,
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

  await runAgentify({
    cwd: options.cwd,
    ui: options.ui,
    runtime: options.runtime,
    targets: options.targets ?? DEFAULT_TARGETS,
    signal: options.signal,
    mode: options.mode,
    configOverride: options.configOverride,
    githubReadinessOverride: options.githubReadinessOverride,
  });
}