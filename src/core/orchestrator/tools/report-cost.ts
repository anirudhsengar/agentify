// tools/report-cost.ts

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";
import type { AiwBridge } from "../aiw-bridge.ts";

const ReportCostParams = Type.Object({
  include_aiws: Type.Optional(Type.Boolean({
    description: "When true (default), include per-AIW costs in the report.",
  })),
  include_terminal_aiws: Type.Optional(Type.Boolean({
    description: "When true, include completed/failed/aborted AIWs too. Default false (live only).",
  })),
});

export function reportCostTool(manager: AgentManager, aiwBridge: AiwBridge): ToolDefinition {
  return defineTool({
    name: "report_cost",
    label: "Report Fleet Cost",
    description: "Report accumulated cost across the orchestrator session, all sub-agents, and (optionally) all AIWs.",
    parameters: ReportCostParams,
    execute: async (
      _toolCallId: string,
      params: { include_aiws?: boolean; include_terminal_aiws?: boolean },
    ) => {
      const includeAiw = params.include_aiws !== false;
      const includeTerminal = params.include_terminal_aiws === true;
      const aiws = includeAiw
        ? (includeTerminal ? aiwBridge.listAllAiw() : aiwBridge.listLiveAiw())
        : [];
      const cost = manager.reportCost(aiws);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(cost, null, 2),
        }],
        details: { total_cost_usd: cost.total_cost_usd },
      };
    },
  });
}