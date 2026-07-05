// tools/read-system-logs.ts

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";

const LogLevel = StringEnum(
  ["info", "warn", "error", "debug"] as const,
);

const ReadSystemLogsParams = Type.Object({
  agent_id: Type.Optional(Type.String({
    description: "Tail a specific sub-agent's events.jsonl. When omitted, returns the orchestrator-level events.",
  })),
  tail_count: Type.Optional(Type.Number({
    description: "Number of recent events to include. Default: 50.",
  })),
  offset: Type.Optional(Type.Number({
    description: "Skip the first N events. Default: 0.",
  })),
  event_type: Type.Optional(Type.String({
    description: "Substring filter on event kind (e.g. 'message_end', 'tool_execution').",
  })),
  level: Type.Optional(LogLevel),
});

export function readSystemLogsTool(manager: AgentManager): ToolDefinition {
  return defineTool({
    name: "read_system_logs",
    label: "Read System Logs",
    description: "Tail the orchestrator's or a specific agent's events.jsonl log. Filter by event_type or level.",
    parameters: ReadSystemLogsParams,
    execute: async (
      _toolCallId: string,
      params: {
        agent_id?: string;
        tail_count?: number;
        offset?: number;
        event_type?: string;
        level?: "info" | "warn" | "error" | "debug";
      },
    ) => {
      try {
        const logs = manager.readSystemLogs({
          agent_id: params.agent_id,
          tail: params.tail_count ?? 50,
          offset: params.offset ?? 0,
          event_type: params.event_type,
          level: params.level,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(logs, null, 2),
          }],
          details: { source: logs.source, agent_id: logs.agent_id, total: logs.total },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `read_system_logs failed: ${(err as Error).message}`,
          }],
          isError: true,
          details: {  error: (err as Error).message  } as never,
        };
      }
    },
  });
}