import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const ModuleEdgeSchema = Type.Object({
    from: Type.String(),
    to: Type.String(),
    kind: StringEnum(["import", "state", "rpc"]),
});

const ClientServerSplitSchema = Type.Object({
    client: Type.String(),
    server: Type.String(),
});

const MonorepoWorkspaceSchema = Type.Object({
    kind: StringEnum(["yarn", "pnpm", "turborepo", "nx", "rush", "other"] as const),
    config_file: Type.String(),
});

export const ModuleGraphSchema = Type.Object({
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
    import_depth: Type.Optional(Type.Object({
        max_depth: Type.Number(),
        avg_depth: Type.Number(),
    })),
    circular_dependencies: Type.Optional(Type.Array(Type.Array(Type.String()))),
    monorepo_workspace: Type.Optional(Type.Union([MonorepoWorkspaceSchema, Type.Null()])),
});
