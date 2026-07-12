// tools/interrupt-agent.ts

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";

const InterruptAgentParams = Type.Object({
  agent_id: Type.String({
    description: "The agent_id returned by create_agent.",
  }),
  hard: Type.Optional(Type.Boolean({
    description: "When true, force-abort the agent's session immediately. When false (default), signal the AbortController and let the agent finish its current turn.",
  })),
});

export function interruptAgentTool(manager: AgentManager): ToolDefinition {
  return defineTool({
    name: "interrupt_agent",
    label: "Interrupt Sub-Agent",
    description: "Stop a running sub-agent. Soft (default): signal the AbortController; the agent finishes its current turn and reports interrupted. Hard: force-abort the session immediately.",
    parameters: InterruptAgentParams,
    execute: async (
      _toolCallId: string,
      params: { agent_id: string; hard?: boolean },
    ) => {
      try {
        const result = await manager.interruptAgent(params.agent_id, {
          hard: params.hard === true,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agent_id: params.agent_id,
              kind: result.kind,
              message: `Agent ${params.agent_id} interrupt (${result.kind}) issued.`,
            }, null, 2),
          }],
          details: { agent_id: params.agent_id, kind: result.kind },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `interrupt_agent failed: ${(err as Error).message}`,
          }],
          isError: true,
          details: {  error: (err as Error).message  } as never,
        };
      }
    },
  });
}