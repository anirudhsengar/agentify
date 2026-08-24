import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

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

const ContributionBranchSchema = Type.Object({
    name: Type.String({
        description:
            "Bare git ref name only, for example 'develop'. Never prose, never a " +
            "name with an explanation appended. Explanations belong in `note`.",
    }),
    purpose: StringEnum([
        "pull_request_base",
        "release",
        "maintenance",
        "development",
    ] as const, {
        description:
            "pull_request_base is the branch contributions are opened against. " +
            "Record it whenever the repository documents one.",
    }),
    evidence: Type.Object({
        path: Type.String({ description: "Repository file documenting this branch." }),
        line_start: Type.Number({ description: "1-indexed inclusive." }),
        line_end: Type.Number({ description: "1-indexed inclusive." }),
    }),
    note: Type.Optional(Type.String({
        description: "Free-form clarification. Never put prose in `name`.",
    })),
});

const GitWorkflowSchema = Type.Object({
    main_branch: Type.String({
        description:
            "Bare git ref name of the repository's primary integration branch. " +
            "A bare ref name only: no spaces, no parenthetical explanation.",
    }),
    contribution_branches: Type.Optional(Type.Array(ContributionBranchSchema, {
        description:
            "Structured branch policy. Record one entry with purpose " +
            "'pull_request_base' when the repository documents which branch " +
            "contributions target.",
    })),
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
    // Behavior when the script is missing.
    fallback_behavior: Type.Optional(Type.String()),
});

const SpawnedSubprocessSchema = Type.Object({
    name: Type.String(),
    binary: Type.String(),
    role: Type.String(),
    // Group for related subprocesses.
    group: Type.Optional(Type.String()),
});

const BuildRecipeSchema = Type.Object({
    steps: Type.Array(Type.String()),
    env: Type.Record(Type.String(), Type.String()),
    dependencies: Type.Array(Type.String()),
});

export const OperationalSurfaceSchema = Type.Object({
    build: BuildSchema,
    run: RunSchema,
    deploy: Type.Union([DeploySchema, Type.Null()]),
    // Multiple deploy targets.
    deploy_targets: Type.Optional(Type.Array(DeploySchema)),
    env_vars: Type.Array(EnvVarSchema),
    ci_cd: CiCdSchema,
    git_workflow: GitWorkflowSchema,
    port_ranges: PortRangesSchema,
    shutdown_procedure: ShutdownProcedureSchema,
    spawned_subprocesses: Type.Array(SpawnedSubprocessSchema),
    // Additional operational evidence.
    env_var_purposes: Type.Optional(Type.Record(Type.String(), Type.String())),
    port_determinism: Type.Optional(Type.Object({
        is_deterministic: Type.Boolean(),
        range: Type.String(),
    })),
    build_recipe: Type.Optional(BuildRecipeSchema),
    // Optional operational evidence used to derive repository procedures.
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
    // repository review guidance).
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
