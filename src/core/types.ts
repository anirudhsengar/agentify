import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentifyProvider } from "./provider-auth.ts";

export type { AgentifyProvider } from "./provider-auth.ts";

export type AgentifyTarget = "codex" | "claude" | "pi";

export type ProjectKind = "brownfield" | "greenfield" | "ambiguous";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Named model slot role. Phase 2+ (ADR 0017). `primary` is the default
 * resolver role; every existing `runSession` call site defaults to it.
 * `explorer` is consumed by `spawn_explorer` sub-agents. `scoring` is
 * reserved for future lightweight judgment-call surfaces.
 */
export type ModelRole = "primary" | "explorer" | "scoring";

export interface ModelSlot {
  provider: AgentifyProvider;
  model: string;
}

export interface AgentifyConfig {
  provider?: AgentifyProvider;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * Per-role model overrides. When a slot is unset, the resolver falls
   * back to `primary`, then to the legacy `provider`/`model` fields,
   * then to `registry.getAvailable()[0]` (terminal default). The
   * resolver NEVER silently picks a "weaker" model over an explicit
   * user choice.
   */
  modelsByRole?: Partial<Record<ModelRole, ModelSlot>>;
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
  ui: AgentifyUi;
  runtime: AgentRuntime;
  targets: ReadonlyArray<AgentifyTarget>;
  configOverride?: AgentifyConfig;
  args?: string;
  signal?: AbortSignal;
  /**
   * Skip project-kind classification for ambiguous repos. Values are
   * `"brownfield"` or `"greenfield"`. Surfaced to users as `--mode`.
   */
  mode?: "brownfield" | "greenfield";
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
  /**
   * Which named slot role this session is filling. Defaults to
   * `"primary"` when unset. See `ModelRole` and ADR 0017.
   */
  modelRole?: ModelRole;
  /**
   * When set, the runtime constructs a `spawn_explorer` tool bound to
   * the resolved `explorer` slot model and appends it to `customTools`.
   * ADR 0017.
   */
  spawnExplorerAgentDir?: string;
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
