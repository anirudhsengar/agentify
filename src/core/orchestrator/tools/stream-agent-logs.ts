// tools/stream-agent-logs.ts — the orchestrator's "dial into any one
// of its logs" tool. Returns up to N events from a live sub-agent;
// bounded by timeout. Implementation strategy: read the agent's
// events.jsonl (already persisted per-event). The "open stream"
// pattern is approximated by a single batched tail with a timeout;
// streaming subscribers can re-call with `since_event_n` to get
// the next batch.

import * as fs from "node:fs";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  agentPaths,
  readAgentEvents,
} from "../paths.ts";
import { appendSummaryDigest } from "../summarizer.ts";

const StreamAgentLogsParams = Type.Object({
  agent_id: Type.String({ description: "Sub-agent id (e.g. 'tester-a1b')." }),
  since_event_n: Type.Optional(
    Type.Number({
      description: "If set, only events after this index are returned (0-based; supports polling).",
    }),
  ),
  max_events: Type.Optional(
    Type.Number({ description: "Cap on returned events (default 50)." }),
  ),
  include_summary: Type.Optional(
    Type.Boolean({ description: "Also include one-line digests." }),
  ),
});

export function streamAgentLogsTool(configDir: string): ToolDefinition {
  return defineTool({
    name: "stream_agent_logs",
    label: "Stream Agent Logs",
    description:
      "Tail the events.jsonl of a live (or finished) sub-agent. Returns events after `since_event_n` (default 0). The orchestrator can re-call with the returned `next_event_n` to follow a running agent live ('we can dial into any one of its logs').",
    parameters: StreamAgentLogsParams,
    execute: async (_toolCallId, params: {
      agent_id: string;
      since_event_n?: number;
      max_events?: number;
      include_summary?: boolean;
    }) => {
      const paths = agentPaths(configDir, params.agent_id);
      if (!fs.existsSync(paths.eventsFile)) {
        return {
          content: [{
            type: "text",
            text: `stream_agent_logs: agent '${params.agent_id}' has no events.jsonl (no live or finished agent?).`,
          }],
          isError: true,
          details: { error: "not_found", agent_id: params.agent_id } as never,
        };
      }
      const allEvents = readAgentEvents(paths);
      const since = params.since_event_n ?? 0;
      const slice = since > 0 ? allEvents.slice(since) : allEvents;
      const cap = params.max_events ?? 50;
      const out = slice.slice(0, cap);
      // One-line digests: append a tiny in-memory stream for the orchestrator prompt.
      if (params.include_summary) {
        for (const evt of out) {
          appendSummaryDigest(paths.executionLog, {
            kind: evt.kind,
            digest: `[${params.agent_id}] ${evt.kind}`,
          });
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            agent_id: params.agent_id,
            since_event_n: since,
            returned: out.length,
            next_event_n: since + out.length,
            events: out,
            final_event_n: allEvents.length,
          }, null, 2),
        }],
        details: { agent_id: params.agent_id, returned: out.length, next_event_n: since + out.length },
      };
    },
  });
}
