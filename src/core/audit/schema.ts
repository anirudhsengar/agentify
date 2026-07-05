// schema.ts
//
// TypeBox schemas for the 10-dimension codebase map and the
// write_map custom tool. This is the contract between the
// exploration sub-agents and the audit renderer.
//
// The schema is the durable artifact that downstream tools consume.
// Every section is required; the tool injects defaults for
// schema_version and generated_at if missing.
//
// Top-level fields of CodebaseMapSchema:
//   schema_version        — always "1" for now
//   generated_at          — ISO 8601, set by the tool
//   meta                  — project identity + lifecycle + docs
//   skeleton              — top-level tree, entry points, mirror
//   module_graph          — edges, parallelizable subtrees, split
//   type_contract_surface — TS/Pydantic/ORM models, traces
//   conventions           — naming, errors, logging, file size
//   pitfalls              — 3-5 risks per major module
//   validation_surface    — test/lint/typecheck/E2E commands
//   operational_surface   — build/run/deploy, env, ports, shutdown
//   security_surface      — path/command/env classifications
//   coverage              — the gate: every area must reach "covered"
//   open_questions        — gaps the audit couldn't resolve
//   exploration_log       — append-only audit trail
//
// The `coverage` block is the gate — see Golden Rule #7 in
// AGENTS.md: no AGENTS.md is emitted unless every area is covered.
//
// Phase 2.9: each dimension schema is extended with the new fields
// from the gap report's coverage gaps. The expansion is additive:
// v1 maps (without the new fields) continue to parse as v2.

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

// ============================================================================
// Coverage dimensions (declared early so PartialCodebaseMapSchema can use it)
// ============================================================================

export const COVERAGE_DIMENSIONS = [
    "D1_topography",
    "D2_module_boundaries",
    "D3_type_contract",
    "D4_conventions",
    "D5_pitfalls",
    "D6_validation",
    "D7_operational",
    "D8_security",
    "D9_process",
    "D10_documentation",
] as const;

export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

// ============================================================================
// Coverage status (the gate)
// ============================================================================

export const CoverageStatusSchema = StringEnum(["covered", "gap"], {
    description:
        "covered = adequately explored for this codebase's size and shape. " +
        "gap = uncovered; the run will fail to emit AGENTS.md until closed.",
});

export const ConfidenceSchema = StringEnum(["high", "medium", "low"]);

export const DimensionStatusSchema = Type.Object({
    status: CoverageStatusSchema,
    confidence: ConfidenceSchema,
    evidence_summary: Type.String({
        description:
            "1-2 sentence summary of what was found. Used verbatim in AGENTS.md.",
    }),
});

// ============================================================================
// meta (project identity + D9 process + D10 documentation)
// ============================================================================

// Per-area template candidate. Declared
// before LifecycleSchema so it can be referenced. One per
// recurring work area identified during exploration.
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
    // Phase 2.9i — typed issue types.
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
    // Phase 2.9i — typed review loop.
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
    // Phase 2.9i — typed documentation loop.
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
    // Phase 2.9i — full conditional docs block.
    conditional_docs: Type.Object({
        present: Type.Boolean(),
        path: Type.Union([Type.String(), Type.Null()]),
        last_updated: Type.Union([Type.String(), Type.Null()]),
        entries_count: Type.Number(),
    }),
    // Phase 2.9i — AIW inventory.
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
    // Phase 2.9i — agent definition inventory.
    agent_definitions: Type.Object({
        count: Type.Number(),
        paths: Type.Array(Type.String()),
    }),
    // Per-area template candidates.
    // Synthesized by the builder in Phase 3.6 from the per-feature
    // reports. One entry per recurring work area that warrants its
    // own .pi/prompts/<area_name>.md template. The template body is
    // derived from the source_feature_agent's conventions, pitfalls,
    // and key_types (already collected by the custom sub-agents in
    // Phase 2). Optional; v1 maps without it continue to parse.
    per_area_template_candidates: Type.Optional(Type.Array(
        PerAreaTemplateCandidateSchema,
    )),
    // Backward-compat — kept for v1 maps; the new fields above
    // are the source of truth.
    has_review_loop: Type.Optional(Type.Boolean()),
    has_documentation_loop: Type.Optional(Type.Boolean()),
    has_conditional_docs: Type.Optional(Type.Boolean()),
});

const DocumentationSchema = Type.Object({
    agents_md: Type.Union([Type.String(), Type.Null()], {
        description: "Path to AGENTS.md, or null if not present.",
    }),
    // Phase 2.9j — line count of AGENTS.md.
    agents_md_line_count: Type.Union([Type.Number(), Type.Null()]),
    has_ai_docs: Type.Boolean(),
    has_app_docs: Type.Boolean(),
    has_specs: Type.Boolean(),
    conditional_docs_path: Type.Union([Type.String(), Type.Null()]),
    // Phase 2.9j — README metrics.
    readme_metrics: Type.Object({
        present: Type.Boolean(),
        line_count: Type.Number(),
        section_count: Type.Number(),
    }),
    // Phase 2.9j — AI docs freshness.
    ai_docs_freshness: Type.Object({
        last_updated: Type.Union([Type.String(), Type.Null()]),
        file_count: Type.Number(),
    }),
    // Phase 2.9j — specs archive.
    specs_archive: Type.Object({
        present: Type.Boolean(),
        file_count: Type.Number(),
        date_range: Type.Union([Type.String(), Type.Null()]),
    }),
    // Phase 2.9j — postmortems dir.
    postmortems_dir: Type.Union([Type.String(), Type.Null()]),
    // Phase 2.9j — changelog presence.
    changelog_present: Type.Boolean(),
    // Enumeration of the user's existing
    // .pi/ subdirectories. These are paths *relative to cwd* (e.g.
    // ".pi/extensions/damage-control.ts"). Empty array = directory
    // does not exist. Used by the builder to avoid overwriting
    // user-authored extensions, skills, and prompts in Phase 9.6.
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

// Always-on-artifact evidence. These three fields
// give the builder enough context to emit `ai_docs/README.md`,
// `.pi/agents/*.md`, and `.pi/prompts/plan.md` after the audit
// audit passes. All three are optional; v1 maps without them
// continue to parse.
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

const MetaSchema = Type.Object({
    project_type: Type.String({
        description: "e.g., 'nextjs-ecommerce', 'fastapi-saas'",
    }),
    languages: Type.Array(Type.String()),
    // Phase 2.9a — moved from Skeleton to Meta; kept on both for
    // backward-compat. The Meta version is the source of truth.
    frameworks: Type.Array(Type.String()),
    domain_hypothesis: Type.String({ description: "One sentence." }),
    // Phase 2.9i — focus areas (Phase 5.1 --focus).
    focus_areas: Type.Optional(Type.Array(Type.String())),
    lifecycle: LifecycleSchema,
    documentation: DocumentationSchema,
    // Always-on-artifact evidence.
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

// ============================================================================
// D1 Topography — the skeleton section
// ============================================================================

const EntryPointSchema = Type.Object({
    path: Type.String(),
    role: Type.String(),
    language: Type.String(),
    run_command: Type.String(),
});

const CodeTestMirrorSchema = Type.Object({
    observed: Type.Boolean(),
    pattern: Type.String(),
});

const AppVsAgenticLayerSchema = Type.Object({
    app_layer: Type.String(),
    agentic_layer: Type.Union([Type.String(), Type.Null()]),
    bleed_risk_paths: Type.Array(Type.String()),
});

const FirstFileSchema = Type.Object({
    path: Type.String(),
    why: Type.String({
        description: "One-line reason a fresh agent should read this file first.",
    }),
});

// Phase 2.9a — test_infrastructure sub-schema.
const TestInfrastructureSchema = Type.Object({
    test_command: Type.String(),
    test_file_pattern: Type.String(),
    test_runner: Type.String(),
});

const SkeletonSchema = Type.Object({
    top_level_tree: Type.Array(Type.String(), {
        description: "60-second whiteboard tree, as a list of paths.",
    }),
    entry_points: Type.Array(EntryPointSchema),
    code_test_mirror: CodeTestMirrorSchema,
    first_5_files_for_fresh_agent: Type.Array(FirstFileSchema, {
        description: "3-5 files for a fresh agent to read first.",
    }),
    app_vs_agentic_layer: AppVsAgenticLayerSchema,
    // Phase 2.9a — additional D1 fields.
    frameworks: Type.Optional(Type.Array(Type.String())),
    test_infrastructure: Type.Optional(TestInfrastructureSchema),
    convention_signals: Type.Optional(Type.Object({
        uses_print: Type.Boolean(),
        uses_logging: Type.Boolean(),
        has_app_agents_docs: Type.Boolean(),
    })),
    dev_command: Type.Optional(Type.String()),
});

// ============================================================================
// D2 Module Boundaries
// ============================================================================

const ModuleEdgeSchema = Type.Object({
    from: Type.String(),
    to: Type.String(),
    kind: StringEnum(["import", "state", "rpc"]),
});

const ClientServerSplitSchema = Type.Object({
    client: Type.String(),
    server: Type.String(),
});

// Phase 2.9b — monorepo workspace sub-schema.
const MonorepoWorkspaceSchema = Type.Object({
    kind: StringEnum(["yarn", "pnpm", "turborepo", "nx", "rush", "other"] as const),
    config_file: Type.String(),
});

const ModuleGraphSchema = Type.Object({
    edges: Type.Array(ModuleEdgeSchema, {
        description: "Top-level only. Pick the 10-20 most important.",
    }),
    parallelizable_subtrees: Type.Array(Type.Array(Type.String()), {
        description: "Clusters of paths that don't depend on each other.",
    }),
    shared_state: Type.Array(Type.String(), {
        description: "DBs, env files, ports, queues.",
    }),
    client_server_split: Type.Union([ClientServerSplitSchema, Type.Null()]),
    shared_abstractions: Type.Array(Type.String(), {
        description: "core/, lib/, shared/, common/ — depended on by many.",
    }),
    // Phase 2.9b — additional D2 fields.
    import_depth: Type.Optional(Type.Object({
        max_depth: Type.Number(),
        avg_depth: Type.Number(),
    })),
    circular_dependencies: Type.Optional(Type.Array(Type.Array(Type.String()))),
    monorepo_workspace: Type.Optional(Type.Union([MonorepoWorkspaceSchema, Type.Null()])),
});

// ============================================================================
// D3 Type & Contract Surface
// ============================================================================

const TypeDefSchema = Type.Object({
    path: Type.String(),
    name: Type.String(),
    fields: Type.Array(Type.String()),
});

const DbModelSchema = Type.Object({
    path: Type.String(),
    name: Type.String(),
    table: Type.String(),
    fields: Type.Array(Type.String()),
});

const OpenApiSchema = Type.Object({
    path: Type.String(),
    schema_kind: StringEnum(["openapi", "graphql", "grpc"]),
    endpoint_count: Type.Number(),
});

const OneTypeTraceSchema = Type.Object({
    name: Type.String(),
    flow: Type.Array(Type.String(), {
        description: "Ordered end-to-end list of file paths.",
    }),
});

const TypeContractSurfaceSchema = Type.Object({
    pydantic_models: Type.Array(TypeDefSchema),
    typescript_interfaces: Type.Array(TypeDefSchema),
    // Phase 2.9c — api_contracts replaces openapi_or_graphql.
    api_contracts: Type.Optional(Type.Array(OpenApiSchema)),
    // Backward-compat — v1 maps may use this singular form.
    openapi_or_graphql: Type.Optional(Type.Union([OpenApiSchema, Type.Null()])),
    db_models: Type.Array(DbModelSchema),
    idks: Type.Array(Type.String(), {
        description: "The high-leverage grep-able names.",
    }),
    // Phase 2.9c — typed synced_types.
    synced_types: Type.Optional(Type.Object({
        synced: Type.Array(Type.String()),
        unsynced: Type.Array(Type.String()),
    })),
    // Backward-compat — v1 maps may have this boolean.
    synced_types_observed: Type.Optional(Type.Boolean()),
    // Phase 2.9c — idk coverage counter.
    idk_coverage: Type.Optional(Type.Object({
        min_required: Type.Number({ default: 10 }),
        actual: Type.Number(),
    })),
    stable_types: Type.Array(Type.String()),
    volatile_types: Type.Array(Type.String()),
    one_type_trace: Type.Union([OneTypeTraceSchema, Type.Null()]),
});

// ============================================================================
// D4 Conventions
// ============================================================================

const NamingSchema = Type.Object({
    files: Type.String({ description: "Pattern, e.g., 'snake_case.py'" }),
    classes: Type.String(),
    functions: Type.String(),
    branches: Type.String(),
    commits: Type.String(),
});

const ErrorHandlingSchema = Type.Object({
    raise_vs_return: StringEnum(["raise", "return", "mixed"]),
    custom_exceptions: Type.Boolean(),
    log_then_throw: Type.Boolean(),
});

const LoggingSchema = Type.Object({
    pattern: Type.String(),
    observed: Type.Boolean(),
});

const FileSizeSchema = Type.Object({
    observed_avg: Type.Number(),
    observed_max: Type.Number(),
});

const PatternSchema = Type.Object({
    name: Type.String(),
    where: Type.String({ description: "path:line" }),
    description: Type.String(),
});

// Phase 2.9d — comment style and import ordering sub-schemas.
const CommentStyleSchema = Type.Object({
    docstring: Type.String(),
    inline: Type.String(),
});

const ImportOrderingSchema = Type.Object({
    style: StringEnum([
        "alphabetical",
        "stdlib_first",
        "thirdparty_first",
        "unsorted",
        "mixed",
    ] as const),
    enforced_by: Type.Union([Type.String(), Type.Null()]),
});

// Phase 2.9d — versioning and db_migration sub-schemas.
const VersioningSchema = Type.Object({
    kind: StringEnum(["semver", "calver", "custom"] as const),
    config_file: Type.String(),
});

const DbMigrationSchema = Type.Object({
    tool: StringEnum(["alembic", "knex", "prisma", "drizzle", "other"] as const),
    config_file: Type.String(),
});

const ConventionsSchema = Type.Object({
    naming: NamingSchema,
    error_handling: ErrorHandlingSchema,
    logging: LoggingSchema,
    state_passing: StringEnum([
        "constructor_injection",
        "di",
        "globals",
        "context_vars",
        "env_vars",
        "mixed",
    ]),
    file_size: FileSizeSchema,
    patterns: Type.Array(PatternSchema),
    // Phase 2.9d — additional D4 fields.
    comment_style: Type.Optional(CommentStyleSchema),
    import_ordering: Type.Optional(ImportOrderingSchema),
    type_hint_coverage_pct: Type.Optional(Type.Number()),
    test_naming: Type.Optional(Type.String()),
    versioning: Type.Optional(Type.Union([VersioningSchema, Type.Null()])),
    db_migration: Type.Optional(Type.Union([DbMigrationSchema, Type.Null()])),
});

// ============================================================================
// D5 Pitfalls (Phase 2.9e — extended with category)
// ============================================================================

const PitfallCategorySchema = StringEnum([
    "silent_corruption",
    "data_loss",
    "security_vulnerability",
    "performance_regression",
    "undefined_behavior",
    "concurrency_hazard",
    "todo_marker",
    "deprecation",
    "other",
] as const);

const PitfallSchema = Type.Object({
    module: Type.String(),
    what: Type.String(),
    consequence: Type.String(),
    line_ref: Type.Number({ description: "Line number in the module." }),
    // Phase 2.9e — typed category.
    category: Type.Optional(PitfallCategorySchema),
});

// ============================================================================
// D6 Validation Surface (Phase 2.9f — extended)
// ============================================================================

const PerChangeTypeSchema = Type.Object({
    mandatory: Type.Array(Type.String()),
    optional: Type.Array(Type.String()),
});

const CiGateSchema = Type.Object({
    name: Type.String(),
    command: Type.String(),
    required: Type.Boolean(),
    on_events: Type.Array(Type.String()),
    run_time_s: Type.Number(),
});

const ValidationSurfaceSchema = Type.Object({
    test_command: Type.String(),
    test_runtime_seconds_estimate: Type.Number(),
    lint_command: Type.Union([Type.String(), Type.Null()]),
    typecheck_command: Type.Union([Type.String(), Type.Null()]),
    e2e_command: Type.Union([Type.String(), Type.Null()]),
    spec_compliance_evidence: Type.Array(Type.String()),
    severity_taxonomy: Type.Array(Type.String()),
    per_change_type: Type.Object({
        chore: PerChangeTypeSchema,
        bug: PerChangeTypeSchema,
        feature: PerChangeTypeSchema,
        // Phase 2.9f — additional change types.
        refactor: Type.Optional(PerChangeTypeSchema),
        security: Type.Optional(PerChangeTypeSchema),
    }),
    // Phase 2.9f — additional D6 fields.
    test_count: Type.Optional(Type.Number()),
    code_coverage_pct: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    mutation_testing: Type.Optional(Type.Object({
        present: Type.Boolean(),
        tool: Type.Union([Type.String(), Type.Null()]),
    })),
    test_failure_summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ci_gates: Type.Optional(Type.Array(CiGateSchema)),
    // E2E navigation hints. The /review
    // command reads `e2e_test_files` as navigation hints (per
    // lesson-06 § The `/review` Prompt) and `e2e_config_path`
    // to know which E2E framework the project uses. Both are
    // optional; v1 maps without them continue to parse.
    e2e_test_files: Type.Optional(Type.Array(Type.String(), {
        description:
            "Glob-relative paths of E2E test files (e.g. " +
            "['e2e/login.spec.ts', 'e2e/checkout.spec.ts']). " +
            "Used as navigation hints by the review agent; " +
            "not executed.",
    })),
    e2e_config_path: Type.Optional(Type.Union([Type.String(), Type.Null()], {
        description:
            "Path to the E2E config (e.g. 'playwright.config.ts', " +
            "'cypress.config.js') or null if no config exists.",
    })),
});

// ============================================================================
// D7 Operational Surface (Phase 2.9g — extended)
// ============================================================================

const BuildSchema = Type.Object({
    command: Type.String(),
    recipe_file: Type.String(),
});

const RunSchema = Type.Object({
    command: Type.String(),
    env_vars_required: Type.Array(Type.String()),
    ports: Type.Array(Type.Number()),
    services: Type.Array(Type.String()),
    dependencies: Type.Array(Type.String()),
});

const DeploySchema = Type.Object({
    target: Type.String(),
    command: Type.String(),
});

const EnvVarSchema = Type.Object({
    name: Type.String(),
    required: Type.Boolean(),
    secret: Type.Boolean(),
    public: Type.Boolean(),
    per_host: Type.Boolean(),
});

const CiCdSchema = Type.Object({
    triggers: Type.Array(Type.String()),
    gates: Type.Array(Type.String()),
    artifacts: Type.Array(Type.String()),
});

const GitWorkflowSchema = Type.Object({
    main_branch: Type.String(),
    branch_naming: Type.String(),
    worktree_pattern: Type.String(),
    cleanup: Type.String(),
});

const PortRangesSchema = Type.Object({
    dev: Type.String(),
    prod: Type.Optional(Type.String()),
});

const ShutdownProcedureSchema = Type.Object({
    script: Type.Union([Type.String(), Type.Null()]),
    commands: Type.Array(Type.String()),
    // Phase 2.9g — fallback_behavior on missing script.
    fallback_behavior: Type.Optional(Type.String()),
});

const SpawnedSubprocessSchema = Type.Object({
    name: Type.String(),
    binary: Type.String(),
    role: Type.String(),
    // Phase 2.9g — group for related subprocesses.
    group: Type.Optional(Type.String()),
});

const BuildRecipeSchema = Type.Object({
    steps: Type.Array(Type.String()),
    env: Type.Record(Type.String(), Type.String()),
    dependencies: Type.Array(Type.String()),
});

const OperationalSurfaceSchema = Type.Object({
    build: BuildSchema,
    run: RunSchema,
    deploy: Type.Union([DeploySchema, Type.Null()]),
    // Phase 2.9g — multiple deploy targets.
    deploy_targets: Type.Optional(Type.Array(DeploySchema)),
    env_vars: Type.Array(EnvVarSchema),
    ci_cd: CiCdSchema,
    git_workflow: GitWorkflowSchema,
    port_ranges: PortRangesSchema,
    shutdown_procedure: ShutdownProcedureSchema,
    spawned_subprocesses: Type.Array(SpawnedSubprocessSchema),
    // Phase 2.9g — additional D7 fields.
    env_var_purposes: Type.Optional(Type.Record(Type.String(), Type.String())),
    port_determinism: Type.Optional(Type.Object({
        is_deterministic: Type.Boolean(),
        range: Type.String(),
    })),
    build_recipe: Type.Optional(BuildRecipeSchema),
    // Extended operational-surface fields used as input
    // for custom tool candidate generation. All three are
    // optional; v1 maps without them continue to parse.
    //
    // package_json_scripts is the FULL scripts block from
    // package.json (key -> command). Empty object if no
    // package.json exists, or if it has no scripts block.
    // This is the #1 source of custom-tool candidates: every
    // script is a candidate to be wrapped as pi.registerTool().
    package_json_scripts: Type.Optional(Type.Record(
        Type.String(),
        Type.String(),
        {
            description:
                "The full 'scripts' block from package.json " +
                "(key -> command). Empty if no package.json " +
                "or no scripts block.",
        },
    )),
    // scripts_dir_files is the one-level-deep listing of
    // filenames in scripts/ (or equivalent). Each non-trivial
    // file is a candidate to be wrapped as a skill or tool.
    scripts_dir_files: Type.Optional(Type.Array(Type.String(), {
        description:
            "Filenames in scripts/ (one level deep). Used to " +
            "identify tool/skill candidates.",
    })),
    // typescript_environment is the readiness check for emitting
    // TypeScript extensions. If has_tsconfig is false AND
    // package_manager is "none" / "other", the builder skips
    // extension generation and emits skills only.
    typescript_environment: Type.Optional(Type.Object({
        has_tsconfig: Type.Boolean({ description: "True if tsconfig.json exists in cwd." }),
        has_bun: Type.Boolean({ description: "True if bun.lockb or bunfig.toml exists." }),
        has_pnpm: Type.Boolean({ description: "True if pnpm-lock.yaml exists." }),
        has_npm: Type.Boolean({ description: "True if package-lock.json exists." }),
        has_yarn: Type.Boolean({ description: "True if yarn.lock exists." }),
        package_manager: StringEnum([
            "bun", "pnpm", "npm", "yarn", "other", "none",
        ] as const, { description: "Detected package manager." }),
        node_version: Type.Union([Type.String(), Type.Null()], {
            description: "Node.js version from .nvmrc / .node-version, or null.",
        }),
    })),
    // The review-loop prepare-app
    // surface. The /review command's "Step 1: Prepare the
    // app" reads these fields. All four are optional; null
    // means "the project has no such step; skip it". The
    // review agent falls back gracefully when any field is
    // null (per the conditional rendering in
    // `.pi/agents/review.md` Phase 9.5).
    prepare_app: Type.Optional(Type.Object({
        reset_db: Type.Union([Type.String(), Type.Null()], {
            description:
                "Path to a DB-reset script (e.g. 'scripts/reset_db.sh') " +
                "or null if the project has no reset step.",
        }),
        start: Type.Union([Type.String(), Type.Null()], {
            description:
                "Path to an app-start script (e.g. 'scripts/start.sh') " +
                "or null. The review agent runs this in the background.",
        }),
        stop: Type.Union([Type.String(), Type.Null()], {
            description:
                "Path to a stop/cleanup script (e.g. 'scripts/stop_apps.sh') " +
                "or null. The review agent runs this when review completes.",
        }),
        health_check_url: Type.Union([Type.String(), Type.Null()], {
            description:
                "URL the review agent polls (e.g. 'http://localhost:8000/health') " +
                "until it returns 200, before taking screenshots. Null if no " +
                "health endpoint is known.",
        }),
        app_url: Type.Union([Type.String(), Type.Null()], {
            description:
                "URL the review agent navigates to for screenshots (e.g. " +
                "'http://localhost:5173'). Null if the project is non-UI.",
        }),
    })),
});

// ============================================================================
// D8 Security & Trust Surface (Phase 2.9h — extended)
// ============================================================================

const PathClassificationsSchema = Type.Object({
    zero_access: Type.Array(Type.String()),
    read_only: Type.Array(Type.String()),
    no_delete: Type.Array(Type.String()),
    fully_writable: Type.Array(Type.String()),
});

const SecurityChecklistSchema = Type.Object({
    tools: Type.Array(Type.String()),
    commands: Type.Array(Type.String()),
    paths: Type.Array(Type.String()),
    env: Type.Array(Type.String()),
    blocks: Type.Array(Type.String()),
    logs: Type.Array(Type.String()),
});

// Phase 2.9h — typed production credentials and external network calls.
const ProductionCredentialSchema = Type.Object({
    name: Type.String(),
    category: StringEnum([
        "database",
        "llm",
        "monitoring",
        "ci",
        "cloud",
        "other",
    ] as const),
});

const ExternalNetworkCallSchema = Type.Object({
    host: Type.String(),
    purpose: Type.String(),
});

// Phase 2.9h — typed damage control rules and escape hatch.
const DamageControlRulesSchema = Type.Object({
    bash_tool_patterns: Type.Array(Type.String()),
    zero_access_paths: Type.Array(Type.String()),
    read_only_paths: Type.Array(Type.String()),
    no_delete_paths: Type.Array(Type.String()),
});

const EscapeHatchSchema = Type.Object({
    blocking_unblock_path: Type.String(),
    escalation_contact: Type.Union([Type.String(), Type.Null()]),
});

// Phase 2.9h — typed banned interpreters.
const BannedInterpreterSchema = StringEnum([
    "python",
    "node",
    "bash",
    "sh",
    "ruby",
    "perl",
    "powershell",
    "zsh",
    "fish",
    "other",
] as const);

const SecuritySurfaceSchema = Type.Object({
    paths: PathClassificationsSchema,
    bash_safe_patterns: Type.Array(Type.String()),
    bash_blocked_patterns: Type.Array(Type.String()),
    banned_interpreters: Type.Array(BannedInterpreterSchema),
    env_allowlist: Type.Array(Type.String()),
    production_credentials: Type.Array(ProductionCredentialSchema),
    // Backward-compat — v1 maps used a flat string array.
    production_credentials_v1: Type.Optional(Type.Array(Type.String())),
    damage_control_rules: Type.Array(Type.String()),
    security_checklist: SecurityChecklistSchema,
    // Phase 2.9h — additional D8 fields.
    damage_control_rules_typed: Type.Optional(DamageControlRulesSchema),
    escape_hatch: Type.Optional(EscapeHatchSchema),
    external_network_calls: Type.Optional(Type.Array(ExternalNetworkCallSchema)),
});

// ============================================================================
// Custom-tool and skill candidate derivation
// ============================================================================
//
// Declared before CodebaseMapSchema so the schema can reference it
// in its top-level `grade3_evidence` field. Used by Phase 9.6 of
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

export const Grade3EvidenceSchema = Type.Object({
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

export type Grade3Evidence = Static<typeof Grade3EvidenceSchema>;

// ============================================================================
// Agent-expert domains
// ============================================================================
//
// Mirrors the grade3_evidence pattern. Each expert domain becomes
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

export const Grade7EvidenceSchema = Type.Object({
    expert_domains: Type.Array(ExpertDomainSchema, {
        description:
            "Emergent list of expert domains. Derived by the " +
            "builder in Phase 3.7 from the per-feature reports " +
            "(Phase 2) and the dimension sweeps. Capped at 8 " +
            "(same cap as features). Honest [] is valid for " +
            "tiny codebases.",
    }),
});

export type Grade7Evidence = Static<typeof Grade7EvidenceSchema>;

// ============================================================================
// Coverage matrix (the gate)
// ============================================================================

const CoverageMatrixSchema = Type.Object({
    D1_topography: DimensionStatusSchema,
    D2_module_boundaries: DimensionStatusSchema,
    D3_type_contract: DimensionStatusSchema,
    D4_conventions: DimensionStatusSchema,
    D5_pitfalls: DimensionStatusSchema,
    D6_validation: DimensionStatusSchema,
    D7_operational: DimensionStatusSchema,
    D8_security: DimensionStatusSchema,
    D9_process: DimensionStatusSchema,
    D10_documentation: DimensionStatusSchema,
});

// ============================================================================
// Open questions and exploration log
// ============================================================================

const OpenQuestionsSchema = Type.Array(Type.String());

const ExplorationLogEntrySchema = Type.Object({
    ts: Type.String({ description: "ISO 8601 timestamp" }),
    action: Type.String(),
    target: Type.String(),
    observation: Type.String(),
});

const ExplorationLogSchema = Type.Array(ExplorationLogEntrySchema);

// ============================================================================
// The full CodebaseMap (the contract)
// ============================================================================

export const CodebaseMapSchema = Type.Object({
    schema_version: Type.Optional(Type.String({
        description: 'Set by the write_map tool. Always "1" for now.',
    })),
    generated_at: Type.Optional(Type.String({
        description: "ISO 8601 timestamp. Set by the write_map tool.",
    })),
    meta: MetaSchema,
    skeleton: SkeletonSchema,
    module_graph: ModuleGraphSchema,
    type_contract_surface: TypeContractSurfaceSchema,
    conventions: ConventionsSchema,
    pitfalls: Type.Array(PitfallSchema),
    validation_surface: ValidationSurfaceSchema,
    operational_surface: OperationalSurfaceSchema,
    security_surface: SecuritySurfaceSchema,
    coverage: CoverageMatrixSchema,
    open_questions: OpenQuestionsSchema,
    exploration_log: Type.Array(ExplorationLogEntrySchema),
    // Phase 4.5 — schema migration history.
    schema_migration_history: Type.Optional(Type.Array(Type.Object({
        from: Type.String(),
        to: Type.String(),
        migrated_at: Type.String(),
        notes: Type.String(),
    }))),
    // Emergent list of custom-tool and
    // skill candidates derived by the LLM from the rest of the
    // map (D6 test/lint/typecheck, D7 scripts, scripts/ dir,
    // package.json scripts). Used by Phase 9.6 to emit
    // .pi/extensions/*.ts and .pi/skills/<name>/SKILL.md. v1
    // maps without this field continue to parse.
    grade3_evidence: Type.Optional(Grade3EvidenceSchema),
    // Agent-expert domains. Emergent list of
    // expert domains derived by the LLM from the per-feature
    // reports (Phase 2) and D3.stable_types. Used by Phase
    // 9.10 to emit .pi/prompts/experts/<domain>/{expertise.yaml,
    // question.md, self-improve.md, [plan.md],
    // [plan_build_improve.md]}. v1 maps without this field
    // continue to parse.
    grade7_evidence: Type.Optional(Grade7EvidenceSchema),
});

export type CodebaseMap = Static<typeof CodebaseMapSchema>;

// ============================================================================
// PartialCodebaseMapSchema — for write_map_delta (Phase 1.2)
// ============================================================================

/**
 * A version of the codebase map where every top-level field is
 * optional. Used by the `write_map_delta` custom tool to merge
 * partial updates from `gap_filler` sub-agents into the canonical
 * map. The shape of each top-level section is the same as the
 * canonical schema; only the "required-ness" is relaxed.
 */
export const PartialCodebaseMapSchema = Type.Object({
    schema_version: Type.Optional(Type.String()),
    generated_at: Type.Optional(Type.String()),
    meta: Type.Optional(MetaSchema),
    skeleton: Type.Optional(SkeletonSchema),
    module_graph: Type.Optional(ModuleGraphSchema),
    type_contract_surface: Type.Optional(TypeContractSurfaceSchema),
    conventions: Type.Optional(ConventionsSchema),
    pitfalls: Type.Optional(Type.Array(PitfallSchema)),
    validation_surface: Type.Optional(ValidationSurfaceSchema),
    operational_surface: Type.Optional(OperationalSurfaceSchema),
    security_surface: Type.Optional(SecuritySurfaceSchema),
    coverage: Type.Optional(
        Type.Object(
            COVERAGE_DIMENSIONS.reduce<Record<string, typeof DimensionStatusSchema>>(
                (acc, dim) => {
                    acc[dim] = DimensionStatusSchema;
                    return acc;
                },
                {},
            ),
        ),
    ),
    open_questions: Type.Optional(OpenQuestionsSchema),
    exploration_log: Type.Optional(ExplorationLogSchema),
    // Also optional on the partial schema so
    // write_map_delta can update grade3_evidence incrementally.
    grade3_evidence: Type.Optional(Grade3EvidenceSchema),
    // Also optional on the partial schema
    // so write_map_delta can update grade7_evidence incrementally.
    grade7_evidence: Type.Optional(Grade7EvidenceSchema),
});

export type PartialCodebaseMap = Static<typeof PartialCodebaseMapSchema>;

// ============================================================================
// write_map tool parameters
// ============================================================================

export const WriteMapParamsSchema = Type.Object({
    map: Type.Optional(CodebaseMapSchema),
    map_file: Type.Optional(
        Type.String({
            description:
                "Path (absolute or cwd-relative) to a JSON file containing the codebase map. Use for large maps (> 3KB) or when the LLM has built the JSON via the `write` tool. The tool reads, validates, and writes the canonical map to ./.pi/agentify/codebase_map.json.",
        }),
    ),
    mode: Type.Optional(
        StringEnum(["inline", "file", "auto"] as const, {
            default: "auto",
            description:
                "Persist mode. `inline` (strict) errors if the inline map exceeds 100KB. `file` (strict) requires explicit `map_file`. `auto` (default) falls back to file-based persistence transparently when inline exceeds the cap.",
        }),
    ),
});

export type WriteMapParams = Static<typeof WriteMapParamsSchema>;

// ============================================================================
// write_map_delta tool parameters (Phase 1.2)
// ============================================================================

export const WriteMapDeltaParamsSchema = Type.Object({
    dimension: Type.Optional(
        StringEnum(COVERAGE_DIMENSIONS, {
            description: "The dimension this delta closes. If provided, the corresponding coverage entry is set to `covered` with the delta's `confidence` and `evidence_summary`.",
        }),
    ),
    confidence: Type.Optional(
        StringEnum(["high", "medium", "low"] as const, {
            description: "Confidence level for the delta. Used for the dimension's coverage entry.",
        }),
    ),
    evidence_summary: Type.Optional(
        Type.String({
            description: "1-2 sentence summary of what was found. Used verbatim in AGENTS.md.",
        }),
    ),
    delta: PartialCodebaseMapSchema,
    merge_strategy: Type.Optional(
        StringEnum(["shallow_overwrite", "deep_merge", "append"] as const, {
            default: "shallow_overwrite",
            description:
                "How to merge the delta into the canonical map. `shallow_overwrite` (default) replaces matching top-level keys. `deep_merge` recursively merges objects. `append` pushes onto existing arrays.",
        }),
    ),
});

export type WriteMapDeltaParams = Static<typeof WriteMapDeltaParamsSchema>;

// ============================================================================
// Coverage summary helper (for the log line)
// ============================================================================

export function extractCoverageSummary(map: CodebaseMap): {
    covered: CoverageDimension[];
    gap: CoverageDimension[];
    total: number;
} {
    const covered: CoverageDimension[] = [];
    const gap: CoverageDimension[] = [];
    for (const dim of COVERAGE_DIMENSIONS) {
        const status = map.coverage[dim].status;
        if (status === "covered") covered.push(dim);
        else gap.push(dim);
    }
    return { covered, gap, total: COVERAGE_DIMENSIONS.length };
}

// ============================================================================
// Apply defaults (schema_version, generated_at)
// ============================================================================

/**
 * Returns a shallow clone of `userMap` with `schema_version` and
 * `generated_at` filled in if absent. Does not mutate the input.
 * The injected field names are returned in `injectedDefaults` so
 * the caller can report which defaults were applied.
 */
export function applyMapDefaults(
    userMap: unknown,
): { map: CodebaseMap; injectedDefaults: string[] } {
    const cloned: Record<string, unknown> = {
        ...(userMap as Record<string, unknown>),
    };
    const injectedDefaults: string[] = [];
    if (cloned.schema_version === undefined) {
        cloned.schema_version = "1";
        injectedDefaults.push("schema_version");
    }
    if (cloned.generated_at === undefined) {
        cloned.generated_at = new Date().toISOString();
        injectedDefaults.push("generated_at");
    }
    return { map: cloned as CodebaseMap, injectedDefaults };
}
