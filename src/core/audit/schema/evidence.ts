import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

// ============================================================================
// Repository-specific command and procedure evidence
// ============================================================================
//
// These fields describe operational evidence only. The installer may use them
// when deriving trusted procedures; they do not authorize the audit model to
// write repository-facing artifacts or expand tool policy.

const CustomToolCandidateSchema = Type.Object({
    name: Type.String({
        description:
            "Stable kebab-case identifier for an existing repository command " +
            "that may be useful through a trusted wrapper.",
    }),
    existing_command: Type.String({
        description:
            "Exact observed command, for example 'npm test' or " +
            "'scripts/prime_db.sh'. Do not invent commands.",
    }),
    purpose: Type.String({
        description:
            "One-line explanation of what the observed command does and why " +
            "it is useful to repository work.",
    }),
    source_path: Type.Union([Type.String(), Type.Null()], {
        description:
            "Repository evidence for the command, such as " +
            "'package.json#scripts.test' or 'scripts/prime_db.sh'. " +
            "Null only when the command is evidenced by multiple sources.",
    }),
});

const SkillCandidateSchema = Type.Object({
    name: Type.String({
        description:
            "Stable kebab-case identifier for a repository-specific procedure.",
    }),
    purpose: Type.String({
        description:
            "One-line explanation of when the procedure is useful and what " +
            "repository outcome it produces.",
    }),
    steps_or_script_path: Type.String({
        description:
            "Either the real path of an existing script (preferred) or a " +
            "concise 3-7 step workflow grounded in observed repository files.",
    }),
});

export const CustomizationEvidenceSchema = Type.Object({
    custom_tool_candidates: Type.Array(CustomToolCandidateSchema, {
        description:
            "Observed repository commands that may justify a trusted wrapper " +
            "or procedure. Evidence only; the focused audit does not emit " +
            "extension files or expand tool policy.",
    }),
    skill_candidates: Type.Array(SkillCandidateSchema, {
        description:
            "Observed repository-specific multi-step procedures. Evidence only; " +
            "the focused installer materializes validated procedures through " +
            "application-owned code rather than generic skill files.",
    }),
});

export type CustomizationEvidence = Static<typeof CustomizationEvidenceSchema>;

// ============================================================================
// Repository specialist evidence
// ============================================================================
//
// `expert_evidence` contains cohesive domain evidence. Trusted specialist
// discovery may transform these records into typed
// read-only specialists under the canonical Agentify memory layout. No prompt
// directories or command families are implied by this schema.

const ExpertDomainSchema = Type.Object({
    domain: Type.String({
        description:
            "Stable kebab-case candidate specialist identifier, for example " +
            "'billing', 'websocket', or 'database'.",
    }),
    rationale: Type.String({
        description:
            "One-line evidence-backed reason this domain warrants a persistent " +
            "read-only repository specialist.",
    }),
    primary_paths: Type.Array(Type.String(), {
        description:
            "Repository-relative paths or globs that provide evidence for this " +
            "domain. They are advisory scope, not write ownership.",
    }),
    entry_points: Type.Array(Type.String(), {
        description: "Files a specialist should inspect first for this domain.",
    }),
    test_paths: Type.Array(Type.String(), {
        description: "Repository-relative paths containing domain validation.",
    }),
    key_files: Type.Array(Type.Object({
        path: Type.String(),
        purpose: Type.String({ description: "One-line purpose of the observed file." }),
        line_range: Type.Tuple([
            Type.Number({ description: "Start line, 1-indexed, inclusive." }),
            Type.Number({ description: "End line, 1-indexed, inclusive." }),
        ]),
    })),
    key_types: Type.Array(Type.Object({
        name: Type.String(),
        path: Type.String({ description: "Repository path and line of the definition." }),
        purpose: Type.String(),
    })),
    patterns: Type.Array(Type.Object({
        name: Type.String(),
        description: Type.String(),
        example_ref: Type.String({ description: "Repository path and line reference." }),
    })),
    pitfalls: Type.Array(Type.Object({
        risk: Type.String(),
        consequence: Type.String(),
        reference: Type.String({ description: "Repository path and line reference." }),
    })),
    conventions: Type.Array(Type.String(), {
        description: "Domain-specific rules supported by repository evidence.",
    }),
    stability: StringEnum(["high", "medium", "low"] as const, {
        description:
            "How frequently the domain evidence changes. High means relatively " +
            "stable; low means specialist knowledge needs frequent revalidation.",
    }),
    recurrence: StringEnum(["high", "medium", "low"] as const, {
        description:
            "How often the domain is expected to help normal repository work. " +
            "Low-recurrence one-off areas usually do not justify a specialist.",
    }),
    test_command: Type.Union([Type.String(), Type.Null()], {
        description:
            "Observed validation command specific to this domain, or null when " +
            "only the global validation surface applies. Trusted runtime code " +
            "decides whether and how the command may execute.",
    }),
    last_updated: Type.String({
        description:
            "ISO 8601 evidence timestamp. Persisted specialists receive " +
            "application-owned provenance, supporting-commit, confidence, and " +
            "freshness metadata during materialization.",
    }),
});

export const ExpertEvidenceSchema = Type.Object({
    expert_domains: Type.Array(ExpertDomainSchema, {
        description:
            "Cohesive candidate repository-specialist domains derived from " +
            "code, tests, contracts, ownership, and validated documentation. " +
            "Capped at 8; an honest empty list is valid for a tiny repository.",
    }),
});

export type ExpertEvidence = Static<typeof ExpertEvidenceSchema>;
