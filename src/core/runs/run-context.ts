import type { AuditArtifactSnapshot } from "../generation/artifact-snapshot.ts";
import type {
  AgentifyConfig,
  AgentifyTarget,
  AgentifyUi,
  AgentRuntime,
  GitHubReadiness,
  RunAgentifyOptions,
} from "../types.ts";

/** Shared inputs for one classified Agentify run. */
export interface RunContext {
  cwd: string;
  ui: AgentifyUi;
  runtime: AgentRuntime;
  targets: ReadonlyArray<AgentifyTarget>;
  additionalAgents?: ReadonlyArray<string>;
  config: AgentifyConfig;
  args?: string;
  signal?: AbortSignal;
  githubReadinessOverride?: GitHubReadiness;
}

/** Shared generated-surface snapshot contract used by both run modes. */
export type RunArtifactSnapshot = AuditArtifactSnapshot;

export function createRunContext(
  options: RunAgentifyOptions,
  config: AgentifyConfig,
): RunContext {
  return {
    cwd: options.cwd,
    ui: options.ui,
    runtime: options.runtime,
    targets: options.targets,
    additionalAgents: options.additionalAgents,
    config,
    args: options.args,
    signal: options.signal,
    githubReadinessOverride: options.githubReadinessOverride,
  };
}
