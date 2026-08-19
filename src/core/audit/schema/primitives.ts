import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const CoverageStatusSchema = StringEnum(["covered", "gap"], {
    description:
        "covered = adequately explored for this codebase's size and shape. " +
        "gap = uncovered; the run will fail to emit AGENTS.md until closed.",
});

export const ConfidenceSchema = StringEnum(["high", "medium", "low"]);

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

export const EvidenceCitationKindSchema = StringEnum(["positive", "absence"] as const, {
    description:
        "positive = the cited path exists and its excerpt supports the claim. " +
        "absence = the cited path does not exist and the absence is itself the evidence.",
});

export const EvidenceCitationSchema = Type.Object({
    path: SafeRelativePathSchema,
    excerpt: Type.String({
        minLength: 1,
        description:
            "Verbatim excerpt from the cited path for positive evidence, or a concise absence note for absence evidence. " +
            "Used by the installer to verify the claim is grounded in a real repository path.",
    }),
    kind: EvidenceCitationKindSchema,
});

export const DimensionStatusSchema = Type.Object({
    status: CoverageStatusSchema,
    confidence: ConfidenceSchema,
    evidence_summary: Type.String({
        description:
            "1-2 sentence summary of what was found. Used verbatim in AGENTS.md.",
    }),
    evidence: Type.Optional(Type.Array(EvidenceCitationSchema, {
        description:
            "Citations to real repository paths that support the coverage claim. " +
            "Required by the installer coverage gate for every dimension marked covered.",
    })),
});
