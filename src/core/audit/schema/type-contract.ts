import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

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

export const TypeContractSurfaceSchema = Type.Object({
    pydantic_models: Type.Array(TypeDefSchema),
    typescript_interfaces: Type.Array(TypeDefSchema),
    api_contracts: Type.Optional(Type.Array(OpenApiSchema)),
    openapi_or_graphql: Type.Optional(Type.Union([OpenApiSchema, Type.Null()])),
    db_models: Type.Array(DbModelSchema),
    idks: Type.Array(Type.String(), {
        description: "The high-leverage grep-able names.",
    }),
    synced_types: Type.Optional(Type.Object({
        synced: Type.Array(Type.String()),
        unsynced: Type.Array(Type.String()),
    })),
    synced_types_observed: Type.Optional(Type.Boolean()),
    idk_coverage: Type.Optional(Type.Object({
        min_required: Type.Number({ default: 10 }),
        actual: Type.Number(),
    })),
    stable_types: Type.Array(Type.String()),
    volatile_types: Type.Array(Type.String()),
    one_type_trace: Type.Union([OneTypeTraceSchema, Type.Null()]),
});
