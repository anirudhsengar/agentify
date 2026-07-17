import { Value } from "typebox/value";
import { CodebaseMapSchema, assessCoverageClosure, type CodebaseMap } from "../../audit/schema.ts";
import { resolveRenderContext } from "./context.ts";
import { isSafeRelativePath } from "./artifact-builders.ts";
import { renderAgentGuideArtifact } from "./agent-guide.ts";
import { renderAlwaysOnDocs } from "./always-on-docs.ts";
import { renderFeatureAgentArtifacts } from "./feature-agents.ts";
import { renderFeedbackLoopArtifacts } from "./feedback-loop.ts";
import { renderExpertArtifacts } from "./experts.ts";
import { renderLifecyclePromptArtifacts, renderPromptTemplateArtifacts } from "./prompts.ts";
import { renderCustomToolCandidateArtifacts, renderExtensionCandidateArtifacts, renderSkillCandidateArtifacts } from "./skills-and-extensions.ts";
import { renderProjectWorkflowArtifacts } from "./workflows.ts";
import type { RenderArtifactsResult, RenderContext, RenderedArtifact, ValidatedRenderResult } from "./types.ts";

export type { ManagedArtifactKind, RenderArtifactsResult, RenderContext, RenderedArtifact, StructuredRenderError, ValidatedRenderResult } from "./types.ts";

/** Deterministic trust boundary used before any repository-facing apply. */
export function renderValidatedBrownfieldArtifacts(
  input: unknown,
  context: RenderContext,
): ValidatedRenderResult {
  const schemaErrors = Value.Errors(CodebaseMapSchema, input).map((error) => {
    const detail = error as unknown as { path?: string; instancePath?: string; message: string };
    return { path: detail.path ?? detail.instancePath ?? "(root)", message: detail.message };
  });
  if (schemaErrors.length > 0) return { artifacts: [], errors: schemaErrors.map((e) => `${e.path}: ${e.message}`), validationErrors: schemaErrors };

  const map = input as CodebaseMap;
  const closure = assessCoverageClosure(map);
  const coverageErrors = closure.unresolved.map((dimension) => ({
    path: `/coverage/${dimension}`,
    message: closure.reasons[dimension] ?? "coverage is incomplete",
  }));
  if (coverageErrors.length > 0) return { artifacts: [], errors: coverageErrors.map((e) => `${e.path}: ${e.message}`), validationErrors: coverageErrors };

  return { ...renderBrownfieldArtifacts(map, context), validationErrors: [] };
}

export function renderBrownfieldArtifacts(
  map: CodebaseMap,
  context: RenderContext,
): RenderArtifactsResult {
  const artifacts: RenderedArtifact[] = [];
  const errors: string[] = [];
  const intents = map.artifact_intents;
  const renderContext = resolveRenderContext(context);

  artifacts.push(...renderAgentGuideArtifact(map, intents, errors));
  artifacts.push(...renderAlwaysOnDocs(map, intents));
  artifacts.push(...renderFeedbackLoopArtifacts(map, intents, renderContext));
  artifacts.push(...renderProjectWorkflowArtifacts(map, intents, errors, renderContext));
  artifacts.push(...renderFeatureAgentArtifacts(map, intents, errors, renderContext));
  artifacts.push(...renderPromptTemplateArtifacts(intents, errors, renderContext));
  artifacts.push(...renderExtensionCandidateArtifacts(intents, errors, renderContext));
  artifacts.push(...renderLifecyclePromptArtifacts(
    map,
    new Set(artifacts.map((artifact) => artifact.relativePath)),
    errors,
    renderContext,
  ));
  artifacts.push(...renderExpertArtifacts(map, intents, errors, renderContext));
  artifacts.push(...renderSkillCandidateArtifacts(map, errors, renderContext));
  artifacts.push(...renderCustomToolCandidateArtifacts(map, errors, renderContext));

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

  for (const artifact of artifacts) {
    if (/currently absent|to be generated/i.test(artifact.content)) {
      errors.push(`stale bootstrap wording in rendered artifact: ${artifact.relativePath}`);
    }
    if (/\*\*Overall:\s*10\/10/i.test(artifact.content)) {
      errors.push(`unsupported coverage conclusion in rendered artifact: ${artifact.relativePath}`);
    }
    if (context.stateDir !== ".pi" && /\.pi\/(?:prompts|conditional_docs|agents|workflows|extensions)\b/.test(artifact.content)) {
      errors.push(`legacy .pi path leaked into rendered artifact: ${artifact.relativePath}`);
    }
    if (artifact.relativePath.endsWith(".json")) {
      try {
        JSON.parse(artifact.content);
      } catch {
        errors.push(`invalid JSON rendered artifact: ${artifact.relativePath}`);
      }
    }
    if ((artifact.relativePath.endsWith(".js") || artifact.relativePath.endsWith(".mjs") || artifact.relativePath.endsWith(".ts"))
      && artifact.content.startsWith("# agentify:managed")) {
      errors.push(`invalid hash marker for source artifact: ${artifact.relativePath}`);
    }
  }

  return { artifacts, errors };
}
