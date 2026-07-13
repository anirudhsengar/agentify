import { Type, type Static } from "typebox";
import { KebabNameSchema, SafeRelativePathSchema } from "./primitives.ts";

// ============================================================================
// Artifact intents
// ============================================================================

const MarkdownSectionIntentSchema = Type.Object({
    heading: Type.String({
        description: "Short Markdown heading text without leading '#'.",
    }),
    body: Type.String({
        description: "Markdown body for this section, grounded in the codebase map.",
    }),
});

export const FeatureAgentIntentSchema = Type.Object({
    name: KebabNameSchema,
    description: Type.String({
        description: "One-sentence specialist description for harness routing.",
    }),
    globs: Type.Array(SafeRelativePathSchema, {
        minItems: 0,
        maxItems: 12,
        description: "Repo-relative files or directories this feature specialist owns.",
    }),
    body: Type.String({
        description: "Feature-specific instructions, conventions, pitfalls, and validation notes.",
    }),
});

export const AlwaysOnDocsIntentSchema = Type.Object({
    path: SafeRelativePathSchema,
    title: Type.String({
        description: "Document title rendered as the top-level Markdown heading.",
    }),
    body: Type.String({
        description: "Markdown body for always-on docs such as specs/README.md or ai_docs/README.md.",
    }),
});

export const PromptTemplateIntentSchema = Type.Object({
    name: KebabNameSchema,
    description: Type.String({
        description: "When a coding agent should use this prompt template.",
    }),
    body: Type.String({
        description: "Prompt template body grounded in codebase conventions.",
    }),
});

export const ExpertIntentSchema = Type.Object({
    name: KebabNameSchema,
    domain: Type.String({
        description: "Expertise domain this prompt set represents.",
    }),
    body: Type.String({
        description: "Expert prompt material grounded in stable codebase concepts.",
    }),
});

export const ExtensionCandidateIntentSchema = Type.Object({
    name: KebabNameSchema,
    description: Type.String({
        description: "Why this extension or skill candidate exists for this repo.",
    }),
    body: Type.String({
        description: "TypeScript or Markdown candidate body. Renderers validate paths before writing.",
    }),
});

export const ScaffoldRuntimeIntentSchema = Type.Object({
    state_machine_notes: Type.Array(Type.String(), {
        minItems: 0,
        maxItems: 20,
        description: "Optional repo-specific notes for the GitHub async state machine.",
    }),
});

export const ArtifactIntentsSchema = Type.Object({
    agent_guide: Type.Object({
        title: Type.String({
            description: "Title rendered into AGENTS.md.",
        }),
        sections: Type.Array(MarkdownSectionIntentSchema, {
            minItems: 1,
            maxItems: 20,
            description: "Ordered AGENTS.md sections. Renderer enforces the 200-line cap.",
        }),
    }),
    always_on_docs: Type.Array(AlwaysOnDocsIntentSchema, {
        minItems: 0,
        maxItems: 20,
        description: "Deterministic Markdown docs rendered by TypeScript, not written by the LLM.",
    }),
    feature_agents: Type.Array(FeatureAgentIntentSchema, {
        minItems: 0,
        maxItems: 24,
        description: "Generated feature specialists rendered to .pi/agents/<name>.md.",
    }),
    prompt_templates: Type.Array(PromptTemplateIntentSchema, {
        minItems: 0,
        maxItems: 24,
        description: "Repo-specific prompt templates rendered to .pi/prompts/<name>.md.",
    }),
    experts: Type.Array(ExpertIntentSchema, {
        minItems: 0,
        maxItems: 24,
        description:
            "Legacy expert prompt material. Prefer expert_evidence.expert_domains; " +
            "renderers convert either source into .pi/prompts/experts/<domain>/ " +
            "with expertise.yaml, question.md, self-improve.md, plan.md, and " +
            "plan_build_improve.md.",
    }),
    extension_candidates: Type.Array(ExtensionCandidateIntentSchema, {
        minItems: 0,
        maxItems: 24,
        description: "Repo-specific extension or skill candidates rendered deterministically.",
    }),
    scaffold_runtime: Type.Optional(ScaffoldRuntimeIntentSchema),
});

export type ArtifactIntents = Static<typeof ArtifactIntentsSchema>;
export type FeatureAgentIntent = Static<typeof FeatureAgentIntentSchema>;

