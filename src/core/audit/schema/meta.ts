import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const PerAreaTemplateCandidateSchema = Type.Object({
    area_name: Type.String({
        description:
            "kebab-case area name, e.g., 'db-migration', " +
            "'api-endpoint'. Becomes the template's invocation " +
            "name ('/<area_name> <one-sentence task>').",
    }),
    issue_type: StringEnum([
        "chore",
        "bug",
        "feature",
        "refactor",
        "security",
        "docs",
        "test",
        "perf",
        "chore_deps",
    ] as const, {
        description: "The dominant change type for this area's work.",
    }),
    trigger_phrases: Type.Array(Type.String(), {
        description:
            "use_when phrases from the feature report. Become " +
            "the argument-hint for the template.",
    }),
    rationale: Type.String({
        description: "1-line: why this area warrants its own template.",
    }),
    source_feature_agent: Type.String({
        description:
            "Path to the .pi/agents/<feature>.md that this " +
            "template's body is derived from. The builder reads " +
            "conventions/pitfalls/key_types from there.",
    }),
});

const LifecycleSchema = Type.Object({
    sdlc_model: Type.String({
        description: 'e.g., "plan->build->test->review->document"',
    }),
    issue_types: Type.Array(
        StringEnum([
            "chore",
            "bug",
            "feature",
            "refactor",
            "security",
            "docs",
            "test",
            "perf",
            "chore_deps",
        ] as const),
        { description: "e.g., [chore, bug, feature]" },
    ),
    review_loop: Type.Object({
        present: Type.Boolean(),
        kind: StringEnum([
            "none",
            "pr_review",
            "automated_check",
            "ai_verifier",
            "multi_tier",
            "human_in_the_loop",
        ] as const),
    }),
    documentation_loop: Type.Object({
        present: Type.Boolean(),
        kind: StringEnum([
            "none",
            "app_docs",
            "ai_docs",
            "conditional_docs",
            "full",
        ] as const),
    }),
    conditional_docs: Type.Object({
        present: Type.Boolean(),
        path: Type.Union([Type.String(), Type.Null()]),
        last_updated: Type.Union([Type.String(), Type.Null()]),
        entries_count: Type.Number(),
    }),
    aiw_scripts: Type.Array(Type.Object({
        name: Type.String(),
        path: Type.String(),
        trigger: StringEnum([
            "cron",
            "webhook",
            "manual",
            "scheduled",
            "event",
        ] as const),
    })),
    agent_definitions: Type.Object({
        count: Type.Number(),
        paths: Type.Array(Type.String()),
    }),
    per_area_template_candidates: Type.Optional(Type.Array(
        PerAreaTemplateCandidateSchema,
    )),
    has_review_loop: Type.Optional(Type.Boolean()),
    has_documentation_loop: Type.Optional(Type.Boolean()),
    has_conditional_docs: Type.Optional(Type.Boolean()),
});

const DocumentationSchema = Type.Object({
    agents_md: Type.Union([Type.String(), Type.Null()], {
        description: "Path to AGENTS.md, or null if not present.",
    }),
    agents_md_line_count: Type.Union([Type.Number(), Type.Null()]),
    has_ai_docs: Type.Boolean(),
    has_app_docs: Type.Boolean(),
    has_specs: Type.Boolean(),
    conditional_docs_path: Type.Union([Type.String(), Type.Null()]),
    readme_metrics: Type.Object({
        present: Type.Boolean(),
        line_count: Type.Number(),
        section_count: Type.Number(),
    }),
    ai_docs_freshness: Type.Object({
        last_updated: Type.Union([Type.String(), Type.Null()]),
        file_count: Type.Number(),
    }),
    specs_archive: Type.Object({
        present: Type.Boolean(),
        file_count: Type.Number(),
        date_range: Type.Union([Type.String(), Type.Null()]),
    }),
    postmortems_dir: Type.Union([Type.String(), Type.Null()]),
    changelog_present: Type.Boolean(),
    existing_pi_extensions: Type.Optional(Type.Array(Type.String(), {
        description:
            "Paths of files in .pi/extensions/ (relative to cwd). " +
            "Empty if the directory does not exist.",
    })),
    existing_pi_skills: Type.Optional(Type.Array(Type.String(), {
        description:
            "Names of skill directories in .pi/skills/ (e.g. " +
            "['prime-db', 'deploy']). Empty if the directory does not exist.",
    })),
    existing_pi_prompts: Type.Optional(Type.Array(Type.String(), {
        description: "Paths of files in .pi/prompts/ (relative to cwd).",
    })),
});

const ExternalDependenciesSchema = Type.Object({
    runtime: Type.Array(
        Type.Object({
            name: Type.String(),
            version: Type.String(),
        }),
        { description: "Runtime dependencies from the primary manifest." },
    ),
    dev: Type.Array(
        Type.Object({
            name: Type.String(),
            version: Type.String(),
        }),
        { description: "Dev-only dependencies (test/lint/typecheck tooling)." },
    ),
});

const ExistingPlanningArtifactSchema = Type.Object({
    present: Type.Boolean(),
    path: Type.Union([Type.String(), Type.Null()]),
    format_hint: Type.Union([Type.String(), Type.Null()], {
        description:
            "One-line observation of the existing format, e.g., " +
            "'docs/RFC-*.md (YAML frontmatter + ## Decision sections)'.",
    }),
});

export const MetaSchema = Type.Object({
    project_type: Type.String({
        description: "e.g., 'nextjs-ecommerce', 'fastapi-saas'",
    }),
    languages: Type.Array(Type.String()),
    frameworks: Type.Array(Type.String()),
    domain_hypothesis: Type.String({ description: "One sentence." }),
    focus_areas: Type.Optional(Type.Array(Type.String())),
    lifecycle: LifecycleSchema,
    documentation: DocumentationSchema,
    external_dependencies: Type.Optional(ExternalDependenciesSchema),
    suggested_subagent_domains: Type.Optional(
        Type.Array(Type.String(), {
            description:
                "Top-level non-trivial dirs (excluding node_modules, " +
                ".git, dist, build, __pycache__, .venv, target), " +
                "capped at 5. Derived deterministically from D1 + D2.",
        }),
    ),
    existing_planning_artifact: Type.Optional(ExistingPlanningArtifactSchema),
});
