import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

// ============================================================================
// Custom-tool and skill candidate derivation
// ============================================================================
//
// Declared before CodebaseMapSchema so the schema can reference it
// in its top-level `customization_evidence` field. Used by Phase 9.6 of
// the builder prompt to emit .pi/extensions/*.ts and
// .pi/skills/<name>/SKILL.md after the audit passes.

const CustomToolCandidateSchema = Type.Object({
    name: Type.String({
        description:
            "kebab-case tool name, e.g. 'run-tests', 'prime-db'. " +
            "Must be a valid Pi tool name (lowercase, digits, " +
            "underscores, hyphens).",
    }),
    existing_command: Type.String({
        description:
            "The shell command this tool would wrap, " +
            "e.g. 'bun test' or 'scripts/prime_db.sh'.",
    }),
    purpose: Type.String({
        description:
            "One-line: what the tool does and why it is worth wrapping " +
            "(typed into the tool's `description` field).",
    }),
    source_path: Type.Union([Type.String(), Type.Null()], {
        description:
            "Path where the existing command lives, " +
            "e.g. 'package.json#scripts.test' or " +
            "'scripts/prime_db.sh'. Null if the command is " +
            "synthesized from a multi-source workflow.",
    }),
});

const SkillCandidateSchema = Type.Object({
    name: Type.String({
        description:
            "kebab-case skill name, e.g. 'prime-db', " +
            "'spin-up-env'. Must match the Agent Skills standard " +
            "(lowercase a-z, 0-9, hyphens, 1-64 chars).",
    }),
    purpose: Type.String({
        description:
            "One-line: what the skill does and when to use it " +
            "(typed into the skill's `description` frontmatter).",
    }),
    steps_or_script_path: Type.String({
        description:
            "Either an absolute/relative path to an existing " +
            "script the skill should invoke (preferred), or a " +
            "3-7 step bulleted workflow as a string when no " +
            "single script exists.",
    }),
});

export const CustomizationEvidenceSchema = Type.Object({
    custom_tool_candidates: Type.Array(CustomToolCandidateSchema, {
        description:
            "Emergent list of pi.registerTool() candidates. " +
            "Picked from D6 test/lint/typecheck commands, " +
            "D7 build/run/deploy commands, package_json_scripts, " +
            "and non-trivial scripts_dir_files. " +
            "LLM decides the count (uncapped).",
    }),
    skill_candidates: Type.Array(SkillCandidateSchema, {
        description:
            "Emergent list of /skill:<name> candidates. Picked " +
            "from scripts_dir_files (one skill per non-trivial " +
            "script) and any 3-7 step multi-file operation " +
            "visible in the codebase. " +
            "LLM decides the count (uncapped).",
    }),
});

export type CustomizationEvidence = Static<typeof CustomizationEvidenceSchema>;

// ============================================================================
// Agent-expert domains
// ============================================================================
//
// Mirrors the customization_evidence pattern. Each expert domain becomes
// a folder under .pi/prompts/experts/<domain>/ containing
// expertise.yaml + question.md + self-improve.md (+ optional
// plan.md / plan_build_improve.md). Derived by the builder in
// Phase 3.7 from the per-feature reports (Phase 2) + dimension
// sweeps. v1 maps without this field continue to parse.

const ExpertDomainSchema = Type.Object({
    domain: Type.String({
        description:
            "kebab-case folder name (e.g., 'billing', 'websocket', " +
            "'database'). Becomes .pi/prompts/experts/<domain>/. " +
            "Invoked as /experts:<domain>:question, :self-improve, " +
            ":plan, :plan_build_improve.",
    }),
    rationale: Type.String({
        description:
            "1-line: why this domain warrants an expert " +
            "(repeated, high-stakes, tribal-knowledge-bearing).",
    }),
    primary_paths: Type.Array(Type.String(), {
        description: "Globs or concrete paths that the expert owns.",
    }),
    entry_points: Type.Array(Type.String(), {
        description: "Files a fresh agent reads first in this domain.",
    }),
    test_paths: Type.Array(Type.String(), {
        description: "Where the domain's tests live.",
    }),
    key_files: Type.Array(Type.Object({
        path: Type.String(),
        purpose: Type.String({ description: "1-line: what this file is for." }),
        line_range: Type.Tuple([
            Type.Number({ description: "Start line, 1-indexed, inclusive." }),
            Type.Number({ description: "End line, 1-indexed, inclusive." }),
        ]),
    })),
    key_types: Type.Array(Type.Object({
        name: Type.String(),
        path: Type.String({ description: "file:line of the type definition." }),
        purpose: Type.String(),
    })),
    patterns: Type.Array(Type.Object({
        name: Type.String(),
        description: Type.String(),
        example_ref: Type.String({ description: "path:line." }),
    })),
    pitfalls: Type.Array(Type.Object({
        risk: Type.String(),
        consequence: Type.String(),
        reference: Type.String({ description: "path:line." }),
    })),
    conventions: Type.Array(Type.String(), {
        description: "Domain-specific coding rules the expert enforces.",
    }),
    stability: StringEnum(["high", "medium", "low"] as const, {
        description:
            "How often this domain's code changes. High = stable, " +
            "memorize freely. Low = changes too fast, expertise " +
            "goes stale.",
    }),
    recurrence: StringEnum(["high", "medium", "low"] as const, {
        description:
            "How often this domain is queried / touched in typical " +
            "workflows. High = recurring work, expert pays off. " +
            "Low = one-off, expert is overhead.",
    }),
    test_command: Type.Union([Type.String(), Type.Null()], {
        description:
            "Test command specific to this domain (e.g., " +
            "'pytest tests/payments/ -q'). Falls back to the global " +
            "validation_surface.test_command when null. The " +
            "expert's self-improve.md runs this after any change.",
    }),
    last_updated: Type.String({
        description:
            "ISO 8601 date. Set by the builder at emission time; " +
            "updated by self-improve.md on every run. The " +
            "stale-detection signal.",
    }),
});

export const ExpertEvidenceSchema = Type.Object({
    expert_domains: Type.Array(ExpertDomainSchema, {
        description:
            "Emergent list of expert domains. Derived by the " +
            "builder in Phase 3.7 from the per-feature reports " +
            "(Phase 2) and the dimension sweeps. Capped at 8 " +
            "(same cap as features). Honest [] is valid for " +
            "tiny codebases.",
    }),
});

export type ExpertEvidence = Static<typeof ExpertEvidenceSchema>;

