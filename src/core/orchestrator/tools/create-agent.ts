// tools/create-agent.ts

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";

const ModelChoice = StringEnum(
  ["inherit", "haiku", "sonnet", "opus"] as const,
  { default: "inherit" },
);

const CreateAgentParams = Type.Object({
  name: Type.String({
    description: "Logical name for the agent (e.g. 'tester', 'scout-1'). Multiple creates of the same name coexist via the random suffix on agent_id.",
  }),
  system_prompt: Type.Optional(Type.String({
    description: "Inline system prompt. Use this OR subagent_template. Required if subagent_template is not provided.",
  })),
  subagent_template: Type.Optional(Type.String({
    description: "Registry key (e.g. 'scout-report-suggest'). When provided, the registry supplies system_prompt, tools, model, and expertise_path.",
  })),
  model: Type.Optional(ModelChoice),
  user_prompt: Type.String({
    description: "The first prompt sent to the sub-agent.",
  }),
  tools: Type.Optional(Type.Array(Type.String(), {
    description: "Tool allowlist. Default: from template, else ['read']. The 'create_agent' tool is always filtered out.",
  })),
  domain: Type.Optional(Type.Array(Type.String(), {
    description: "Path globs the sub-agent may write to. Reserved for orchestrator workflows (domain locking).",
  })),
});

export function createAgentTool(manager: AgentManager): ToolDefinition {
  return defineTool({
    name: "create_agent",
    label: "Create Sub-Agent",
    description: "Spawn a new managed sub-agent session. Returns immediately with agent_id and status=running; the agent runs in the background. Poll with check_agent_status to know when it finishes. Use list_agents to see all agents.",
    parameters: CreateAgentParams,
    execute: async (
      _toolCallId: string,
      params: {
        name: string;
        system_prompt?: string;
        subagent_template?: string;
        model?: "inherit" | "haiku" | "sonnet" | "opus";
        user_prompt: string;
        tools?: string[];
        domain?: string[];
      },
    ) => {
      try {
        const result = await manager.createAgent({
          name: params.name,
          system_prompt: params.system_prompt,
          subagent_template: params.subagent_template,
          model: params.model ?? null,
          user_prompt: params.user_prompt,
          tools: params.tools,
          domain: params.domain,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agent_id: result.agent_id,
              name: result.name,
              status: result.status,
              started_at: result.started_at,
              message: `Agent ${result.name} created with id ${result.agent_id}. Status: ${result.status}. Use check_agent_status to poll.`,
            }, null, 2),
          }],
          details: { agent_id: result.agent_id, status: result.status },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `create_agent failed: ${(err as Error).message}`,
          }],
          isError: true,
          details: {  error: (err as Error).message  } as never,
        };
      }
    },
  });
}