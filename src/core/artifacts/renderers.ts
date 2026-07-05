import { AGENTIFY_MANAGED_MARKERS, addMarkdownManagedMarker } from "../artifact-exporters.ts";
import {
  AGENTS_MD_MAX_LINES,
  type ArtifactIntents,
  type CodebaseMap,
  type FeatureAgentIntent,
} from "../audit/schema.ts";

export type ManagedArtifactKind =
  | "audit"
  | "harness_export"
  | "scaffold"
  | "state"
  | "prompt"
  | "skill"
  | "expert";

export interface RenderedArtifact {
  relativePath: string;
  content: string;
  marker: string;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}

export interface RenderArtifactsResult {
  artifacts: RenderedArtifact[];
  errors: string[];
}

const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

const REQUIRED_ALWAYS_ON_DOCS = new Set(["specs/README.md", "ai_docs/README.md"]);

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function isSafeRelativePath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  return normalized.length > 0
    && SAFE_RELATIVE_PATH.test(normalized)
    && !normalized.split("/").some((part) => part === "" || part === ".");
}

function isKebabName(name: string): boolean {
  return KEBAB_NAME.test(name);
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const withoutTrailingNewline = content.endsWith("\n")
    ? content.slice(0, -1)
    : content;
  return withoutTrailingNewline.split("\n").length;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function markdownArtifact(params: {
  relativePath: string;
  body: string;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}): RenderedArtifact {
  return {
    relativePath: normalizePath(params.relativePath),
    content: ensureTrailingNewline(addMarkdownManagedMarker(params.body)),
    marker: AGENTIFY_MANAGED_MARKERS.markdown,
    kind: params.kind,
    required: params.required,
    source: params.source,
  };
}

function hashCommentArtifact(params: {
  relativePath: string;
  body: string;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}): RenderedArtifact {
  const marker = AGENTIFY_MANAGED_MARKERS.toml;
  const body = params.body.includes(marker) ? params.body : `${marker}\n${params.body}`;
  return {
    relativePath: normalizePath(params.relativePath),
    content: ensureTrailingNewline(body),
    marker,
    kind: params.kind,
    required: params.required,
    source: params.source,
  };
}

function renderFallbackAgentGuide(map: CodebaseMap): string {
  const validation = [
    map.validation_surface.typecheck_command,
    map.validation_surface.lint_command,
    map.validation_surface.test_command,
    map.validation_surface.e2e_command,
  ].filter((command): command is string => Boolean(command));

  const firstFiles = map.skeleton.first_5_files_for_fresh_agent
    .slice(0, 5)
    .map((entry) => `- \`${entry.path}\` - ${oneLine(entry.why)}`);

  const pitfalls = map.pitfalls
    .slice(0, 5)
    .map((pitfall) => `- \`${pitfall.module}\`: ${oneLine(pitfall.what)} (${oneLine(pitfall.consequence)})`);

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
    ...validation.map((command) => `- \`${command}\``),
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

function renderFallbackSpecs(map: CodebaseMap): string {
  const perChange = Object.entries(map.validation_surface.per_change_type)
    .map(([changeType, commands]) => {
      const mandatory = commands.mandatory.map((command) => `\`${command}\``).join(", ") || "none";
      return `- ${changeType}: ${mandatory}`;
    });
  return [
    "# Specs",
    "",
    "Agentify-generated spec guidance from the validated codebase map.",
    "",
    "## Validation By Change Type",
    "",
    ...perChange,
    "",
  ].join("\n");
}

function renderFallbackAiDocs(map: CodebaseMap): string {
  return [
    "# AI Docs",
    "",
    "Agentify-generated always-on context from the validated codebase map.",
    "",
    "## Module Boundaries",
    "",
    ...map.module_graph.edges.slice(0, 20).map((edge) => `- \`${edge.from}\` -> \`${edge.to}\` (${edge.kind})`),
    "",
    "## Security Notes",
    "",
    ...map.security_surface.damage_control_rules.slice(0, 20).map((rule) => `- ${oneLine(rule)}`),
    "",
  ].join("\n");
}

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

function renderFallbackFeatureAgents(map: CodebaseMap): RenderedArtifact[] {
  const domains = map.meta.suggested_subagent_domains ?? [];
  return domains
    .filter(isKebabName)
    .slice(0, 12)
    .map((name) => markdownArtifact({
      relativePath: `.pi/agents/${name}.md`,
      kind: "audit",
      required: false,
      source: "fallback-feature-agent-renderer",
      body: featureAgentBody({
        name,
        description: `Agentify specialist for ${name}.`,
        globs: [name],
        body: [
          `Use the validated codebase map before changing ${name}.`,
          "",
          `Domain hypothesis: ${map.meta.domain_hypothesis}`,
        ].join("\n"),
      }),
    }));
}

function renderAlwaysOnDocs(map: CodebaseMap, intents: ArtifactIntents | undefined): RenderedArtifact[] {
  const artifacts = new Map<string, RenderedArtifact>();
  const add = (artifact: RenderedArtifact): void => {
    artifacts.set(artifact.relativePath, artifact);
  };

  if (intents) {
    for (const doc of intents.always_on_docs) {
      const relativePath = normalizePath(doc.path);
      if (!isSafeRelativePath(relativePath)) continue;
      add(markdownArtifact({
        relativePath,
        kind: "audit",
        required: REQUIRED_ALWAYS_ON_DOCS.has(relativePath),
        source: "always-on-docs-renderer",
        body: [`# ${oneLine(doc.title)}`, "", doc.body.trim(), ""].join("\n"),
      }));
    }
  }

  if (!artifacts.has("specs/README.md")) {
    add(markdownArtifact({
      relativePath: "specs/README.md",
      kind: "audit",
      required: true,
      source: "fallback-specs-renderer",
      body: renderFallbackSpecs(map),
    }));
  }

  if (!artifacts.has("ai_docs/README.md")) {
    add(markdownArtifact({
      relativePath: "ai_docs/README.md",
      kind: "audit",
      required: true,
      source: "fallback-ai-docs-renderer",
      body: renderFallbackAiDocs(map),
    }));
  }

  return [...artifacts.values()];
}

export function renderBrownfieldArtifacts(map: CodebaseMap): RenderArtifactsResult {
  const artifacts: RenderedArtifact[] = [];
  const errors: string[] = [];
  const intents = map.artifact_intents;

  const agentGuide = intents ? renderIntentAgentGuide(intents) : renderFallbackAgentGuide(map);
  if (countLines(agentGuide) > AGENTS_MD_MAX_LINES) {
    errors.push(`AGENTS.md would be ${countLines(agentGuide)} lines, exceeds the ${AGENTS_MD_MAX_LINES}-line cap`);
  } else {
    artifacts.push(markdownArtifact({
      relativePath: "AGENTS.md",
      kind: "audit",
      required: true,
      source: intents ? "agent-guide-renderer" : "fallback-agent-guide-renderer",
      body: agentGuide,
    }));
  }

  artifacts.push(...renderAlwaysOnDocs(map, intents));

  if (intents) {
    for (const agent of intents.feature_agents) {
      if (!isKebabName(agent.name)) {
        errors.push(`invalid feature agent name: ${agent.name}`);
        continue;
      }
      artifacts.push(markdownArtifact({
        relativePath: `.pi/agents/${agent.name}.md`,
        kind: "audit",
        required: false,
        source: "feature-agent-renderer",
        body: featureAgentBody(agent),
      }));
    }

    for (const prompt of intents.prompt_templates) {
      if (!isKebabName(prompt.name)) {
        errors.push(`invalid prompt template name: ${prompt.name}`);
        continue;
      }
      artifacts.push(markdownArtifact({
        relativePath: `.pi/prompts/${prompt.name}.md`,
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

    for (const expert of intents.experts) {
      if (!isKebabName(expert.name)) {
        errors.push(`invalid expert name: ${expert.name}`);
        continue;
      }
      artifacts.push(markdownArtifact({
        relativePath: `.pi/prompts/experts/${expert.name}.md`,
        kind: "expert",
        required: false,
        source: "expert-renderer",
        body: [
          "# Expert",
          "",
          `Domain: ${oneLine(expert.domain)}`,
          "",
          expert.body.trim(),
          "",
        ].join("\n"),
      }));
    }

    for (const extension of intents.extension_candidates) {
      if (!isKebabName(extension.name)) {
        errors.push(`invalid extension candidate name: ${extension.name}`);
        continue;
      }
      artifacts.push(hashCommentArtifact({
        relativePath: `.pi/extensions/${extension.name}.ts`,
        kind: "skill",
        required: false,
        source: "extension-candidate-renderer",
        body: extension.body.trim(),
      }));
    }
  } else {
    artifacts.push(...renderFallbackFeatureAgents(map));
  }

  const unsafe = artifacts
    .map((artifact) => artifact.relativePath)
    .filter((relativePath) => !isSafeRelativePath(relativePath));
  for (const relativePath of unsafe) {
    errors.push(`unsafe rendered artifact path: ${relativePath}`);
  }

  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (seen.has(artifact.relativePath)) {
      errors.push(`duplicate rendered artifact path: ${artifact.relativePath}`);
    }
    seen.add(artifact.relativePath);
  }

  return { artifacts, errors };
}
