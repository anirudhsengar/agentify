// tools/check-aiw.ts

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AiwBridge } from "../aiw-bridge.ts";

const CheckAiwParams = Type.Object({
  aiw_id: Type.String({
    description: "The aiw_id returned by start_aiw.",
  }),
  tail_count: Type.Optional(Type.Number({
    description: "Number of recent events to include. Default: 50.",
  })),
  event_type: Type.Optional(Type.String({
    description: "Substring filter on event kind (e.g. 'phase_started', 'agent_event').",
  })),
  include_step_details: Type.Optional(Type.Boolean({
    description: "When true, include the full per-phase record. Default true.",
  })),
});

export function checkAiwTool(bridge: AiwBridge): ToolDefinition {
  return defineTool({
    name: "check_aiw",
    label: "Check AIW Status",
    description: "Poll an AIW's current state, per-phase progress, and a tail of its events.jsonl log.",
    parameters: CheckAiwParams,
    execute: async (
      _toolCallId: string,
      params: {
        aiw_id: string;
        tail_count?: number;
        event_type?: string;
        include_step_details?: boolean;
      },
    ) => {
      try {
        const result = bridge.checkAiw(params.aiw_id, {
          tail_count: params.tail_count ?? 50,
          event_type: params.event_type,
          include_step_details: params.include_step_details !== false,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2),
          }],
          details: { aiw_id: result.aiw_id, status: result.status },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `check_aiw failed: ${(err as Error).message}`,
          }],
          isError: true,
          details: {  error: (err as Error).message  } as never,
        };
      }
    },
  });
}