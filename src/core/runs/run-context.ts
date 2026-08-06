import type {
  AgentifyConfig,
  AgentifyUi,
  AgentRuntime,
} from "../types.ts";

/** Shared inputs for one classified Agentify run. */
export interface RunContext {
  cwd: string;
  ui: AgentifyUi;
  runtime: AgentRuntime;
  config: AgentifyConfig;
  signal?: AbortSignal;
}
