// tools/command-agent.ts

import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";

const CommandAgentParams = Type.Object({
  agent_id: Type.String({
    description: "The agent_id returned by create_agent.",
  }),
  prompt: Type.String({
    description: "The follow-up prompt to send to the agent.",
  }),
});

export function commandAgentTool(manager: AgentManager): ToolDefinition {
  return defineTool({
    name: "command_agent",
    label: "Send Command to Sub-Agent",
    description: "Send a follow-up prompt to an existing sub-agent. The agent must still be in the live registry (status=running or status=queued). Use check_agent_status to verify it's still alive.",
    parameters: CommandAgentParams,
    execute: async (
      _toolCallId: string,
      params: { agent_id: string; prompt: string },
    ) => {
      try {
        const result = await manager.commandAgent({
          agent_id: params.agent_id,
          prompt: params.prompt,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agent_id: result.agent_id,
              name: result.name,
              status: result.status,
              message: `Command sent to agent ${result.name} (${result.agent_id}).`,
            }, null, 2),
          }],
          details: { agent_id: result.agent_id, status: result.status },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `command_agent failed: ${(err as Error).message}`,
          }],
          isError: true,
          details: {  error: (err as Error).message  } as never,
        };
      }
    },
  });
}