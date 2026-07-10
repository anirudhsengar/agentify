// tools/compose-workflow.ts

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowRunner } from "../workflow-runner.ts";
import type { WorkflowRegistry } from "../workflow-registry.ts";
import {
  validateWorkflowSpec,
  WorkflowSpecSchema,
  type WorkflowSpec,
} from "../workflow-spec.ts";
import { saveWorkflowToProject } from "../workflow-registry.ts";

const ComposeWorkflowParams = Type.Object({
  spec: WorkflowSpecSchema,
  inputs: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())]),
    ),
  ),
  workflow_run_id: Type.Optional(Type.String()),
  save_as: Type.Optional(
    Type.String({
      description:
        "If set, persist the spec to <project>/.pi/workflows/<save_as>.json before running, so future calls can use run_workflow by name.",
    }),
  ),
});

export function composeWorkflowTool(
  registry: WorkflowRegistry,
  runner: WorkflowRunner,
  projectWorkflowsDir: string | null,
): ToolDefinition {
  return defineTool({
    name: "compose_workflow",
    label: "Compose Workflow",
    description:
      "Run an ad-hoc WorkflowSpec inline. Use when a registered workflow does not yet exist for the composition you need. If save_as is set, the spec is persisted to the project's workflow registry for future use.",
    parameters: ComposeWorkflowParams,
    execute: async (_toolCallId, params: {
      spec: WorkflowSpec;
      inputs?: Record<string, string | number | boolean | string[]>;
      workflow_run_id?: string;
      save_as?: string;
    }) => {
      const validation = validateWorkflowSpec(params.spec);
      if (!validation.ok) {
        return {
          content: [{
            type: "text",
            text: `compose_workflow failed (spec invalid): ${validation.errors.join("; ")}`,
          }],
          isError: true,
          details: { error: "spec_invalid", errors: validation.errors } as never,
        };
      }
      const spec = validation.value!;
      let persistedAt: string | null = null;
      if (params.save_as && projectWorkflowsDir) {
        try {
          persistedAt = saveWorkflowToProject(
            { ...spec, name: params.save_as },
            projectWorkflowsDir,
          );
        } catch (err) {
          return {
            content: [{
              type: "text",
              text: `compose_workflow save_as failed: ${(err as Error).message}`,
            }],
            isError: true,
            details: { error: (err as Error).message } as never,
          };
        }
      }
      try {
        const state = await runner.run({
          spec,
          inputs: params.inputs,
          workflowRunId: params.workflow_run_id,
          source: "orchestrator:tool",
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              workflow_run_id: state.workflow_run_id,
              workflow: state.workflow_name,
              status: state.status,
              started_at: state.started_at,
              persisted_at: persistedAt,
              message: `Composed workflow '${state.workflow_name}' (${state.workflow_run_id}) status: ${state.status}`,
            }, null, 2),
          }],
          details: { workflow_run_id: state.workflow_run_id, status: state.status, persisted_at: persistedAt } as never,
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `compose_workflow failed: ${(err as Error).message}`,
          }],
          isError: true,
          details: { error: (err as Error).message } as never,
        };
      }
    },
  });
}
