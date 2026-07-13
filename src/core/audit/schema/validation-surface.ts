import { Type } from "typebox";

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

export const ValidationSurfaceSchema = Type.Object({
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
