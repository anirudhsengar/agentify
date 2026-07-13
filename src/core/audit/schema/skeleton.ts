import { Type } from "typebox";

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

const TestInfrastructureSchema = Type.Object({
    test_command: Type.String(),
    test_file_pattern: Type.String(),
    test_runner: Type.String(),
});

export const SkeletonSchema = Type.Object({
    top_level_tree: Type.Array(Type.String(), {
        description: "60-second whiteboard tree, as a list of paths.",
    }),
    entry_points: Type.Array(EntryPointSchema),
    code_test_mirror: CodeTestMirrorSchema,
    first_5_files_for_fresh_agent: Type.Array(FirstFileSchema, {
        description: "3-5 files for a fresh agent to read first.",
    }),
    app_vs_agentic_layer: AppVsAgenticLayerSchema,
    frameworks: Type.Optional(Type.Array(Type.String())),
    test_infrastructure: Type.Optional(TestInfrastructureSchema),
    convention_signals: Type.Optional(Type.Object({
        uses_print: Type.Boolean(),
        uses_logging: Type.Boolean(),
        has_app_agents_docs: Type.Boolean(),
    })),
    dev_command: Type.Optional(Type.String()),
});
