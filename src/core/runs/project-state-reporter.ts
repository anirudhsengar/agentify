import { defaultConfigDir } from "../agentify-config.ts";
import { formatGitHubReadiness, inspectGitHubReadiness } from "../github-readiness.ts";
import { writeProjectState } from "../project-state.ts";
import type { RunContext } from "./run-context.ts";

export interface PersistProjectStateParams {
  projectKind: "brownfield" | "greenfield" | "unknown";
  runStatus: "success" | "partial" | "aborted" | "error";
  repoMode: "brownfield" | "greenfield" | "unknown";
  repoStatus: "uninitialized" | "partial" | "ready";
  featureAgentCount: number;
  latestLogPath: string | null;
}

export function getGitHubReadiness(context: RunContext) {
  return context.githubReadinessOverride
    ?? inspectGitHubReadiness({ cwd: context.cwd });
}

export function reportGitHubReadiness(context: RunContext): void {
  const readiness = getGitHubReadiness(context);
  for (const line of formatGitHubReadiness(readiness)) {
    context.ui.info(line);
  }
}

export function persistProjectState(
  context: RunContext,
  params: PersistProjectStateParams,
): void {
  const readiness = getGitHubReadiness(context);
  writeProjectState(defaultConfigDir(), {
    cwd: context.cwd,
    lastRunAt: new Date().toISOString(),
    projectKind: params.projectKind,
    runStatus: params.runStatus,
    repoMode: params.repoMode,
    repoStatus: params.repoStatus,
    featureAgentCount: params.featureAgentCount,
    latestLogPath: params.latestLogPath,
    github: {
      hasGitDirectory: readiness.hasGitDirectory,
      hasGitHubRemote: readiness.hasGitHubRemote,
      ghCliAvailable: readiness.ghCliAvailable,
      originUrl: readiness.originUrl,
    },
  });
}
