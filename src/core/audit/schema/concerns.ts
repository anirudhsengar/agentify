import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ConfidenceSchema, SafeRelativePathSchema } from "./primitives.ts";

// ============================================================================
// Repository concerns
// ============================================================================
//
// A concern is a semantic slice of the system — authentication, checkout,
// rate limiting, schema migration — not a directory. Concerns are expected to
// span many directories and to overlap one another: authentication touches
// routing, middleware, the user model, the session store, and the login view,
// and checkout touches several of the same files for entirely different
// reasons. Overlap between two concerns is normal evidence, never a signal
// that they are the same concern.
//
// Nothing in this contract names a language, a framework, or a directory
// convention. The model decides what the concerns of a repository are; trusted
// code only verifies that the evidence it cites resolves to real tracked bytes
// at the supporting commit.

const ConcernTouchpointSchema = Type.Object({
    path: SafeRelativePathSchema,
    symbol: Type.Union([Type.String(), Type.Null()], {
        description:
            "The specific function, class, block, target, rule, or section within the " +
            "file that belongs to this concern, in whatever form the file's language " +
            "expresses it. Null when the whole file belongs to the concern.",
    }),
    role: Type.String({
        minLength: 1,
        description:
            "What this location does FOR THIS CONCERN specifically, not what the file " +
            "does in general. The same file may appear under several concerns with a " +
            "different role in each.",
    }),
    line_range: Type.Union([
        Type.Tuple([
            Type.Number({ description: "Start line, 1-indexed, inclusive." }),
            Type.Number({ description: "End line, 1-indexed, inclusive." }),
        ]),
        Type.Null(),
    ], {
        description: "Observed line range, or null when the concern spans the whole file.",
    }),
    centrality: StringEnum(["core", "supporting", "peripheral"] as const, {
        description:
            "core = changing this changes the concern's behavior. supporting = the " +
            "concern depends on it but does not define it. peripheral = the concern " +
            "reaches here but rarely changes it.",
    }),
});

const ConcernFlowStepSchema = Type.Object({
    path: SafeRelativePathSchema,
    what_happens: Type.String({
        minLength: 1,
        description: "What this step does in the flow, in one line.",
    }),
});

const ConcernFlowSchema = Type.Object({
    name: Type.String({
        minLength: 1,
        description: "The flow a maintainer would name, for example 'user login' or 'refund a captured payment'.",
    }),
    description: Type.String({ minLength: 1 }),
    steps: Type.Array(ConcernFlowStepSchema, {
        minItems: 2,
        description:
            "The ordered end-to-end trace, entry point through effect. A flow with " +
            "fewer than two observed steps is not a traced flow.",
    }),
});

const ConcernInvariantSchema = Type.Object({
    rule: Type.String({ minLength: 1, description: "What must always hold for this concern." }),
    why: Type.String({ minLength: 1, description: "What breaks when it does not hold." }),
    reference: SafeRelativePathSchema,
});

const ConcernPitfallSchema = Type.Object({
    risk: Type.String({ minLength: 1 }),
    consequence: Type.String({ minLength: 1 }),
    reference: SafeRelativePathSchema,
});

export const ConcernSchema = Type.Object({
    concern: Type.String({
        minLength: 1,
        description:
            "What a maintainer would call this specialty, in this repository's own " +
            "words — 'authentication', 'test playlist authoring', 'wire protocol " +
            "framing'. Free-form: there is no fixed vocabulary of valid concerns, and " +
            "a concern must never be named after a directory.",
    }),
    one_line: Type.String({
        minLength: 1,
        description: "What a specialist in this concern owns, in one line.",
    }),
    covers: Type.String({
        minLength: 1,
        description:
            "Prose scope statement: everything this specialist is expected to hold " +
            "complete context on, wherever in the repository it lives.",
    }),
    excludes: Type.String({
        minLength: 1,
        description:
            "The boundary against adjacent concerns — what a reader might expect to " +
            "be in scope that is deliberately owned by someone else. Shared files are " +
            "not an exclusion; shared responsibility is.",
    }),
    flows: Type.Array(ConcernFlowSchema, {
        description:
            "End-to-end traces through this concern. These are what make a specialist " +
            "useful: the specialist should be able to answer 'where does X happen' " +
            "without re-exploring the repository.",
    }),
    touchpoints: Type.Array(ConcernTouchpointSchema, {
        minItems: 1,
        description:
            "Every observed location this concern reaches, scattered across the " +
            "repository as the concern actually is. Overlap with other concerns' " +
            "touchpoints is expected and must not be avoided or deduplicated.",
    }),
    invariants: Type.Array(ConcernInvariantSchema),
    pitfalls: Type.Array(ConcernPitfallSchema),
    entry_questions: Type.Array(Type.String({ minLength: 1 }), {
        description:
            "What any task touching this concern must answer before it is safe to " +
            "implement. These become the specialist's opening checklist.",
    }),
    validation: Type.Array(Type.String({ minLength: 1 }), {
        description:
            "Observed commands that exercise this concern specifically. Empty when " +
            "only the repository-wide validation surface applies.",
    }),
    spans_subtrees: Type.Array(SafeRelativePathSchema, {
        description:
            "Distinct top-level areas this concern reaches, derived from its " +
            "touchpoints. Recorded as evidence of how cross-cutting the concern is; " +
            "it is not a scope, an allowlist, or an ownership claim.",
    }),
    stability: StringEnum(["high", "medium", "low"] as const, {
        description:
            "How frequently this concern's evidence changes. Low means specialist " +
            "knowledge needs frequent revalidation.",
    }),
    recurrence: StringEnum(["high", "medium", "low"] as const, {
        description: "How often work in this repository is expected to touch this concern.",
    }),
    confidence: ConfidenceSchema,
    last_updated: Type.String({
        description:
            "ISO 8601 evidence timestamp. Persisted specialists receive " +
            "application-owned provenance, supporting-commit, and freshness metadata " +
            "during materialization.",
    }),
});

export const ConcernEvidenceSchema = Type.Object({
    concerns: Type.Array(ConcernSchema, {
        description:
            "The concerns of this repository, each traced from real code. One entry " +
            "per specialty a maintainer would recognize as its own body of knowledge. " +
            "An honest empty list is valid only for a repository too small to have " +
            "distinct specialties, and must be justified in open_questions.",
    }),
    not_concerns: Type.Array(Type.Object({
        candidate: Type.String({ minLength: 1 }),
        why_rejected: Type.String({ minLength: 1 }),
        grouped_into: Type.Optional(Type.String({
            minLength: 1,
            description:
                "Exact retained concern identity when trusted normalization should union this candidate's already-attested evidence into one inseparable file-level owner.",
        })),
    }), {
        description:
            "Candidate concerns considered and rejected, with the reason. Recorded so " +
            "an empty or thin concern list can be reviewed rather than guessed at.",
    }),
});

export type Concern = Static<typeof ConcernSchema>;
export type ConcernEvidence = Static<typeof ConcernEvidenceSchema>;
