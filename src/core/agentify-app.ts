import { runAgentify } from "./run-agentify.ts";
import { formatGitHubReadiness, inspectGitHubReadiness } from "./github-readiness.ts";
import { readProjectState } from "./project-state.ts";
import { inspectAgentifyRepoState, type AgentifyRepoState } from "./repo-status.ts";
import { defaultConfigDir } from "./agentify-config.ts";
import { stdin as input } from "node:process";
import { getPremiumTargets, isKnownAgent } from "./agent-registry.ts";
import { promptTargets, resolveSkillsDirsToAgents } from "./target-picker.ts";
import {
  discoverExistingStateDir,
  resolveCanonicalStateDir,
} from "./state-dir.ts";
import { listInterruptedStateTransactions } from "./state-transaction.ts";
import { inspectGitSyncStatus, pullLatestBranch } from "./git-sync.ts";
import type {
  AgentifyTarget,
  RunAgentifyOptions,
} from "./types.ts";

const DEFAULT_TARGETS: ReadonlyArray<AgentifyTarget> = ["codex", "claude", "pi"];
type ExistingStateChoice = "resume" | "fresh";

export interface RunAgentifyAppOptions
  extends Omit<RunAgentifyOptions, "targets" | "additionalAgents" | "args"> {
  args: ReadonlyArray<string>;
  targets?: ReadonlyArray<AgentifyTarget>;
  targetsOverride?: ReadonlyArray<string>;
  /** Explicit approval for a retained-source provider switch migration. */
  migrateState?: boolean;
  /** Explicit approval for the optional GitHub Actions runtime. */
  githubRuntime?: boolean;
}

async function chooseGitHubRuntime(
  options: RunAgentifyAppOptions,
  repoState: AgentifyRepoState,
): Promise<boolean> {
  if (options.githubRuntime === true) return true;
  if (!input.isTTY) return false;
  const installed = repoState.found.some((path) => path.startsWith(".github/") || path === "SETUP.md");
  const choice = await options.ui.promptSelect(
    installed
      ? "Agentify found an existing GitHub runtime. Refresh its managed files?"
      : "Install Agentify's optional GitHub Actions runtime? It adds workflows, scripts, labels, and CI validation.",
    installed
      ? [
        { label: "Keep existing runtime unchanged", value: "skip" },
        { label: "Refresh GitHub runtime", value: "install" },
      ]
      : [
        { label: "Skip GitHub runtime for now", value: "skip" },
        { label: "Install GitHub runtime", value: "install" },
      ],
  );
  return choice === "install";
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

async function shouldResumeInitializedRepo(
  options: RunAgentifyAppOptions,
  repoState: AgentifyRepoState,
): Promise<boolean> {
  // Scripted invocations retain their current deterministic behavior.
  // Interactive users can explicitly choose whether to reuse or replace
  // completed or incomplete Agentify state.
  if (!input.isTTY) return true;

  const isPartial = repoState.status === "partial";
  const choice = await options.ui.promptSelect(
    isPartial
      ? `Agentify found an incomplete ${repoState.mode} run in this repository. What would you like to do?`
      : `Agentify found a completed ${repoState.mode} run in this repository. What would you like to do?`,
    [
      {
        label: isPartial
          ? "Resume recovery — continue from the existing Agentify state"
          : "Resume previous setup — inspect the saved state and GitHub readiness",
        value: "resume",
      },
      {
        label: "Start a fresh run — regenerate Agentify-managed artifacts",
        value: "fresh",
      },
    ],
  );
  return choice !== "fresh";
}

async function chooseInterruptedTransactionAction(
  options: RunAgentifyAppOptions,
  transactionIds: ReadonlyArray<string>,
): Promise<ExistingStateChoice | null> {
  if (!input.isTTY || transactionIds.length === 0) return null;
  return options.ui.promptSelect(
    `Agentify found ${transactionIds.length === 1 ? "an" : `${transactionIds.length}`} interrupted state transaction${transactionIds.length === 1 ? "" : "s"}. What would you like to do?`,
    [
      {
        label: "Resume recovery — restore the interrupted Agentify state",
        value: "resume",
      },
      {
        label: "Start a fresh run — recover safely, then regenerate managed artifacts",
        value: "fresh",
      },
    ],
  ) as Promise<ExistingStateChoice>;
}

async function offerPullLatestBranch(options: RunAgentifyAppOptions): Promise<void> {
  if (!input.isTTY) return;
  const sync = inspectGitSyncStatus(options.cwd);
  if (sync.kind !== "behind") return;
  const choice = await options.ui.promptSelect(
    `Your branch is ${sync.behind} commit${sync.behind === 1 ? "" : "s"} behind ${sync.upstream}. Pull before Agentify runs?`,
    [
      { label: "Pull latest changes (fast-forward only)", value: "pull" },
      { label: "Continue without pulling", value: "skip" },
    ],
  );
  if (choice !== "pull") {
    options.ui.info("agentify: continuing on the current branch without pulling remote changes.");
    return;
  }
  const pulled = pullLatestBranch(options.cwd);
  if (!pulled.ok) {
    throw new Error(`could not fast-forward the current branch: ${pulled.message}`);
  }
  options.ui.status("agentify: pulled the latest remote changes");
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

  const selectedDirs = await promptTargets(options.ui);
  const resolved = resolveSkillsDirsToAgents(selectedDirs);
  return {
    targets: resolved.targets as ReadonlyArray<AgentifyTarget>,
    additionalAgents: resolved.additionalAgents,
  };
}

export async function runAgentifyApp(options: RunAgentifyAppOptions): Promise<void> {
  if (options.args.length > 0) {
    const first = options.args[0];
    throw new Error(
      `agentify does not accept '${first}'. Known subcommands: login, logout, models, revert. Run \`agentify --help\` for usage.`,
    );
  }

  await offerPullLatestBranch(options);
  const configDir = defaultConfigDir();
  const resolved = await resolveTargets(options);
  const interruptedTransactionChoice = await chooseInterruptedTransactionAction(
    options,
    listInterruptedStateTransactions(options.cwd),
  );
  const hasExplicitTargets = options.targets !== undefined
    || options.targetsOverride !== undefined;
  if (!hasExplicitTargets && !input.isTTY) {
    const discovered = discoverExistingStateDir(options.cwd);
    if (discovered) {
      const discoveredState = inspectAgentifyRepoState(
        options.cwd,
        configDir,
        discovered.relativeDir,
      );
      if (discoveredState.status === "ready") {
        if (await shouldResumeInitializedRepo(options, discoveredState)) {
          attachToInitializedRepo(options, discoveredState);
          return;
        }
        options.ui.status("agentify: starting a fresh run from the existing repository");
      }
    }
  }
  const stateResolution = resolveCanonicalStateDir(
    options.cwd,
    resolved.targets,
    resolved.additionalAgents,
    { allowProviderSwitchMigration: options.migrateState === true && hasExplicitTargets },
  );
  for (const message of stateResolution.guidance) {
    options.ui.info(message);
  }
  const repoState = inspectAgentifyRepoState(
    options.cwd,
    configDir,
    stateResolution.relativeDir,
  );

  if (repoState.status === "ready") {
    if (
      interruptedTransactionChoice === "resume"
      || (interruptedTransactionChoice === null && await shouldResumeInitializedRepo(options, repoState))
    ) {
      attachToInitializedRepo(options, repoState);
      return;
    }
    options.ui.status("agentify: starting a fresh run from the existing repository");
  }
  if (repoState.status === "partial") {
    if (
      interruptedTransactionChoice === "resume"
      || (interruptedTransactionChoice === null && await shouldResumeInitializedRepo(options, repoState))
    ) {
      reportPartialRepo(options, repoState);
    } else {
      options.ui.status("agentify: starting a fresh run from the existing repository");
    }
  }

  const githubRuntime = await chooseGitHubRuntime(options, repoState);

  await runAgentify({
    cwd: options.cwd,
    ui: options.ui,
    runtime: options.runtime,
    targets: resolved.targets,
    additionalAgents: resolved.additionalAgents,
    signal: options.signal,
    mode: options.mode,
    githubRuntime,
    configOverride: options.configOverride,
    githubReadinessOverride: options.githubReadinessOverride,
  });
}
