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
import { COVERAGE_DIMENSIONS } from "./coverage.ts";
import { ConventionsSchema } from "./schema/conventions.ts";
import { MetaSchema } from "./schema/meta.ts";
import { ModuleGraphSchema } from "./schema/module-graph.ts";
import { PitfallSchema } from "./schema/pitfalls.ts";
import {
    ConfidenceSchema,
    CoverageStatusSchema,
    DimensionStatusSchema,
    KebabNameSchema,
    SafeRelativePathSchema,
} from "./schema/primitives.ts";
import { SkeletonSchema } from "./schema/skeleton.ts";
import { TypeContractSurfaceSchema } from "./schema/type-contract.ts";

export { ConfidenceSchema, CoverageStatusSchema, DimensionStatusSchema };

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
            "Test command specific to this domain (e.g. " +
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

// ============================================================================
// The full CodebaseMap (the contract)
// ============================================================================

export const CodebaseMapSchema = Type.Object({
    schema_version: Type.Optional(Type.Literal("1", {
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
    customization_evidence: Type.Optional(CustomizationEvidenceSchema),
    // Agent-expert domains. Emergent list of
    // expert domains derived by the LLM from the per-feature
    // reports (Phase 2) and D3.stable_types. Used by Phase
    // 9.10 to emit .pi/prompts/experts/<domain>/{expertise.yaml,
    // question.md, self-improve.md, [plan.md],
    // [plan_build_improve.md]}. v1 maps without this field
    // continue to parse.
    expert_evidence: Type.Optional(ExpertEvidenceSchema),
    // Structured output contract for all user-facing generated
    // intelligence. The LLM records intent here; TypeScript renderers
    // produce files later, after coverage closes and before the
    // transactional apply writes anything user-facing.
    artifact_intents: Type.Optional(ArtifactIntentsSchema),
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
    schema_version: Type.Optional(Type.Literal("1")),
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
    // write_map_delta can update customization_evidence incrementally.
    customization_evidence: Type.Optional(CustomizationEvidenceSchema),
    // Also optional on the partial schema
    // so write_map_delta can update expert_evidence incrementally.
    expert_evidence: Type.Optional(ExpertEvidenceSchema),
    artifact_intents: Type.Optional(ArtifactIntentsSchema),
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
// Non-schema behavior compatibility façade
// ============================================================================

export { COVERAGE_DIMENSIONS };
export {
    AGENTS_MD_MAX_LINES,
    MIN_PITFALLS_FOR_COVERED,
    assessCoverageClosure,
    extractCoverageSummary,
} from "./coverage.ts";
export type {
    CoverageClosureResult,
    CoverageDimension,
    CoverageSummary,
} from "./coverage.ts";
export { applyMapDefaults } from "./map-defaults.ts";
export type { AppliedMapDefaults } from "./map-defaults.ts";
export {
    resolveApiContracts,
    resolveFrameworks,
    resolveLifecyclePresence,
    resolveProductionCredentials,
    resolveSyncedTypes,
} from "./schema-compatibility.ts";
export type {
    FrameworkMetaCompatibilityInput,
    FrameworkSkeletonCompatibilityInput,
    LifecycleCompatibilityInput,
    ResolvedApiContracts,
    ResolvedFrameworks,
    ResolvedLifecyclePresence,
    ResolvedProductionCredential,
    ResolvedSyncedTypes,
    SecurityCompatibilityInput,
    TypeContractCompatibilityInput,
} from "./schema-compatibility.ts";
