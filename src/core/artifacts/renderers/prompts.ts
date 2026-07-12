import type { ArtifactIntents, CodebaseMap } from "../../audit/schema.ts";
import { isKebabName, isPromptName, markdownArtifact, oneLine, titleCaseName } from "./artifact-builders.ts";
import { changeTypeValidationLines, nonEmptyCommand } from "./validation-commands.ts";
import type { RenderContext, RenderedArtifact } from "./types.ts";

type PerAreaTemplateCandidateIntent = NonNullable<CodebaseMap["meta"]["lifecycle"]["per_area_template_candidates"]>[number];

function validationLines(map: CodebaseMap): string[] {
  return [
    `- Test: ${nonEmptyCommand(map.validation_surface.test_command) ?? "not configured"}`,
    `- Lint: ${nonEmptyCommand(map.validation_surface.lint_command) ?? "not configured"}`,
    `- Typecheck: ${nonEmptyCommand(map.validation_surface.typecheck_command) ?? "not configured"}`,
    `- E2E: ${nonEmptyCommand(map.validation_surface.e2e_command) ?? "not configured"}`,
  ];
}

function renderIssueTypePrompt(map: CodebaseMap, issueType: string): RenderedArtifact {
  const title = titleCaseName(issueType);
  return markdownArtifact({
    relativePath: `.pi/prompts/${issueType}.md`,
    kind: "prompt",
    required: false,
    source: "lifecycle-prompt-renderer",
    body: [
      "---",
      `description: Write an agentify build spec for ${issueType} work in this repository.`,
      `argument-hint: "<one-sentence ${issueType} task>"`,
      "---",
      "",
      `# ${title}`,
      "",
      "## Goal",
      "",
      `Write a build spec for $ARGUMENTS to \`specs/${issueType}-<slug>.md\`.`,
      "The implementer will run `/implement <spec-path>` after the spec is reviewed.",
      "",
      "## Workflow",
      "",
      "1. Read `specs/README.md` for this repository's spec conventions.",
      "2. Read `.pi/conditional_docs.md` and load matching docs when present.",
      "3. Read `AGENTS.md` for current build, test, and ownership guidance.",
      "4. Inspect the relevant files before naming implementation steps.",
      "5. Write the spec with `## Relevant Files`, `## Steps`, and `## Validation Commands`.",
      "",
      "## Validation Surface",
      "",
      ...validationLines(map),
      "",
      "## Validation By Change Type",
      "",
      ...changeTypeValidationLines(map),
      "",
      "## Instructions",
      "",
      "- MUST end with runnable validation commands.",
      "- MUST cite concrete repository paths in Relevant Files.",
      "- MUST NOT write product code from this prompt.",
      "",
    ].join("\n"),
  });
}

function renderPerAreaPrompt(map: CodebaseMap, candidate: PerAreaTemplateCandidateIntent): RenderedArtifact {
  const title = titleCaseName(candidate.area_name);
  return markdownArtifact({
    relativePath: `.pi/prompts/${candidate.area_name}.md`,
    kind: "prompt",
    required: false,
    source: "per-area-prompt-renderer",
    body: [
      "---",
      `description: ${candidate.area_name}-specific ${candidate.issue_type} template. Use for recurring ${candidate.issue_type} work in the ${candidate.area_name} area.`,
      `argument-hint: "<one-sentence ${candidate.issue_type} task in ${candidate.area_name}>"`,
      "---",
      "",
      `# ${title} (${candidate.issue_type})`,
      "",
      "## Goal",
      "",
      `Write a build spec for $ARGUMENTS using \`.pi/prompts/${candidate.issue_type}.md\` as the base format, enriched with ${candidate.area_name} context.`,
      "",
      "## Area Context",
      "",
      `- Source feature agent: \`${candidate.source_feature_agent}\``,
      `- Rationale: ${oneLine(candidate.rationale)}`,
      "- Trigger phrases:",
      ...candidate.trigger_phrases.map((phrase) => `  - ${oneLine(phrase)}`),
      "",
      "## Workflow",
      "",
      `1. Read \`.pi/prompts/${candidate.issue_type}.md\` for the base spec flow.`,
      `2. Read \`${candidate.source_feature_agent}\` for local conventions, key files, and pitfalls.`,
      "3. Read `AGENTS.md` and `.pi/conditional_docs.md`.",
      "4. Inspect relevant files before naming implementation steps.",
      "5. Write the spec to `specs/<type>-<slug>.md` with area-specific risks and validation.",
      "",
      "## Validation Surface",
      "",
      ...validationLines(map),
      "",
      "## Instructions",
      "",
      "- MUST include area-specific files, conventions, and pitfalls when they affect the task.",
      "- MUST NOT invent files or commands.",
      "- MUST NOT write product code from this prompt.",
      "",
    ].join("\n"),
  });
}

export function renderLifecyclePromptArtifacts(map: CodebaseMap, existingPaths: Set<string>, errors: string[]): RenderedArtifact[] {
  const artifacts: RenderedArtifact[] = [];
  for (const issueType of map.meta.lifecycle.issue_types) {
    if (!isPromptName(issueType)) {
      errors.push(`invalid issue type prompt name: ${issueType}`);
      continue;
    }
    const relativePath = `.pi/prompts/${issueType}.md`;
    if (existingPaths.has(relativePath)) continue;
    const artifact = renderIssueTypePrompt(map, issueType);
    artifacts.push(artifact);
    existingPaths.add(artifact.relativePath);
  }

  for (const candidate of (map.meta.lifecycle.per_area_template_candidates ?? []).slice(0, 3)) {
    if (!isKebabName(candidate.area_name)) {
      errors.push(`invalid per-area prompt name: ${candidate.area_name}`);
      continue;
    }
    const relativePath = `.pi/prompts/${candidate.area_name}.md`;
    if (existingPaths.has(relativePath)) continue;
    const artifact = renderPerAreaPrompt(map, candidate);
    artifacts.push(artifact);
    existingPaths.add(artifact.relativePath);
  }
  return artifacts;
}

export function renderPromptTemplateArtifacts(
  intents: ArtifactIntents | undefined,
  errors: string[],
  context: RenderContext,
): RenderedArtifact[] {
  const artifacts: RenderedArtifact[] = [];
  for (const prompt of intents?.prompt_templates ?? []) {
    if (!isKebabName(prompt.name)) {
      errors.push(`invalid prompt template name: ${prompt.name}`);
      continue;
    }
    artifacts.push(markdownArtifact({
      relativePath: `${context.stateDir}/prompts/${prompt.name}.md`,
      kind: "prompt",
      required: false,
      source: "prompt-template-renderer",
      body: [
        "---",
        `description: ${oneLine(prompt.description)}`,
        "type: prompt-template",
        "---",
        "",
        prompt.body.trim(),
        "",
      ].join("\n"),
    }));
  }
  return artifacts;
}
