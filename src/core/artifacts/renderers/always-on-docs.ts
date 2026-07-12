import { normalizeArtifactPath } from "../generated-surface.ts";
import type { ArtifactIntents, CodebaseMap } from "../../audit/schema.ts";
import { REQUIRED_ALWAYS_ON_DOCS, isSafeRelativePath, markdownArtifact, oneLine } from "./artifact-builders.ts";
import { changeTypeValidationLines } from "./validation-commands.ts";
import type { RenderedArtifact } from "./types.ts";

function renderFallbackSpecs(map: CodebaseMap): string {
  return [
    "# Specs",
    "",
    "Agentify-generated spec guidance from the validated codebase map.",
    "",
    "## Validation By Change Type",
    "",
    ...changeTypeValidationLines(map),
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

export function renderAlwaysOnDocs(map: CodebaseMap, intents: ArtifactIntents | undefined): RenderedArtifact[] {
  const artifacts = new Map<string, RenderedArtifact>();
  const add = (artifact: RenderedArtifact): void => {
    artifacts.set(artifact.relativePath, artifact);
  };

  if (intents) {
    for (const doc of intents.always_on_docs) {
      const relativePath = normalizeArtifactPath(doc.path);
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
