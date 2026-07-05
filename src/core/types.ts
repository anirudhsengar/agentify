import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentifyProvider } from "./provider-auth.ts";

export type { AgentifyProvider } from "./provider-auth.ts";

export type AgentifyTarget = "codex" | "claude" | "pi";

export type ProjectKind = "brownfield" | "greenfield" | "ambiguous";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentifyConfig {
  provider?: AgentifyProvider;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface AgentifyUi {
  status(message: string): void;
  info(message: string): void;
  error(message: string): void;
  promptSelect(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string }>,
  ): Promise<string>;
  promptSecret(message: string): Promise<string>;
}

export interface GitHubReadiness {
  hasGitDirectory: boolean;
  hasGitHubRemote: boolean;
  originUrl: string | null;
  ghCliAvailable: boolean;
  guidance: string[];
}

export interface RunAgentifyOptions {
  cwd: string;
  configDir: string;
  ui: AgentifyUi;
  runtime: AgentRuntime;
  targets: ReadonlyArray<AgentifyTarget>;
  configOverride?: AgentifyConfig;
  args?: string;
  signal?: AbortSignal;
  assumeProjectKind?: ProjectKind;
  githubReadinessOverride?: GitHubReadiness;
}

export interface AgentRuntimeSessionOptions {
  cwd: string;
  configDir: string;
  config: AgentifyConfig;
  systemPrompt: string;
  userPrompt: string;
  tools: string[];
  customTools?: ToolDefinition[];
  additionalSkillPaths?: string[];
  signal?: AbortSignal;
  onEvent?: (event: AgentSessionEvent) => void;
  /**
   * Class 4 G4: domain globs the sub-agent is allowed to write.
   * null = no constraint (default). When set, the defense hook blocks
   * `write` / `edit` / `write_file` / `multi_edit` calls whose
   * target path is outside the globs.
   */
  agentDomain?: string[] | null;
  /**
   * When true, the defense hook confines `write`/`edit` to the working
   * directory (repository jail). Set for the builder and greenfield
   * sessions.
   */
  repoJail?: boolean;
  /**
   * Absolute paths of pre-existing user-owned files the session must
   * not overwrite (from the pre-run ownership snapshot).
   */
  protectedPaths?: readonly string[];
  /**
   * Wall-clock timeout in milliseconds. When exceeded, the session is
   * aborted. Undefined = no timeout.
   */
  timeoutMs?: number;
}

export interface AgentRuntimeResult {
  turns: number;
  costUsd: number | null;
  aborted: boolean;
}

export interface AgentRuntime {
  runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult>;
  runGreenfield(options: {
    cwd: string;
    configDir: string;
    config: AgentifyConfig;
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
  }): Promise<AgentRuntimeResult>;
}

export interface ArtifactWrite {
  path: string;
  action: "written" | "skipped" | "conflict";
  reason?: string;
}

export interface ArtifactExportResult {
  target: AgentifyTarget;
  writes: ArtifactWrite[];
}
