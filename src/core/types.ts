import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentifyProvider } from "./provider-auth.ts";

export type { AgentifyProvider } from "./provider-auth.ts";

export type AgentifyTarget = "codex" | "claude" | "pi";

/** Type guard: true iff `value` is one of the three premium harness targets. */
export function isAgentifyTarget(value: string): value is AgentifyTarget {
  return value === "codex" || value === "claude" || value === "pi";
}

export type ProjectKind = "brownfield" | "greenfield" | "ambiguous";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Named model slot role. Phase 2+ (ADR 0017). `primary` is the default
 * resolver role; every existing `runSession` call site defaults to it.
 * `explorer` is consumed by `spawn_explorer` sub-agents. `lite` is
 * reserved for future lightweight judgment-call surfaces — a cheaper
 * model used for non-primary work.
 */
export type ModelRole = "primary" | "explorer" | "lite";

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
  /**
   * Optional record of previously-saved premium target selections.
   * Loaded for backward compatibility with anyone who hand-wrote a
   * `targets` field, but the interactive picker does NOT write this
   * field — every fresh run re-prompts the user (see ADR 0018).
   */
  targets?: ReadonlyArray<AgentifyTarget>;
}

export interface AgentifyUi {
  status(message: string): void;
  info(message: string): void;
  error(message: string): void;
  promptSelect(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string }>,
  ): Promise<string>;
  promptMultiSelect(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string; hint?: string }>,
  ): Promise<ReadonlyArray<string>>;
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
  /** Premium harness targets with full exporters (Codex / Claude / Pi). */
  targets: ReadonlyArray<AgentifyTarget>;
  /**
   * Non-premium agents (Cursor / OpenCode / Windsurf / etc.) selected
   * via the interactive picker. These get only the generic skill-pack
   * writer — no feature-agent exports, no `CLAUDE.md`. Empty by
   * default; the picker populates it when the user picks non-premium
   * agents.
   */
  additionalAgents?: ReadonlyArray<string>;
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
  /**
   * Audit state dir for the `spawn_explorer` tool (ADR 0020). When the
   * builder audit is wired to a provider-scoped state dir
   * (`.claude/agentify/`, `.agents/agentify/`, `.pi/agentify/`), the
   * tool writes its sub-agent logs there and emits a budget-recovery
   * message that names the right path. Falls back to the legacy
   * `.pi/agentify/` location when unset.
   */
  spawnExplorerStateDir?: string;
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
  /**
   * - `"written"`: agentify wrote (or re-wrote with new content) the
   *   file at `path`.
   * - `"skipped"`: the file at `path` was already up to date (or
   *   the user explicitly chose to keep a user-owned file with
   *   no alongside save).
   * - `"conflict"`: the canonical path is occupied by a user-owned
   *   file and the policy resolved to `"abort"`. The file is left
   *   untouched; the user must resolve via `.agentifyrc` or remove
   *   their file.
   * - `"alongside"`: the canonical path is occupied by a user-owned
   *   file; agentify's version was saved to `alongsidePath` (a
   *   sibling with a `.agentify<ext>` suffix) and the user's file
   *   was left untouched.
   */
  action: "written" | "skipped" | "conflict" | "alongside";
  reason?: string;
  /** Set when `action === "alongside"`. Repo-relative path of the
   *  sibling file where agentify's version was saved. */
  alongsidePath?: string;
}

export interface ArtifactExportResult {
  /**
   * The agent identifier this result is for. Premium exporters
   * (`codex` / `claude` / `pi`) set this to the matching
   * `AgentifyTarget`; the generic skill-pack writer sets it to the
   * registry `AgentId` (e.g. `cursor`, `opencode`). Used only for
   * metadata / status messages — never for dispatch.
   */
  target: AgentifyTarget | string;
  writes: ArtifactWrite[];
}
