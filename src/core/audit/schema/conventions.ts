import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

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

const VersioningSchema = Type.Object({
    kind: StringEnum(["semver", "calver", "custom"] as const),
    config_file: Type.String(),
});

const DbMigrationSchema = Type.Object({
    tool: StringEnum(["alembic", "knex", "prisma", "drizzle", "other"] as const),
    config_file: Type.String(),
});

export const ConventionsSchema = Type.Object({
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
    comment_style: Type.Optional(CommentStyleSchema),
    import_ordering: Type.Optional(ImportOrderingSchema),
    type_hint_coverage_pct: Type.Optional(Type.Number()),
    test_naming: Type.Optional(Type.String()),
    versioning: Type.Optional(Type.Union([VersioningSchema, Type.Null()])),
    db_migration: Type.Optional(Type.Union([DbMigrationSchema, Type.Null()])),
});
