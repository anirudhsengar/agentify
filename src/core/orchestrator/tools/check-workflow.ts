// tools/check-workflow.ts

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowRunner } from "../workflow-runner.ts";

const CheckWorkflowParams = Type.Object({
  workflow_run_id: Type.String({ description: "Run id returned by run_workflow or compose_workflow." }),
  tail: Type.Optional(
    Type.Number({ description: "If set, includes the last N events in addition to status." }),
  ),
  event_type: Type.Optional(
    Type.String({ description: "Filter events by substring on `kind`." }),
  ),
  include_summary: Type.Optional(
    Type.Boolean({ description: "If true, includes a tail of the summary digest stream." }),
  ),
  summary_tail: Type.Optional(
    Type.Number({ description: "Limit the summary tail to N digests (default 20)." }),
  ),
});

export function checkWorkflowTool(runner: WorkflowRunner): ToolDefinition {
  return defineTool({
    name: "check_workflow",
    label: "Check Workflow",
    description:
      "Poll the status of a workflow run. Returns current state + per-step results + (optionally) recent events and a one-line digest summary.",
    parameters: CheckWorkflowParams,
    execute: async (_toolCallId, params: {
      workflow_run_id: string;
      tail?: number;
      event_type?: string;
      include_summary?: boolean;
      summary_tail?: number;
    }) => {
      const state = runner.show(params.workflow_run_id);
      if (!state) {
        return {
          content: [{
            type: "text",
            text: `check_workflow: workflow_run_id '${params.workflow_run_id}' not found`,
          }],
          isError: true,
          details: { error: "not_found" } as never,
        };
      }
      const events = params.tail
        ? runner.tail(params.workflow_run_id, { tail: params.tail, event_type: params.event_type })
        : [];
      const summary = params.include_summary
        ? runner.tailSummary(params.workflow_run_id, { tail: params.summary_tail ?? 20 })
        : [];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            workflow_run_id: state.workflow_run_id,
            workflow: state.workflow_name,
            status: state.status,
            started_at: state.started_at,
            ended_at: state.ended_at,
            cost_usd: state.cost_usd,
            attempts: state.attempts,
            steps: state.steps,
            error: state.error,
            paused_reason: state.paused_reason,
            events: events,
            summary: summary,
          }, null, 2),
        }],
        details: {
          workflow_run_id: state.workflow_run_id,
          status: state.status,
          step_count: Object.keys(state.steps).length,
        },
      };
    },
  });
}
