// tools/check-agent-status.ts

import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";

const CheckAgentStatusParams = Type.Object({
  agent_id: Type.String({
    description: "The agent_id returned by create_agent.",
  }),
  tail_count: Type.Optional(Type.Number({
    description: "Number of recent events to include. Default: 20.",
  })),
  offset: Type.Optional(Type.Number({
    description: "Skip the first N events. Default: 0.",
  })),
});

export function checkAgentStatusTool(manager: AgentManager): ToolDefinition {
  return defineTool({
    name: "check_agent_status",
    label: "Check Sub-Agent Status",
    description: "Poll a sub-agent's current state and a tail of its events.jsonl log. Returns status, cost, turns, and the most recent events.",
    parameters: CheckAgentStatusParams,
    execute: async (
      _toolCallId: string,
      params: { agent_id: string; tail_count?: number; offset?: number },
    ) => {
      try {
        const status = manager.checkAgentStatus(params.agent_id, {
          tail: params.tail_count ?? 20,
          offset: params.offset ?? 0,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(status, null, 2),
          }],
          details: { agent_id: status.agent_id, status: status.status },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `check_agent_status failed: ${(err as Error).message}`,
          }],
          isError: true,
          details: {  error: (err as Error).message  } as never,
        };
      }
    },
  });
}