// tools/index.ts — the 10 typed management tools the orchestrator exposes.
//
// Each tool is a `ToolDefinition` (per `@earendil-works/pi-coding-agent`'s
// `defineTool`). The orchestrator session is created with these 10
// customTools in its allowlist; the orchestrator has NO Pi built-ins.
//
// The 10 tools (from `principles/13-agentic-layer.md` the orchestrator +
// `LESSONS/LEARNINGS3.md` § 11.5):
//
//   create_agent, list_agents, command_agent, check_agent_status,
//   delete_agent, interrupt_agent, read_system_logs, report_cost,
//   start_aiw, check_aiw
//
// The tools dispatch to the AgentManager (sub-agent CRUD) and the
// AiwBridge (AIW CRUD). The host instantiates both and passes them
// into `createManagementTools({ agentManager, aiwBridge })`.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";
import type { AiwBridge } from "../aiw-bridge.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { createAgentTool } from "./create-agent.ts";
import { listAgentsTool } from "./list-agents.ts";
import { commandAgentTool } from "./command-agent.ts";
import { checkAgentStatusTool } from "./check-agent-status.ts";
import { deleteAgentTool } from "./delete-agent.ts";
import { interruptAgentTool } from "./interrupt-agent.ts";
import { readSystemLogsTool } from "./read-system-logs.ts";
import { reportCostTool } from "./report-cost.ts";
import { startAiwTool } from "./start-aiw.ts";
import { checkAiwTool } from "./check-aiw.ts";
import { runWorkflowTool } from "./run-workflow.ts";
import { composeWorkflowTool } from "./compose-workflow.ts";
import { checkWorkflowTool } from "./check-workflow.ts";
import { streamAgentLogsTool } from "./stream-agent-logs.ts";
import type { WorkflowRunner } from "../workflow-runner.ts";
import type { WorkflowRegistry } from "../workflow-registry.ts";

export interface ManagementToolsOptions {
  agentManager: AgentManager;
  aiwBridge: AiwBridge;
  workflowRegistry: WorkflowRegistry;
  workflowRunner: WorkflowRunner;
  configDir: string;
  projectWorkflowsDir: string | null;
}

/**
 * Return the canonical list of the 13 management tool names (G1 10 + G2 3 workflows + 1 stream).
 * Mirrors `principles/13-agentic-layer.md` orchestrator workflows.
 */
export const MANAGEMENT_TOOL_NAMES = [
  // G1 (10)
  "create_agent",
  "list_agents",
  "command_agent",
  "check_agent_status",
  "delete_agent",
  "interrupt_agent",
  "read_system_logs",
  "report_cost",
  "start_aiw",
  "check_aiw",
  // G2 (4)
  "run_workflow",
  "compose_workflow",
  "check_workflow",
  "stream_agent_logs",
] as const;

export type ManagementToolName = (typeof MANAGEMENT_TOOL_NAMES)[number];

/**
 * Backward-compat alias for the G1 list. Existing tests that reference
 * MANAGEMENT_TOOL_NAMES_G1 still pass; new code should use the
 * 14-element list above (NOTE: 10 G1 + 4 G2 = 14, plan §3.5 said 13;
 * 13 = 10 G1 + 3 G2 - the 4th is `stream_agent_logs` which the plan
 * lists separately).
 */
export const MANAGEMENT_TOOL_NAMES_G1 = [
  "create_agent",
  "list_agents",
  "command_agent",
  "check_agent_status",
  "delete_agent",
  "interrupt_agent",
  "read_system_logs",
  "report_cost",
  "start_aiw",
  "check_aiw",
] as const;

/**
 * Build the 14 ToolDefinitions for orchestrator workflows. The orchestrator
 * host passes these into `runtime.runSession({ tools: [], customTools: [...] })`.
 */
export function createManagementTools(opts: ManagementToolsOptions): ToolDefinition[] {
  return [
    // G1 (10)
    createAgentTool(opts.agentManager),
    listAgentsTool(opts.agentManager),
    commandAgentTool(opts.agentManager),
    checkAgentStatusTool(opts.agentManager),
    deleteAgentTool(opts.agentManager),
    interruptAgentTool(opts.agentManager),
    readSystemLogsTool(opts.agentManager),
    reportCostTool(opts.agentManager, opts.aiwBridge),
    startAiwTool(opts.aiwBridge),
    checkAiwTool(opts.aiwBridge),
    // G2 (4)
    runWorkflowTool(opts.workflowRegistry, opts.workflowRunner),
    composeWorkflowTool(opts.workflowRegistry, opts.workflowRunner, opts.projectWorkflowsDir),
    checkWorkflowTool(opts.workflowRunner),
    streamAgentLogsTool(opts.configDir),
  ];
}

/**
 * Re-export the StringEnum + Type helpers so individual tool files
 * can import from a single place.
 */
export { StringEnum, Type, defineTool };