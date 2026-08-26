import type { AgentifyLog } from "../audit/log.ts";
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
  /** Internal ownership handoff used to keep coverage and semantic repair in one log. */
  auditLog?: AgentifyLog;
  deferAuditLogCompletion?: boolean;
}
