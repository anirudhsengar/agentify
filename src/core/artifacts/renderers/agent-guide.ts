import { AGENTS_MD_MAX_LINES, type ArtifactIntents, type CodebaseMap } from "../../audit/schema.ts";
import { countLines, markdownArtifact, oneLine } from "./artifact-builders.ts";
import { changeTypeValidationLines, repositoryValidationCommands } from "./validation-commands.ts";
import type { RenderedArtifact } from "./types.ts";

function renderFallbackAgentGuide(map: CodebaseMap): string {
  const validation = repositoryValidationCommands(map);
  const perChangeValidation = changeTypeValidationLines(map);

  const firstFiles = map.skeleton.first_5_files_for_fresh_agent
    .slice(0, 5)
    .map((entry) => `- \`${entry.path}\` - ${oneLine(entry.why)}`);

  const pitfalls = map.pitfalls
    .slice(0, 5)
    .map((pitfall) => `- \`${pitfall.module}:${pitfall.line_ref}\`: ${oneLine(pitfall.what)} (${oneLine(pitfall.consequence)})`);
  const validationLines = validation.length > 0
    ? validation.map((command) => `- \`${command}\``)
    : [
        "- No validation commands were identified by the audit. Add or document a validation command before trusting automation for risky changes.",
      ];

  return [
    "# AGENTS.md",
    "",
    "Working notes for coding agents. This file is generated from the validated agentify codebase map.",
    "",
    "## Project",
    "",
    `- Type: ${oneLine(map.meta.project_type)}`,
    `- Domain: ${oneLine(map.meta.domain_hypothesis)}`,
    `- Languages: ${map.meta.languages.join(", ") || "unknown"}`,
    "",
    "## First Files",
    "",
    ...firstFiles,
    "",
    "## Validation",
    "",
    ...validationLines,
    "",
    "## Validation By Change Type",
    "",
    ...perChangeValidation,
    "",
    "## Conventions",
    "",
    `- Files: ${oneLine(map.conventions.naming.files)}`,
    `- Functions: ${oneLine(map.conventions.naming.functions)}`,
    `- Errors: ${oneLine(map.conventions.error_handling.raise_vs_return)}`,
    "",
    "## Pitfalls",
    "",
    ...(pitfalls.length > 0 ? pitfalls : ["- No major pitfalls were identified in the audit map."]),
    "",
  ].join("\n");
}

function renderIntentAgentGuide(intents: ArtifactIntents): string {
  const sections = intents.agent_guide.sections.flatMap((section) => [
    `## ${oneLine(section.heading)}`,
    "",
    section.body.trim(),
    "",
  ]);
  return [
    `# ${oneLine(intents.agent_guide.title)}`,
    "",
    ...sections,
  ].join("\n");
}

export function renderAgentGuideArtifact(
  map: CodebaseMap,
  intents: ArtifactIntents | undefined,
  errors: string[],
): RenderedArtifact[] {
  const agentGuide = intents ? renderIntentAgentGuide(intents) : renderFallbackAgentGuide(map);
  if (countLines(agentGuide) > AGENTS_MD_MAX_LINES) {
    errors.push(`AGENTS.md would be ${countLines(agentGuide)} lines, exceeds the ${AGENTS_MD_MAX_LINES}-line cap`);
    return [];
  }
  return [markdownArtifact({
    relativePath: "AGENTS.md",
    kind: "audit",
    required: true,
    source: intents ? "agent-guide-renderer" : "fallback-agent-guide-renderer",
    body: agentGuide,
  })];
}
