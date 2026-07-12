import type { ArtifactIntents, CodebaseMap } from "../../audit/schema.ts";
import { validateWorkflowSpec, type WorkflowSpec } from "../../orchestrator/workflow-spec.ts";
import { isKebabName, jsonArtifact, titleCaseName } from "./artifact-builders.ts";
import { mandatoryChangeTypeCommands, repositoryValidationCommands, uniqueCommands } from "./validation-commands.ts";
import type { RenderContext, RenderedArtifact } from "./types.ts";

function workflowNameForAgent(agentName: string): string {
  return `${agentName.replace(/-/g, "_")}_plan_build_review_fix`;
}

function renderSpecialistWorkflowSpec(agentName: string, map: CodebaseMap): WorkflowSpec {
  const title = titleCaseName(agentName);
  const validation = uniqueCommands([
    ...repositoryValidationCommands(map),
    ...mandatoryChangeTypeCommands(map),
  ]);

  return {
    name: workflowNameForAgent(agentName),
    description: `Scout with the ${title} specialist, then run the canonical plan-build-review-fix AIW loop.`,
    tags: ["agentify", "specialist", agentName],
    inputs: {
      prompt: {
        type: "string",
        description: `The ${title} work request to plan, build, review, and fix.`,
      },
      change_type: {
        type: "string",
        default: "feature",
        values: ["chore", "bug", "feature"],
      },
    },
    parallelism: "sequential",
    max_runtime_minutes: 120,
    steps: [
      {
        id: "scout",
        description: `Gather ${title} context before implementation.`,
        handler: "subagent",
        subagent_template: agentName,
        domain: [agentName],
        user_prompt: [
          `Scout the ${agentName} area for this request: \${inputs.prompt}`,
          "Return concrete files, invariants, pitfalls, and validation commands.",
          validation.length > 0
            ? `Repository validation surface: ${validation.join("; ")}.`
            : "Use the repository validation surface from AGENTS.md.",
        ].join("\n"),
      },
      {
        id: "implement",
        description: "Run the canonical AIW after specialist reconnaissance.",
        handler: "aiw",
        workflow_type: "plan_build_review_fix",
        prompt: "${inputs.prompt}\n\nSpecialist scout context:\n${agents[scout].result_text}",
        change_type: "${inputs.change_type}",
        depends_on: ["scout"],
      },
    ],
  };
}

function renderedWorkflowAgentNames(map: CodebaseMap, intents: ArtifactIntents | undefined): string[] {
  const names = new Set<string>();
  for (const agent of intents?.feature_agents ?? []) {
    if (isKebabName(agent.name)) names.add(agent.name);
  }
  for (const domain of map.meta.suggested_subagent_domains ?? []) {
    if (isKebabName(domain)) names.add(domain);
  }
  return [...names].slice(0, 12);
}

export function renderProjectWorkflowArtifacts(
  map: CodebaseMap,
  intents: ArtifactIntents | undefined,
  errors: string[],
  context: RenderContext,
): RenderedArtifact[] {
  const artifacts: RenderedArtifact[] = [];
  for (const agentName of renderedWorkflowAgentNames(map, intents)) {
    const spec = renderSpecialistWorkflowSpec(agentName, map);
    const validation = validateWorkflowSpec(spec);
    if (!validation.ok) {
      errors.push(`invalid generated workflow for ${agentName}: ${validation.errors.join("; ")}`);
      continue;
    }
    artifacts.push(jsonArtifact({
      relativePath: `${context.stateDir}/workflows/${agentName}-plan-build-review-fix.json`,
      kind: "workflow",
      required: false,
      source: "specialist-workflow-renderer",
      value: spec,
    }));
  }
  return artifacts;
}
