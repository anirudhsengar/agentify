// tools/start-aiw.ts

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AiwBridge } from "../aiw-bridge.ts";

const WorkflowType = StringEnum(
  ["plan_build", "plan_build_review", "plan_build_review_fix", "plan_build_review_ship"] as const,
);

const ChangeType = StringEnum(
  ["chore", "bug", "feature", "unknown"] as const,
  { default: "unknown" },
);

const StartAiwParams = Type.Object({
  name_of_aiw: Type.String({
    description: "Human-readable label (e.g. 'implement auth'). Not the aiw_id; aiw_id is auto-generated.",
  }),
  workflow_type: WorkflowType,
  prompt: Type.String({
    description: "The user request the AIW should execute.",
  }),
  description: Type.Optional(Type.String({
    description: "Optional one-line description; logged for audit.",
  })),
  change_type: Type.Optional(ChangeType),
});

export function startAiwTool(bridge: AiwBridge): ToolDefinition {
  return defineTool({
    name: "start_aiw",
    label: "Start AIW",
    description: "Start an AI Developer Workflow (plan → build → review → fix [+ship]). Returns the aiw_id immediately; the workflow runs in the background. Poll with check_aiw to know when it finishes.",
    parameters: StartAiwParams,
    execute: async (
      _toolCallId: string,
      params: {
        name_of_aiw: string;
        workflow_type: "plan_build" | "plan_build_review" | "plan_build_review_fix" | "plan_build_review_ship";
        prompt: string;
        description?: string;
        change_type?: "chore" | "bug" | "feature" | "unknown";
      },
    ) => {
      try {
        const result = await bridge.startAiw(
          {
            name_of_aiw: params.name_of_aiw,
            workflow_type: params.workflow_type,
            prompt: params.prompt,
            description: params.description,
            change_type: params.change_type,
          },
          { source: "orchestrator:tool" },
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              aiw_id: result.aiw_id,
              name_of_aiw: result.name_of_aiw,
              workflow: result.workflow,
              status: result.status,
              started_at: result.started_at,
              message: `AIW ${result.name_of_aiw} (${result.aiw_id}) started. Workflow: ${result.workflow}.`,
            }, null, 2),
          }],
          details: { aiw_id: result.aiw_id, status: result.status },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `start_aiw failed: ${(err as Error).message}`,
          }],
          isError: true,
          details: {  error: (err as Error).message  } as never,
        };
      }
    },
  });
}