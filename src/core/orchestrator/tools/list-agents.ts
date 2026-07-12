// tools/list-agents.ts

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";

const AgentStatusFilter = StringEnum(
  ["queued", "running", "completed", "failed", "aborted", "interrupted", "deleted"] as const,
);

const ListAgentsParams = Type.Object({
  status_filter: Type.Optional(Type.Array(AgentStatusFilter, {
    description: "Filter by status (e.g. ['running', 'queued']). Default: all statuses.",
  })),
  include_deleted: Type.Optional(Type.Boolean({
    description: "When true, include agents with status='deleted'. Default false.",
  })),
});

export function listAgentsTool(manager: AgentManager): ToolDefinition {
  return defineTool({
    name: "list_agents",
    label: "List Sub-Agents",
    description: "List all managed sub-agents. Optionally filter by status. Default excludes deleted agents.",
    parameters: ListAgentsParams,
    execute: async (
      _toolCallId: string,
      params: { status_filter?: string[]; include_deleted?: boolean },
    ) => {
      const states = manager.listAgents(
        params.status_filter && params.status_filter.length > 0
          ? { status: params.status_filter as never }
          : undefined,
      );
      const filtered = params.include_deleted === false
        ? states.filter((s) => s.status !== "deleted")
        : states;
      const summary = filtered.map((s) => ({
        agent_id: s.agent_id,
        name: s.name,
        status: s.status,
        turns: s.turns,
        cost_usd: s.cost_usd,
        started_at: s.started_at,
        ended_at: s.ended_at,
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: summary.length,
            agents: summary,
          }, null, 2),
        }],
        details: { count: summary.length },
      };
    },
  });
}