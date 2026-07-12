import type { ArtifactIntents, CodebaseMap, FeatureAgentIntent } from "../../audit/schema.ts";
import { isKebabName, markdownArtifact, oneLine } from "./artifact-builders.ts";
import { mandatoryChangeTypeCommands, repositoryValidationCommands, uniqueCommands } from "./validation-commands.ts";
import type { RenderContext, RenderedArtifact } from "./types.ts";

function featureAgentBody(intent: FeatureAgentIntent): string {
  const globs = intent.globs.length > 0
    ? ["globs:", ...intent.globs.map((glob) => `  - ${glob}`)]
    : [];
  return [
    "---",
    `name: ${intent.name}`,
    `description: ${oneLine(intent.description)}`,
    ...globs,
    "---",
    "",
    intent.body.trim(),
    "",
  ].join("\n");
}

function renderFallbackFeatureAgentBody(name: string, map: CodebaseMap): string {
  const matchingFirstFiles = map.skeleton.first_5_files_for_fresh_agent
    .filter((entry) => entry.path.includes(name))
    .slice(0, 5);
  const firstFiles = (matchingFirstFiles.length > 0
    ? matchingFirstFiles
    : map.skeleton.first_5_files_for_fresh_agent.slice(0, 5)
  ).map((entry) => `- \`${entry.path}\` - ${oneLine(entry.why)}`);

  const validation = uniqueCommands([
    ...repositoryValidationCommands(map),
    ...mandatoryChangeTypeCommands(map),
  ]);

  const matchingPitfalls = map.pitfalls
    .filter((pitfall) => pitfall.module.includes(name) || pitfall.what.toLowerCase().includes(name))
    .slice(0, 5);
  const pitfalls = (matchingPitfalls.length > 0 ? matchingPitfalls : map.pitfalls.slice(0, 5))
    .map((pitfall) =>
      `- \`${pitfall.module}:${pitfall.line_ref}\`: ${oneLine(pitfall.what)} Consequence: ${oneLine(pitfall.consequence)}`,
    );

  return [
    "Use the validated codebase map before changing this area.",
    "",
    "## Scope",
    "",
    `- Specialist: ${name}`,
    `- Domain hypothesis: ${oneLine(map.meta.domain_hypothesis)}`,
    `- Primary glob: ${name}`,
    "",
    "## First Files",
    "",
    ...(firstFiles.length > 0 ? firstFiles : ["- Use `AGENTS.md` and `.pi/agentify/codebase_map.json` for orientation."]),
    "",
    "## Validation",
    "",
    ...(validation.length > 0 ? validation.map((command) => `- \`${command}\``) : ["- Use the repository validation surface from `AGENTS.md`."]),
    "",
    "## Pitfalls",
    "",
    ...(pitfalls.length > 0 ? pitfalls : ["- No feature-specific pitfalls were identified in the audit map."]),
    "",
  ].join("\n");
}

function renderFallbackFeatureAgents(map: CodebaseMap, context: RenderContext): RenderedArtifact[] {
  const domains = map.meta.suggested_subagent_domains ?? [];
  return domains
    .filter(isKebabName)
    .slice(0, 12)
    .map((name) => markdownArtifact({
      relativePath: `${context.stateDir}/agents/${name}.md`,
      kind: "audit",
      required: false,
      source: "fallback-feature-agent-renderer",
      body: featureAgentBody({
        name,
        description: `Agentify specialist for ${name}.`,
        globs: [name],
        body: renderFallbackFeatureAgentBody(name, map),
      }),
    }));
}

export function renderFeatureAgentArtifacts(
  map: CodebaseMap,
  intents: ArtifactIntents | undefined,
  errors: string[],
  context: RenderContext,
): RenderedArtifact[] {
  if (!intents) return renderFallbackFeatureAgents(map, context);
  const artifacts: RenderedArtifact[] = [];
  for (const agent of intents.feature_agents) {
    if (!isKebabName(agent.name)) {
      errors.push(`invalid feature agent name: ${agent.name}`);
      continue;
    }
    artifacts.push(markdownArtifact({
      relativePath: `${context.stateDir}/agents/${agent.name}.md`,
      kind: "audit",
      required: false,
      source: "feature-agent-renderer",
      body: featureAgentBody(agent),
    }));
  }
  return artifacts;
}
