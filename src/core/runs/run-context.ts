import type { AgentifyLog } from "../audit/log.ts";
import type { AuditResourceBudget } from "../audit/resource-budget.ts";
import type { RepositoryInstallationPreflight } from "../installer/contracts.ts";
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
  /** Internal aggregate budget shared by coverage and semantic repair. */
  auditResourceBudget?: AuditResourceBudget;
  /** Immutable installer evidence used to seed deterministic audit facts. */
  repositoryPreflight?: RepositoryInstallationPreflight;
}
