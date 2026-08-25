import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentifyProvider } from "./provider-auth.ts";
import type { AgentExecutionPolicy } from "./security/execution-policy.ts";

export type { AgentifyProvider } from "./provider-auth.ts";
export type { AgentExecutionPolicy } from "./security/execution-policy.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Named model slot role. `primary` is the default resolver role; every
 * existing `runSession` call site defaults to it. `explorer` is
 * consumed by `spawn_explorer` sub-agents. `lite` is reserved for
 * lightweight work that does not require the primary model.
 */
export type ModelRole = "primary" | "explorer" | "lite";

export interface ModelSlot {
  provider: AgentifyProvider;
  model: string;
}

export interface AgentifyConfig {
  schemaVersion: 1;
  provider?: AgentifyProvider;
  thinkingLevel: ThinkingLevel;
  /** Explicit role assignments. Secondary roles inherit `primary` when unset. */
  models: Partial<Record<ModelRole, ModelSlot>>;
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
  /** Free-form single-line text input (e.g. pasting an OAuth redirect URL). */
  promptText(message: string, placeholder?: string): Promise<string>;
}

export interface AgentRuntimeSessionOptions {
  cwd: string;
  configDir: string;
  config: AgentifyConfig;
  systemPrompt: string;
  userPrompt: string;
  tools: string[];
  /**
   * Required capability boundary. Runtime implementations must validate the
   * requested built-in tools and install filesystem/command guards from this
   * policy before the model receives a prompt.
   */
  executionPolicy: AgentExecutionPolicy;
  customTools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvent?: (event: AgentSessionEvent) => void;
  /**
   * Wall-clock timeout in milliseconds. When exceeded, the session is
   * aborted. Undefined = no timeout.
   */
  timeoutMs?: number;
  /** Abort when the SDK emits no session event for this duration. */
  inactivityTimeoutMs?: number;
  /**
   * Maximum provider output tokens for each request in this session. The
   * runtime applies this at the final provider payload boundary.
   */
  maxOutputTokens?: number;
  /** Use a provider-native specific-tool directive for the recovery tool. */
  forceRequiredToolChoice?: boolean;
  /**
   * Leaves tool_choice unconstrained for this many provider requests so the
   * model can freely use other registered tools, then forces tool_choice to
   * the recovery tool on every request after that (same directive as
   * `forceRequiredToolChoice`). Ignored unless `recoveryPromptIfToolNotCalled`
   * is also set. Mutually exclusive with `forceRequiredToolChoice: true`.
   */
  forceRequiredToolChoiceAfterTurns?: number;
  /**
   * Optional in-session recovery. After the initial prompt ends normally, the
   * runtime sends this follow-up through the same session only when the named
   * tool was never called. This preserves the model's gathered context while
   * avoiding an unbounded retry loop.
   */
  recoveryPromptIfToolNotCalled?: {
    requiredToolName: string;
    userPrompt: string;
    /** Maximum in-session follow-ups after the initial prompt. */
    maxAttempts: number;
    /**
     * Optional owned-state check for recovery after a tool call. This covers
     * sessions that persisted only partial structured progress before ending.
     */
    shouldRecover?: () => boolean;
  };
  /**
   * Which named slot role this session is filling. Defaults to
   * `"primary"` when unset. See `ModelRole`.
   */
  modelRole?: ModelRole;
  /**
   * When set, the runtime constructs a `spawn_explorer` tool bound to
   * the resolved `explorer` slot model and appends it to `customTools`.
   */
  spawnExplorerAgentDir?: string;
  /**
   * Vendor-neutral audit state dir for the `spawn_explorer` tool.
   */
  spawnExplorerStateDir?: string;
}

export interface AgentRuntimeResult {
  turns: number;
  costUsd: number | null;
  aborted: boolean;
  diagnostics?: {
    provider: string | null;
    provider_api: string | null;
    provider_requests: number;
    forced_tool_choice_requests: number;
    capped_output_requests: number;
    configured_output_cap: number | null;
    event_counts: Record<string, number>;
    tool_execution_counts: Record<string, { started: number; ended: number; errors: number }>;
    assistant_stop_reasons: string[];
  };
}

export interface AgentRuntime {
  runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult>;
}

export interface ArtifactWrite {
  path: string;
  /**
   * - `"written"`: Agentify wrote or refreshed the managed file at `path`.
   * - `"skipped"`: the managed file was already current, so no write occurred.
   * - `"alongside"`: the canonical path was occupied by an unmanaged file;
   *   Agentify saved its managed version to `alongsidePath` and left the user's
   *   file untouched.
   */
  action: "written" | "skipped" | "alongside";
  reason?: string;
  /** Set when `action === "alongside"`. Repo-relative path of the
   *  sibling file where Agentify's version was saved. */
  alongsidePath?: string;
}
