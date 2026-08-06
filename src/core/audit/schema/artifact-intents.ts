import { Type, type Static } from "typebox";
import { KebabNameSchema, SafeRelativePathSchema } from "./primitives.ts";

// ============================================================================
// Optional artifact evidence
// ============================================================================
//
// These observations do not authorize file generation. `feature_agents` is the
// supported input to trusted repository-specialist discovery.

const MarkdownSectionIntentSchema = Type.Object({
    heading: Type.String({
        description: "Short evidence section heading without a leading '#'.",
    }),
    body: Type.String({
        description: "Observed content; not a write instruction.",
    }),
});

export const FeatureAgentIntentSchema = Type.Object({
    name: KebabNameSchema,
    description: Type.String({
        description:
            "One-sentence description of a cohesive candidate repository specialist.",
    }),
    globs: Type.Array(SafeRelativePathSchema, {
        minItems: 0,
        maxItems: 12,
        description:
            "Repository-relative evidence scope for the candidate specialist. " +
            "This is advisory and does not grant write ownership.",
    }),
    body: Type.String({
        description:
            "Evidence-backed domain notes, conventions, pitfalls, and validation " +
            "guidance used by trusted specialist discovery.",
    }),
});

export const AlwaysOnDocsIntentSchema = Type.Object({
    path: SafeRelativePathSchema,
    title: Type.String({
        description: "Observed documentation candidate title.",
    }),
    body: Type.String({
        description:
            "Documentation candidate evidence. The installer does " +
            "not render or write this field.",
    }),
});

export const PromptTemplateIntentSchema = Type.Object({
    name: KebabNameSchema,
    description: Type.String({
        description: "Observed prompt-candidate description.",
    }),
    body: Type.String({
        description:
            "Prompt-candidate evidence. The installer does not " +
            "materialize prompt files from this field.",
    }),
});

export const ExpertIntentSchema = Type.Object({
    name: KebabNameSchema,
    domain: Type.String({
        description: "Observed expert domain label.",
    }),
    body: Type.String({
        description:
            "Expert-prompt evidence. Prefer expert_evidence.expert_domains for " +
            "specialist evidence.",
    }),
});

export const ExtensionCandidateIntentSchema = Type.Object({
    name: KebabNameSchema,
    description: Type.String({
        description: "Observed extension or skill candidate description.",
    }),
    body: Type.String({
        description:
            "Candidate evidence. It does not " +
            "authorize executable or documentation writes.",
    }),
});

export const ScaffoldRuntimeIntentSchema = Type.Object({
    state_machine_notes: Type.Array(Type.String(), {
        minItems: 0,
        maxItems: 20,
        description:
            "Repository observations about task-state behavior. The " +
            "trusted packaged scaffold remains authoritative.",
    }),
});

export const ArtifactIntentsSchema = Type.Object({
    agent_guide: Type.Object({
        title: Type.String({
            description: "Observed guide title.",
        }),
        sections: Type.Array(MarkdownSectionIntentSchema, {
            minItems: 1,
            maxItems: 20,
            description:
                "Guide sections retained as evidence only. The " +
                "installer does not render them into repository files.",
        }),
    }),
    always_on_docs: Type.Array(AlwaysOnDocsIntentSchema, {
        minItems: 0,
        maxItems: 20,
        description:
            "Documentation candidate evidence; no installation write is implied.",
    }),
    feature_agents: Type.Array(FeatureAgentIntentSchema, {
        minItems: 0,
        maxItems: 24,
        description:
            "Candidate specialist evidence. Trusted discovery may " +
            "transform supported entries into typed read-only specialists under " +
            "the canonical Agentify memory layout.",
    }),
    prompt_templates: Type.Array(PromptTemplateIntentSchema, {
        minItems: 0,
        maxItems: 24,
        description:
            "Prompt candidate evidence; the " +
            "installer does not render prompt files.",
    }),
    experts: Type.Array(ExpertIntentSchema, {
        minItems: 0,
        maxItems: 24,
        description:
            "Expert material retained as evidence. Audits " +
            "should use expert_evidence.expert_domains instead.",
    }),
    extension_candidates: Type.Array(ExtensionCandidateIntentSchema, {
        minItems: 0,
        maxItems: 24,
        description:
            "Extension or skill candidate evidence; " +
            "they cannot expand tools, policy, or executable runtime.",
    }),
    scaffold_runtime: Type.Optional(ScaffoldRuntimeIntentSchema),
});

export type ArtifactIntents = Static<typeof ArtifactIntentsSchema>;
export type FeatureAgentIntent = Static<typeof FeatureAgentIntentSchema>;
