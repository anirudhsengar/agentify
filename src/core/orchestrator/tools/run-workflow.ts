// tools/run-workflow.ts

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowRunner } from "../workflow-runner.ts";
import type { WorkflowRegistry } from "../workflow-registry.ts";
import { validateInputs, validateWorkflowSpec } from "../workflow-spec.ts";

const RunWorkflowParams = Type.Object({
  workflow: Type.String({
    description: "Registered workflow name (e.g. 'plan_build_review_fix_loop').",
  }),
  inputs: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())]),
      {
        description: "Workflow inputs. Coerced against the spec's declared `inputs` schema.",
      },
    ),
  ),
  workflow_run_id: Type.Optional(
    Type.String({
      description: "Optional caller-supplied id; default = auto-generated 8-char hex.",
    }),
  ),
  max_runtime_minutes: Type.Optional(
    Type.Number({
      description: "Override the spec's max_runtime_minutes for this run.",
    }),
  ),
});

export function runWorkflowTool(
  registry: WorkflowRegistry,
  runner: WorkflowRunner,
): ToolDefinition {
  return defineTool({
    name: "run_workflow",
    label: "Run Workflow",
    description:
      "Start a registered developer workflow (orchestrator workflows). Returns the workflow_run_id immediately; the workflow runs in the background. Poll with check_workflow. Inputs flow into the spec's declared `inputs`.",
    parameters: RunWorkflowParams,
    execute: async (_toolCallId, params: {
      workflow: string;
      inputs?: Record<string, string | number | boolean | string[]>;
      workflow_run_id?: string;
      max_runtime_minutes?: number;
    }) => {
      const spec = registry.get(params.workflow);
      if (!spec) {
        const known = registry.list().map((s) => s.name).sort().join(", ");
        return {
          content: [{
            type: "text",
            text: `run_workflow failed: workflow '${params.workflow}' not in registry. Known: ${known || "(none)"}`,
          }],
          isError: true,
          details: { error: "unknown_workflow", workflow: params.workflow } as never,
        };
      }
      const validation = validateInputs(spec, params.inputs ?? {});
      if (!validation.ok) {
        return {
          content: [{
            type: "text",
            text: `run_workflow failed: ${validation.errors.join("; ")}`,
          }],
          isError: true,
          details: { error: "inputs_invalid", errors: validation.errors } as never,
        };
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
              message: `Workflow '${state.workflow_name}' (${state.workflow_run_id}) status: ${state.status}`,
            }, null, 2),
          }],
          details: { workflow_run_id: state.workflow_run_id, status: state.status } as never,
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `run_workflow failed: ${(err as Error).message}`,
          }],
          isError: true,
          details: { error: (err as Error).message } as never,
        };
      }
    },
  });
}
