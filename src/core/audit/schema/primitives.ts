import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

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

export const KebabNameSchema = Type.String({
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    description:
        "kebab-case identifier with no path separators. Used for generated file names.",
});

export const SafeRelativePathSchema = Type.String({
    pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._/-]+$",
    description:
        "Repository-relative path. Must not be absolute and must not contain '..' segments.",
});
