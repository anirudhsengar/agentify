// tools/escalate-to-orchestrator.ts — sub-agent → orchestrator escalation.
//
// This is the L2 → L0 escalation channel. Sub-agents (depth 1) can
// call this tool to ask the orchestrator a question when they cannot
// proceed locally. The orchestrator's prompt at next turn will list
// open escalations; the orchestrator can then resolve them (update
// ticket with reply) and the sub-agent is unblocked.
//
// Depth-2 attempts (a sub-agent of a sub-agent) are blocked by the
// defense hook before this tool is ever invoked (see defense-hook.ts upgrade).
//
// The mechanism is intentionally simple: tickets are JSON files in
// `<configDir>/orchestrator/escalations/<ticket>.json`. The
// orchestrator reads them at boot and on every chat. No in-memory
// queue — that would couple sub-agent lifetime to orchestrator
// lifetime. The tickets survive orchestrator restarts.

import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  escalationPaths,
  writeEscalationTicket,
  type EscalationTicketRecord,
} from "../paths.ts";
import { appendOrchestratorEvent } from "../paths.ts";

const EscalateParams = Type.Object({
  reason: Type.String({
    description: "Short human-readable reason for the escalation. Logged + surfaced to the user.",
  }),
  question: Type.String({
    description: "The question the orchestrator must answer to unblock you.",
  }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional list of choices; the orchestrator picks one (or replies freely).",
    }),
  ),
  blocking: Type.Optional(
    Type.Boolean({ description: "Default true. Reserved; not yet honored (always blocks).", default: true }),
  ),
});

export interface EscalationHandleOptions {
  configDir: string;
  orchestratorPaths: ReturnType<typeof import("../paths.ts").orchestratorPaths>;
  agentId: string;
  agentName: string;
  orchestratorSessionId: string;
}

/**
 * Per-agent escalation handle. Constructed by `AgentManager` and
 * passed into the sub-agent's `escalate_to_orchestrator` tool.
 */
export class SubagentEscalationHandle {
  private readonly opts: EscalationHandleOptions;

  constructor(opts: EscalationHandleOptions) {
    this.opts = opts;
  }

  /**
   * Open a new escalation ticket. Writes to disk; emits an
   * orchestrator event. Returns the ticket id.
   */
  escalate(args: {
    reason: string;
    question: string;
    options?: string[];
    blocking?: boolean;
  }): EscalationTicketRecord {
    const ticketId = `t-${randomBytes(4).toString("hex")}`;
    const ticket: EscalationTicketRecord = {
      ticket_id: ticketId,
      agent_id: this.opts.agentId,
      agent_name: this.opts.agentName,
      reason: args.reason,
      question: args.question,
      options: args.options ?? [],
      blocking: args.blocking ?? true,
      created_at: new Date().toISOString(),
      resolved_at: null,
      orchestrator_reply: null,
    };
    writeEscalationTicket(escalationPaths(this.opts.configDir, ticketId), ticket);
    appendOrchestratorEvent(this.opts.orchestratorPaths, {
      kind: "escalation_received",
      fields: {
        ticket_id: ticketId,
        agent_id: this.opts.agentId,
        agent_name: this.opts.agentName,
        reason: ticket.reason,
        question: ticket.question,
        options: ticket.options,
      },
    });
    return ticket;
  }
}

export function escalateToOrchestratorTool(handle: SubagentEscalationHandle): ToolDefinition {
  return defineTool({
    name: "escalate_to_orchestrator",
    label: "Escalate to Orchestrator",
    description:
      "Ask the orchestrator agent a question you cannot answer locally. The orchestrator's session will see your question on its next turn and may reply, delegate, or run a workflow on your behalf. Reserved for cases where local knowledge is insufficient and the work would otherwise block.",
    parameters: EscalateParams,
    execute: async (_toolCallId, params: {
      reason: string;
      question: string;
      options?: string[];
      blocking?: boolean;
    }) => {
      const ticket = handle.escalate({
        reason: params.reason,
        question: params.question,
        options: params.options ?? [],
        blocking: params.blocking ?? true,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ticket_id: ticket.ticket_id,
            status: "pending",
            message:
              `Escalation ticket '${ticket.ticket_id}' opened for orchestrator review. ` +
              `The orchestrator will see this on its next turn; check ticket resolution via ` +
              `read_system_logs --ticket ${ticket.ticket_id} (or by polling your prompt's ` +
              `escalations section after the orchestrator replies).`,
            orchestrator_reply: null,
          }, null, 2),
        }],
        details: { ticket_id: ticket.ticket_id, status: "pending" },
      };
    },
  });
}
