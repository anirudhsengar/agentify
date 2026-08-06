import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

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

export const PitfallSchema = Type.Object({
    module: Type.String(),
    what: Type.String(),
    consequence: Type.String(),
    line_ref: Type.Number({ description: "Line number in the module." }),
    category: Type.Optional(PitfallCategorySchema),
});
