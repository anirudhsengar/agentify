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

// A repository's data contracts, in whatever form its languages express them.
//
// `pydantic_models` and `typescript_interfaces` named two languages in the
// canonical schema of a language-agnostic tool, so a Java, Go, Rust, or
// make-driven repository had nowhere to record its contracts and arrived at
// specialist discovery with an empty type surface. `type_definitions` replaces
// them; the two named fields remain optional so maps written before this
// change still validate.
const GenericTypeDefSchema = Type.Object({
    path: Type.String(),
    name: Type.String(),
    kind: Type.String({
        description:
            "What this repository calls the construct — interface, struct, class, " +
            "record, model, schema, enum, protocol, message, target. Free-form: " +
            "use the language's own word rather than a normalized one.",
    }),
    language: Type.String({
        description: "The language or format the definition is written in.",
    }),
    fields: Type.Array(Type.String()),
});

export const TypeContractSurfaceSchema = Type.Object({
    type_definitions: Type.Optional(Type.Array(GenericTypeDefSchema, {
        description:
            "Observed data contracts in any language. Prefer this over the " +
            "language-named fields below, which exist only for compatibility.",
    })),
    pydantic_models: Type.Array(TypeDefSchema, {
        description: "Superseded by type_definitions. Record [] in new maps.",
    }),
    typescript_interfaces: Type.Array(TypeDefSchema, {
        description: "Superseded by type_definitions. Record [] in new maps.",
    }),
    api_contracts: Type.Optional(Type.Array(OpenApiSchema)),
    db_models: Type.Array(DbModelSchema),
    idks: Type.Array(Type.String(), {
        description: "The high-leverage grep-able names.",
    }),
    synced_types: Type.Optional(Type.Object({
        synced: Type.Array(Type.String()),
        unsynced: Type.Array(Type.String()),
    })),
    idk_coverage: Type.Optional(Type.Object({
        min_required: Type.Number({ default: 10 }),
        actual: Type.Number(),
    })),
    stable_types: Type.Array(Type.String()),
    volatile_types: Type.Array(Type.String()),
    one_type_trace: Type.Union([OneTypeTraceSchema, Type.Null()]),
});
