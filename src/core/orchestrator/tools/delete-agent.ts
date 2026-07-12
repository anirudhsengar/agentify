// tools/delete-agent.ts

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";

const DeleteAgentParams = Type.Object({
  agent_id: Type.String({
    description: "The agent_id returned by create_agent.",
  }),
  archive: Type.Optional(Type.Boolean({
    description: "When true (default), move the agent directory to _archive/ for audit. When false, hard-delete it.",
  })),
});

export function deleteAgentTool(manager: AgentManager): ToolDefinition {
  return defineTool({
    name: "delete_agent",
    label: "Delete Sub-Agent",
    description: "Stop a sub-agent (if still running) and remove its directory. By default, archives the agent under _archive/ for audit. Pass archive=false to hard-delete.",
    parameters: DeleteAgentParams,
    execute: async (
      _toolCallId: string,
      params: { agent_id: string; archive?: boolean },
    ) => {
      try {
        const result = await manager.deleteAgent(params.agent_id, {
          archive: params.archive !== false,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agent_id: params.agent_id,
              archived: result.archived,
              message: result.archived
                ? `Agent ${params.agent_id} archived under _archive/.`
                : `Agent ${params.agent_id} hard-deleted.`,
            }, null, 2),
          }],
          details: { agent_id: params.agent_id, archived: result.archived },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `delete_agent failed: ${(err as Error).message}`,
          }],
          isError: true,
          details: {  error: (err as Error).message  } as never,
        };
      }
    },
  });
}