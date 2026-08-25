import * as path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
    NON_CLOSING_DELTA_DIMENSIONS,
    WriteMapDeltaParamsSchema,
    WriteMapParamsSchema,
    applyMapDefaults,
    COVERAGE_DIMENSIONS,
    specialistEvidenceRecorded,
    type CodebaseMap,
} from "./schema.ts";
import {
    formatCoverageClosure,
    type FormattedCoverageClosure,
} from "./map-coverage.ts";
import { applyMapDelta, type MapMergeStrategy } from "./map-delta.ts";
import {
  mergeEvidenceIntoGapDraft,
  mergeEvidenceIntoMap,
  type SanitizeDiagnostics,
} from "./map-draft.ts";
import {
    loadMapFromFile,
    MAX_INLINE_MAP_BYTES,
} from "./map-input.ts";
import {
    consumeReserve,
    GAP_FILLER_SOFT_CEILING,
    getReserveCount,
} from "./map-observability.ts";
import {
    DEFAULT_MAP_FILENAME,
    readCanonicalMap,
    writeCanonicalMap,
    writeDraftAtomically,
    type MapPathConfig,
    type MapToolExecutionContext,
} from "./map-storage.ts";
import { validateMap } from "./map-validation.ts";

export interface MapTools {
    writeMapTool: ToolDefinition;
    writeMapDeltaTool: ToolDefinition;
    /** Absolute path of the canonical map for a given repo root. */
    canonicalMapPath: (cwd: string) => string;
    /** Posix-style relative path of the canonical map. */
    canonicalMapRelative: string;
    /** Selected-state draft transport directory. */
    draftDirectoryRelative: string;
    /** Selected-state draft transport file path. */
    draftPathRelative: string;
    /** Selected-state previous-map history directory. */
    historyRelative: string;
}

type UnknownRecord = Record<string, unknown>;

function isTopographyEntryPoint(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const entry = value as UnknownRecord;
    return typeof entry.path === "string" && entry.path.length > 0;
}

function isBootstrapDraft(map: { exploration_log: ReadonlyArray<{ action: string }> }): boolean {
    return map.exploration_log.some((entry) => entry.action === "draft_bootstrap");
}

const MAP_TOP_LEVEL_KEYS = new Set([
    "schema_version",
    "generated_at",
    "meta",
    "skeleton",
    "module_graph",
    "type_contract_surface",
    "conventions",
    "pitfalls",
    "validation_surface",
    "operational_surface",
    "security_surface",
    "coverage",
    "open_questions",
    "exploration_log",
    "customization_evidence",
    "expert_evidence",
    "concern_evidence",
    "artifact_intents",
]);

type CoverageDimensionName = (typeof COVERAGE_DIMENSIONS)[number];

export const COVERAGE_REPAIR_HINTS: Record<CoverageDimensionName, string> = {
    D1_topography:
        "include skeleton.top_level_tree (array of root paths), skeleton.entry_points " +
        "(array of { path, role, language, run_command }), and " +
        "skeleton.first_5_files_for_fresh_agent (array of { path, why }) in the same delta",
    D2_module_boundaries:
        "include module_graph.edges (array of { from, to, kind }) or module_graph.parallelizable_subtrees " +
        "(array of string arrays) or module_graph.shared_abstractions (array of paths)",
    D3_type_contract:
        "use the top-level observed_type_contract parameter, or include " +
        "type_contract_surface.type_definitions (any language, as { path, name, kind, language, fields }), db_models, stable_types, or one_type_trace. " +
        "One real type is sufficient in a small repository",
    D4_conventions:
        "include conventions.naming.files, conventions.naming.functions, and conventions.logging.pattern",
    D5_pitfalls:
        "include pitfalls array with at least one entry: { module, what, consequence, source_reference, line_ref }",
    D6_validation:
        "include validation_surface.test_command and per_change_type.chore/bug/feature.mandatory arrays",
    D7_operational:
        "include operational_surface.build.command, operational_surface.run.command, and operational_surface.git_workflow.main_branch",
    D8_security:
        "include security_surface.paths.zero_access (array of strings) and at least one entry in " +
        "security_surface.bash_blocked_patterns (array of strings) or security_surface.damage_control_rules (array of strings)",
    D9_process:
        "include meta.lifecycle.sdlc_model (string) and meta.lifecycle.issue_types (array of strings)",
    D10_documentation:
        "include meta.documentation.readme_metrics with present=true and section_count>0, or has_ai_docs/has_app_docs/has_specs true",
};

function downgradeUnsupportedCoverage(
    map: CodebaseMap,
    closure: FormattedCoverageClosure,
): CoverageDimensionName[] {
    const downgraded: CoverageDimensionName[] = [];
    for (const dimension of closure.unresolved) {
        const entry = map.coverage[dimension];
        if (entry.status !== "covered") continue;
        map.coverage[dimension] = { ...entry, status: "gap" };
        downgraded.push(dimension);
    }
    return downgraded;
}

function formatCoverageRepairGuidance(
    closure: FormattedCoverageClosure,
    focusDimension?: CoverageDimensionName | null,
): string {
    if (closure.unresolved.length === 0) return "";
    const ordered = focusDimension !== undefined && focusDimension !== null
        ? [focusDimension, ...closure.unresolved.filter((d) => d !== focusDimension)]
        : closure.unresolved;
    const repairs = ordered.map((dimension) => {
        const reason = closure.reasons[dimension] ?? "not closed";
        const hint = COVERAGE_REPAIR_HINTS[dimension];
        return `${dimension}: ${reason} (${hint})`;
    });
    return ` Repair guidance: ${repairs.join("; ")}.`;
}

const SPECIALIST_EVIDENCE_GUIDANCE =
    " Concern evidence is not recorded yet. The audit cannot complete until you call " +
    "write_map_delta with concern_evidence in the delta and NO `dimension` parameter " +
    "(concern evidence closes no coverage dimension). A concern is a specialty a maintainer would " +
    "recognize as its own body of knowledge \u2014 not a directory. Concerns are expected to " +
    "span many directories and to share files with one another. Replace every value below " +
    "with evidence you actually observed in this repository: " +
    "`delta: { concern_evidence: { concerns: [{ concern: 'authentication', one_line: " +
    "'Owns how a caller proves identity and how that proof is checked on every request.', " +
    "covers: 'Login, session issue and renewal, credential storage, and every enforcement " +
    "point.', excludes: 'Authorization rules, which decide what an identified caller may do.', " +
    "flows: [{ name: 'user login', description: 'Credential submission through session " +
    "establishment.', steps: [{ path: 'src/routes/login.ts', what_happens: 'Accepts the " +
    "credential payload.' }, { path: 'src/auth/verify.ts', what_happens: 'Compares the hash " +
    "and issues a session.' }] }], touchpoints: [{ path: 'src/auth/verify.ts', symbol: " +
    "'verifyCredential', role: 'The single credential comparison in the codebase.', " +
    "line_range: [12, 61], centrality: 'core' }], invariants: [{ rule: 'Credentials are " +
    "never logged.', why: 'Log shipping would export secrets.', reference: " +
    "'src/auth/verify.ts' }], pitfalls: [{ risk: 'Session renewal skips re-validation.', " +
    "consequence: 'A revoked account keeps access until expiry.', reference: " +
    "'src/auth/session.ts' }], entry_questions: ['Does this change alter who is considered " +
    "authenticated?'], validation: ['npm test -- tests/auth'], spans_subtrees: ['src'], " +
    "stability: 'high', recurrence: 'high', confidence: 'high', last_updated: " +
    "'2026-01-01T00:00:00.000Z' }], not_concerns: [{ candidate: 'utils', why_rejected: " +
    "'A directory, not a specialty; its files belong to the concerns that use them.' }] } }`. " +
    "Name concerns in this repository's own words; there is no fixed list of valid concerns. " +
    "Do not merge two concerns because they share files, and do not split one concern into " +
    "per-directory pieces. Every touchpoint path must be a file tracked in git. " +
    "An honest empty `concerns` list is valid only for a repository too small to have " +
    "distinct specialties; record that justification in open_questions and in `not_concerns` " +
    "in the same delta. Do not re-close coverage dimensions; they are already covered.";

/**
 * Render sanitize diagnostics for the tool result. A write that "succeeds"
 * while silently dropping the model's concern evidence is the aqa-tests
 * failure mode: the audit completes, discovery reads an empty list, and
 * nobody can say why. Every drop is named here.
 */
function formatSanitizeDiagnostics(diagnostics: SanitizeDiagnostics): string {
    if (diagnostics.dropped.length === 0) return "";
    return (
        ` Sanitizer dropped ${diagnostics.dropped.length} invalid entr(ies) — ` +
        `re-submit them with the named fields fixed: ${diagnostics.dropped.join("; ")}.`
    );
}

function formatSpecialistEvidenceGuidance(
    _closure: FormattedCoverageClosure,
    map: CodebaseMap,
): string {
    // Specialist evidence must be recorded before the audit closes, regardless
    // of whether other dimensions are still outstanding. A model in late-stage
    // recovery can spend its remaining budget re-trying a dimension the gate
    // rejects for substance reasons, never reaching the closure check that
    // would otherwise surface the missing concern_evidence. Surface the prompt
    // every time the field is absent so the model addresses concerns alongside
    // dimension repairs, not as an afterthought after every dimension is green.
    if (specialistEvidenceRecorded(map)) return "";
    return SPECIALIST_EVIDENCE_GUIDANCE;
}

function injectObservedTypeContract(
    delta: UnknownRecord,
    observed: {
        kind: "typescript_interface" | "pydantic_model";
        path: string;
        name: string;
        fields: string[];
    },
): UnknownRecord {
    const collection = observed.kind === "typescript_interface"
        ? "typescript_interfaces"
        : "pydantic_models";
    const currentSurface = delta.type_contract_surface;
    const surface: UnknownRecord = currentSurface !== null
        && typeof currentSurface === "object"
        && !Array.isArray(currentSurface)
        ? { ...currentSurface as UnknownRecord }
        : {};
    const currentEntries = Array.isArray(surface[collection])
        ? surface[collection] as unknown[]
        : [];
    const entry = {
        path: observed.path,
        name: observed.name,
        fields: [...observed.fields],
    };
    const alreadyPresent = currentEntries.some((candidate) => {
        if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const record = candidate as UnknownRecord;
        return record.path === entry.path && record.name === entry.name;
    });
    surface[collection] = alreadyPresent ? currentEntries : [...currentEntries, entry];
    return { ...delta, type_contract_surface: surface };
}

function isEmptyRecord(value: unknown): value is UnknownRecord {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
    );
}

const MARKDOWN_FENCE = /^```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/;

/**
 * Some transports deliver the payload as the *content* of a JSON string
 * literal (every quote escaped as \"), which is not itself parseable JSON.
 * Decode one string-literal layer so the loop can parse the real payload.
 */
function decodeJsonStringLiteralContent(value: string): string | undefined {
    try {
        const decoded = JSON.parse(`"${value}"`) as unknown;
        return typeof decoded === "string" && decoded !== value ? decoded : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Some models emit raw newlines or tabs inside JSON string values, which is
 * not parseable JSON. Escape control characters that occur inside string
 * literals only, leaving structural whitespace untouched.
 */
function escapeControlCharsInJsonStrings(value: string): string {
    let inString = false;
    let escaped = false;
    let out = "";
    for (const ch of value) {
        if (escaped) {
            out += ch;
            escaped = false;
            continue;
        }
        if (inString && ch === "\\") {
            out += ch;
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            out += ch;
            continue;
        }
        if (inString && (ch === "\n" || ch === "\r" || ch === "\t")) {
            out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
            continue;
        }
        out += ch;
    }
    return out;
}

/**
 * Some models leave a dangling comma before a closing brace or bracket. Drop
 * commas that are immediately followed (past whitespace) by a closing
 * delimiter, outside string literals only.
 */
function removeTrailingCommasOutsideStrings(value: string): string {
    let inString = false;
    let escaped = false;
    let out = "";
    for (let index = 0; index < value.length; index += 1) {
        const ch = value[index]!;
        if (escaped) {
            out += ch;
            escaped = false;
            continue;
        }
        if (inString && ch === "\\") {
            out += ch;
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            out += ch;
            continue;
        }
        if (!inString && ch === ",") {
            let lookahead = index + 1;
            while (lookahead < value.length && /\s/.test(value[lookahead]!)) lookahead += 1;
            if (lookahead < value.length && (value[lookahead] === "}" || value[lookahead] === "]")) {
                continue;
            }
        }
        out += ch;
    }
    return out;
}

function parseSerializedObject(value: unknown): unknown {
    let candidate = value;
    // OpenAI-compatible transports may stringify a tool argument twice. Keep
    // this deliberately bounded: only an object reached within two JSON layers
    // is accepted; all other values continue to strict TypeBox validation.
    // Presentation-only breakage is repaired first: a markdown-fenced JSON
    // block, quotes escaped one level too many, or raw control characters
    // inside string values.
    for (let layer = 0; layer < 2 && typeof candidate === "string"; layer += 1) {
        const text: string = candidate;
        try {
            candidate = JSON.parse(text) as unknown;
            continue;
        } catch {
            // fall through to the presentation repairs
        }
        const trimmed = text.trim();
        const controlEscaped = escapeControlCharsInJsonStrings(trimmed);
        const attempts: Array<string | undefined> = [
            MARKDOWN_FENCE.exec(trimmed)?.[1],
            trimmed.includes('\\"') ? decodeJsonStringLiteralContent(trimmed) : undefined,
            controlEscaped,
            removeTrailingCommasOutsideStrings(controlEscaped),
        ];
        let parsed = false;
        for (const attempt of attempts) {
            if (attempt === undefined) continue;
            try {
                candidate = JSON.parse(attempt) as unknown;
                parsed = true;
                break;
            } catch {
                // try the next repair
            }
        }
        if (!parsed) return value;
    }
    return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate
        : value;
}

function normalizeEmptyNullableObject(
    parent: UnknownRecord | undefined,
    key: string,
): void {
    if (parent && isEmptyRecord(parent[key])) {
        parent[key] = null;
    }
}

const TRANSPORT_WRAPPER_KEYS = new Set(["map", "codebase_map", "delta"]);

/**
 * Some providers nest the payload one extra level (`map.map`, `map.delta`,
 * `delta.delta`, `delta.map`). Unwrap only single-key wrappers, at most twice,
 * so legitimately small partial maps are never reinterpreted.
 */
function unwrapNestedTransport(value: unknown): unknown {
    let current = value;
    for (let depth = 0; depth < 2; depth += 1) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) break;
        const record = current as UnknownRecord;
        const keys = Object.keys(record);
        if (keys.length !== 1) break;
        const only = keys[0]!;
        if (!TRANSPORT_WRAPPER_KEYS.has(only)) break;
        const nested = record[only];
        if (nested === null || typeof nested !== "object") break;
        current = nested;
    }
    return current;
}

/**
 * Describe a rejected transport payload compactly so the model learns what it
 * sent (and logs carry the shape of the quirk) without echoing full content.
 */
function describeReceivedTransport(value: unknown): string {
    if (value === undefined || value === null) return "nothing (delta is missing)";
    if (typeof value === "string") {
        const start = value.slice(0, 120);
        const end = value.length > 120 ? ` and ending with ${JSON.stringify(value.slice(-120))}` : "";
        return `a string (${value.length} chars) starting with ${JSON.stringify(start)}${end}`;
    }
    if (Array.isArray(value)) return `an array of ${value.length} item(s)`;
    return `a value of type ${typeof value}`;
}

/**
 * Some providers batch several dimension deltas as an array. Merge them in
 * order with deep-merge semantics so each entry contributes its keys instead
 * of being rejected for not being a single object.
 */
function mergeBatchedDeltas(value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    if (value.length === 0) return value;
    if (!value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
        return value;
    }
    let merged: UnknownRecord = {};
    for (const item of value) {
        merged = applyMapDelta(merged, item as UnknownRecord, "deep_merge");
    }
    return merged;
}

function removePrematureEmptyArtifactIntents(map: UnknownRecord): void {
    const intents = map.artifact_intents;
    if (intents === null || typeof intents !== "object" || Array.isArray(intents)) return;
    const record = intents as UnknownRecord;
    const guide = record.agent_guide;
    if (guide === null || typeof guide !== "object" || Array.isArray(guide)) return;
    const sections = (guide as UnknownRecord).sections;
    if (!Array.isArray(sections) || sections.length !== 0) return;
    const emptyLists = ["always_on_docs", "feature_agents", "prompt_templates", "experts", "extension_candidates"];
    if (emptyLists.every((key) => Array.isArray(record[key]) && (record[key] as unknown[]).length === 0)) {
        delete map.artifact_intents;
    }
}

function normalizePartialArtifactIntents(map: UnknownRecord): void {
    const intents = map.artifact_intents;
    if (intents === null || typeof intents !== "object" || Array.isArray(intents)) return;
    const record = intents as UnknownRecord;
    for (const key of ["always_on_docs", "feature_agents", "prompt_templates", "experts", "extension_candidates"]) {
        if (!(key in record)) record[key] = [];
    }
}

function normalizeNumericEvidence(map: UnknownRecord): void {
    const validation = map.validation_surface;
    if (validation === null || typeof validation !== "object" || Array.isArray(validation)) return;
    const record = validation as UnknownRecord;
    if (typeof record.test_count === "string" && /^\d+$/.test(record.test_count)) {
        record.test_count = Number(record.test_count);
    }
}

function normalizePitfallLineReferences(map: UnknownRecord): void {
    if (!Array.isArray(map.pitfalls)) return;
    for (const pitfall of map.pitfalls) {
        if (pitfall === null || typeof pitfall !== "object" || Array.isArray(pitfall)) continue;
        const record = pitfall as UnknownRecord;
        if (typeof record.line_ref !== "string") continue;
        const match = /\d+/.exec(record.line_ref);
        if (match) record.line_ref = Number(match[0]);
    }
}

function looksLikeJsonString(value: string): boolean {
    const trimmed = value.trim();
    return (trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"));
}

function maybeParseStringifiedNestedValue(value: unknown): unknown {
    if (typeof value !== "string" || !looksLikeJsonString(value)) return value;
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed;
    } catch {
        return value;
    }
}

const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function setNestedPath(target: UnknownRecord, dottedPath: string, value: unknown): void {
    const parts = dottedPath.split(".");
    if (parts.some((part) => DANGEROUS_OBJECT_KEYS.has(part))) {
        return;
    }
    let current: UnknownRecord = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i];
        const next = current[part];
        if (next === null || typeof next !== "object" || Array.isArray(next)) {
            current[part] = {};
        }
        current = current[part] as UnknownRecord;
    }
    const lastPart = parts[parts.length - 1];
    if (lastPart && !DANGEROUS_OBJECT_KEYS.has(lastPart)) {
        current[lastPart] = value;
    }
}

function expandDottedKeysInPlace(value: unknown): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }
    const record = value as UnknownRecord;
    const dotted: Array<[string, unknown]> = [];
    for (const [key, rawValue] of Object.entries(record)) {
        const expanded = maybeParseStringifiedNestedValue(expandDottedKeysInPlace(rawValue));
        if (typeof key === "string" && key.includes(".")) {
            dotted.push([key, expanded]);
            delete record[key];
        } else {
            record[key] = expanded;
        }
    }
    for (const [dottedKey, dottedValue] of dotted) {
        setNestedPath(record, dottedKey, dottedValue);
    }
    return record;
}

const LIFECYCLE_CAMEL_CASE_FIELDS: Record<string, string> = {
    sdlcModel: "sdlc_model",
    issueTypes: "issue_types",
    reviewLoop: "review_loop",
    documentationLoop: "documentation_loop",
    conditionalDocs: "conditional_docs",
    aiwScripts: "aiw_scripts",
    agentDefinitions: "agent_definitions",
};

function normalizeLifecycleCamelCase(map: UnknownRecord): void {
    const meta = map.meta;
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return;
    const metaRecord = meta as UnknownRecord;
    const lifecycle = metaRecord.lifecycle;
    if (lifecycle === null || typeof lifecycle !== "object" || Array.isArray(lifecycle)) return;
    const lifecycleRecord = lifecycle as UnknownRecord;
    for (const [key, mapped] of Object.entries(LIFECYCLE_CAMEL_CASE_FIELDS)) {
        if (key in lifecycleRecord) {
            lifecycleRecord[mapped] = lifecycleRecord[key];
            delete lifecycleRecord[key];
        }
    }
}

function extractIssueTemplateName(path: string): string | undefined {
    const match = /([^/]+)\.md$/i.exec(path);
    if (!match) return undefined;
    const name = match[1];
    // Some templates are named like "bug_report.md" or "01-bug-report.md".
    return name;
}

function inferIssueTypesFromD9Evidence(map: UnknownRecord): string[] | undefined {
    const coverage = map.coverage;
    if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage)) return undefined;
    const d9 = (coverage as UnknownRecord).D9_process;
    if (d9 === null || typeof d9 !== "object" || Array.isArray(d9)) return undefined;
    const evidence = (d9 as UnknownRecord).evidence;
    if (!Array.isArray(evidence)) return undefined;
    const issueTypes: string[] = [];
    for (const citation of evidence) {
        if (citation === null || typeof citation !== "object" || Array.isArray(citation)) continue;
        const record = citation as UnknownRecord;
        const citationPath = typeof record.path === "string" ? record.path : "";
        if (citationPath.startsWith(".github/ISSUE_TEMPLATE/")) {
            const name = extractIssueTemplateName(citationPath);
            if (name && !issueTypes.includes(name)) issueTypes.push(name);
        }
    }
    return issueTypes.length > 0 ? issueTypes : undefined;
}

function normalizeIssueTypes(map: UnknownRecord): void {
    const meta = map.meta;
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return;
    const metaRecord = meta as UnknownRecord;
    const lifecycle = metaRecord.lifecycle;
    if (lifecycle === null || typeof lifecycle !== "object" || Array.isArray(lifecycle)) return;
    const lifecycleRecord = lifecycle as UnknownRecord;

    let issueTypes = lifecycleRecord.issue_types;

    // Some providers serialize issue_types as a JSON string.
    if (typeof issueTypes === "string") {
        issueTypes = maybeParseStringifiedNestedValue(issueTypes);
    }

    // Some providers emit an array of { name: "bug_report" } objects.
    if (Array.isArray(issueTypes)) {
        issueTypes = issueTypes.map((entry) => {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
            const record = entry as UnknownRecord;
            if (typeof record.name === "string") return record.name;
            if (typeof record.id === "string") return record.id;
            return entry;
        });
    }

    // If still empty, derive from D9 evidence that cites ISSUE_TEMPLATE files.
    if (!Array.isArray(issueTypes) || issueTypes.length === 0) {
        const inferred = inferIssueTypesFromD9Evidence(map);
        if (inferred) {
            issueTypes = inferred;
        }
    }

    lifecycleRecord.issue_types = Array.isArray(issueTypes)
        ? issueTypes.filter((entry): entry is unknown => entry !== null && entry !== undefined).map((entry) => String(entry))
        : [];
}

function repairD9Coverage(map: UnknownRecord): void {
    const coverage = map.coverage;
    if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage)) return;
    const d9 = (coverage as UnknownRecord).D9_process;
    if (d9 === null || typeof d9 !== "object" || Array.isArray(d9)) return;
    const d9Record = d9 as UnknownRecord;

    const meta = map.meta;
    const lifecycle = meta !== null && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as UnknownRecord).lifecycle
        : undefined;
    const lifecycleRecord = lifecycle !== null && typeof lifecycle === "object" && !Array.isArray(lifecycle)
        ? lifecycle as UnknownRecord
        : undefined;

    const sdlcModel = lifecycleRecord?.sdlc_model;
    const issueTypes = lifecycleRecord?.issue_types;
    const hasSubstance = typeof sdlcModel === "string" && sdlcModel.length > 0
        && Array.isArray(issueTypes) && issueTypes.length > 0;
    if (!hasSubstance) return;

    const evidence = d9Record.evidence;
    const hasEvidence = Array.isArray(evidence) && evidence.length > 0;
    if (!hasEvidence) return;

    if (d9Record.status !== "covered") {
        d9Record.status = "covered";
        if (typeof d9Record.confidence !== "string" || d9Record.confidence.length === 0) {
            d9Record.confidence = "high";
        }
        if (typeof d9Record.evidence_summary !== "string" || d9Record.evidence_summary.length === 0) {
            d9Record.evidence_summary = "Lifecycle and issue process derived from repository templates and contribution docs.";
        }
    }
}

const EVIDENCE_SECTIONS_MISPLACED_UNDER_META = [
    "customization_evidence",
    "expert_evidence",
    "concern_evidence",
    "artifact_intents",
] as const;

/**
 * Some models nest top-level evidence sections under `meta`. Only the top level
 * of the map schema is closed, so a misplaced copy would validate invisibly
 * and specialist discovery would read an absent field. Hoist the misplaced
 * section before validation so the real schema gate judges its content and the
 * model receives an actionable error instead of silent acceptance.
 */
/**
 * Move misplaced concerns from anywhere we have observed a model put them to
 * the single canonical top-level location `concern_evidence`.
 *
 * Concretely, when an audit cannot find concerns itself it sometimes reasons
 * about them under `meta.lifecycle`, and in that meta context mistakes the
 * placeholder section for the canonical one — writing the actual array as
 * `meta.lifecycle.concerns` and the wrapper as
 * `meta.lifecycle.concern_evidence`. Hoisting a single nested level is not
 * enough: the real array may live two levels down. Walk every plausible
 * location once and merge into the canonical slot, rather than trusting any
 * particular key path.
 */
function hoistMisplacedEvidenceSections(map: UnknownRecord): void {
    const meta = map.meta;
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return;
    const metaRecord = meta as UnknownRecord;

    // Existing direct-nest hoisting for the documented misplacement paths.
    for (const key of EVIDENCE_SECTIONS_MISPLACED_UNDER_META) {
        const misplaced = metaRecord[key];
        if (misplaced === undefined) continue;
        const canonical = map[key];
        if (canonical === undefined) {
            map[key] = misplaced;
        } else if (
            canonical !== null && typeof canonical === "object" && !Array.isArray(canonical)
            && misplaced !== null && typeof misplaced === "object" && !Array.isArray(misplaced)
        ) {
            const canonicalRecord = canonical as UnknownRecord;
            for (const [subKey, subValue] of Object.entries(misplaced as UnknownRecord)) {
                const existing = canonicalRecord[subKey];
                if (existing === undefined || (Array.isArray(existing) && existing.length === 0)) {
                    canonicalRecord[subKey] = subValue;
                }
            }
        }
        delete metaRecord[key];
    }

    // The lifecycle sub-object is a frequent substitute the model reaches for
    // when its context describes concerns there rather than at the top level.
    const lifecycle = metaRecord["lifecycle"];
    if (lifecycle === null || typeof lifecycle !== "object" || Array.isArray(lifecycle)) return;
    const lifecycleRecord = lifecycle as UnknownRecord;
    const legacyConcerns = lifecycleRecord["concerns"];
    const legacyWrapper = lifecycleRecord["concern_evidence"];
    const canonicalConcernEvidence = map["concern_evidence"];
    const canonicalIsObject = canonicalConcernEvidence !== null
        && typeof canonicalConcernEvidence === "object"
        && !Array.isArray(canonicalConcernEvidence);
    const wrapperIsObject = legacyWrapper !== null
        && typeof legacyWrapper === "object"
        && !Array.isArray(legacyWrapper);
    const concernsFromWrapper = wrapperIsObject
        ? (legacyWrapper as UnknownRecord)["concerns"]
        : undefined;

    // Merge every misplaced concerns source in one go. The model often puts
    // the array both at the bare path (`meta.lifecycle.concerns`) and inside
    // a wrapper it constructed itself (`meta.lifecycle.concern_evidence`).
    // Either can be empty; the lifted record must contain the union and an
    // empty `not_concerns` so the concern-evidence schema accepts it.
    const sources = [legacyConcerns, concernsFromWrapper].filter(
        (candidate): candidate is unknown[] => Array.isArray(candidate) && candidate.length > 0,
    );
    if (sources.length > 0) {
        const mergedConcerns: unknown[] = [];
        for (const source of sources) {
            for (const entry of source) {
                if (!mergedConcerns.includes(entry)) mergedConcerns.push(entry);
            }
        }
        if (canonicalConcernEvidence === undefined) {
            map["concern_evidence"] = { concerns: mergedConcerns, not_concerns: [] };
        } else if (canonicalIsObject) {
            const canonicalRecord = canonicalConcernEvidence as UnknownRecord;
            const existing = canonicalRecord["concerns"];
            if (!Array.isArray(existing) || existing.length === 0) {
                canonicalRecord["concerns"] = mergedConcerns;
            }
            if (canonicalRecord["not_concerns"] === undefined) {
                canonicalRecord["not_concerns"] = [];
            }
        }
    }
    delete lifecycleRecord["concerns"];
    delete lifecycleRecord["concern_evidence"];
}

function repairModuleGraphOrphans(map: UnknownRecord): void {
    const moduleGraph = map.module_graph;
    const graphRecord = moduleGraph !== null && typeof moduleGraph === "object" && !Array.isArray(moduleGraph)
        ? moduleGraph as UnknownRecord
        : undefined;

    const moduleGraphKeys = [
        "edges",
        "parallelizable_subtrees",
        "shared_state",
        "client_server_split",
        "shared_abstractions",
        "import_depth",
        "circular_dependencies",
        "monorepo_workspace",
    ];

    for (const key of moduleGraphKeys) {
        if (!(key in map)) continue;
        const value = map[key];
        if (value === undefined) continue;
        const current = graphRecord?.[key];
        const currentIsEmpty = current === undefined
            || (Array.isArray(current) && current.length === 0)
            || (current === null);
        if (!currentIsEmpty) continue;

        const target = graphRecord ?? (map.module_graph = {} as unknown) as UnknownRecord;
        target[key] = value;
        delete map[key];
    }

    // The model occasionally flattens a single module_graph.shared_state entry
    // into parallel top-level arrays. When we see a matching set, reconstruct
    // descriptive shared_state strings.
    const hasFlattenedSet =
        Array.isArray(map.name)
        && Array.isArray(map.path)
        && Array.isArray(map.role)
        && Array.isArray(map.kind)
        && map.name.length > 0
        && map.name.length === map.path.length
        && map.name.length === map.role.length
        && map.name.length === map.kind.length;
    if (hasFlattenedSet) {
        const names = map.name as unknown[];
        const paths = map.path as unknown[];
        const roles = map.role as unknown[];
        const kinds = map.kind as unknown[];
        const reconstructed = names.map((n, i) => `${String(n)} (${String(roles[i])}) [${String(kinds[i])}] at ${String(paths[i])}`);
        const target = graphRecord ?? (map.module_graph = {} as unknown) as UnknownRecord;
        const shared = Array.isArray(target.shared_state) ? target.shared_state as unknown[] : [];
        target.shared_state = [...shared, ...reconstructed];
        delete map.name;
        delete map.path;
        delete map.role;
        delete map.kind;
    }

    // An exploration_log entry can be emitted as a top-level `item` object.
    const item = map.item;
    if (
        item !== null
        && typeof item === "object"
        && !Array.isArray(item)
        && typeof (item as UnknownRecord).ts === "string"
        && typeof (item as UnknownRecord).action === "string"
        && typeof (item as UnknownRecord).target === "string"
        && typeof (item as UnknownRecord).observation === "string"
    ) {
        const log = Array.isArray(map.exploration_log) ? map.exploration_log as unknown[] : [];
        log.push(item);
        map.exploration_log = log;
        delete map.item;
    }
}

function repairMapShape(map: UnknownRecord): void {
    expandDottedKeysInPlace(map);
    hoistMisplacedEvidenceSections(map);
    repairModuleGraphOrphans(map);
    normalizeLifecycleCamelCase(map);
    normalizeIssueTypes(map);
    repairD9Coverage(map);
}

/**
 * Some OpenAI-compatible providers serialize a null value for an object-or-null
 * field as an empty object. Normalize only those known nullable object fields
 * before the SDK applies the strict TypeBox parameter schema.
 */
function prepareMapArguments<T>(input: unknown): T {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        return input as T;
    }

    let prepared: UnknownRecord;
    try {
        prepared = structuredClone(input) as UnknownRecord;
    } catch {
        // Direct tool calls and provider adapters can supply proxy-backed
        // objects that are not structured-cloneable. Continue with normal
        // property access so their original validation or access error is
        // preserved instead of replacing it with DataCloneError.
        prepared = input as UnknownRecord;
    }
    // Some OpenAI-compatible transports encode a structured argument as a JSON
    // string. Accept only a parsable object; malformed strings still reach the
    // strict schema and produce the normal validation error.
    prepared.map = parseSerializedObject(prepared.map);
    prepared.codebase_map = parseSerializedObject(prepared.codebase_map);
    prepared.delta = parseSerializedObject(prepared.delta);
    if (prepared.map === undefined && prepared.codebase_map !== undefined) {
        prepared.map = prepared.codebase_map;
    }
    delete prepared.codebase_map;
    // Some providers occasionally close `map` after its first property and
    // emit the remaining map sections as siblings of the wrapper. Repair only
    // known codebase-map keys before TypeBox validation; never absorb control
    // fields such as mode or map_file.
    const inlineMap = prepared.map !== null && typeof prepared.map === "object" && !Array.isArray(prepared.map)
        ? prepared.map as UnknownRecord
        : {};
    for (const key of MAP_TOP_LEVEL_KEYS) {
        if (key in prepared && !(key in inlineMap)) {
            inlineMap[key] = prepared[key];
            delete prepared[key];
        }
    }
    if (Object.keys(inlineMap).length > 0) {
        prepared.map = inlineMap;
        if (prepared.delta === undefined) {
            prepared.delta = inlineMap;
        }
    }
    prepared.map = mergeBatchedDeltas(unwrapNestedTransport(prepared.map));
    prepared.delta = mergeBatchedDeltas(unwrapNestedTransport(prepared.delta));
    const map = isEmptyRecord(prepared.map) ? undefined : prepared.map;
    const delta = isEmptyRecord(prepared.delta) ? undefined : prepared.delta;
    const candidate = map ?? delta;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return prepared as T;
    }

    const codebaseMap = candidate as UnknownRecord;
    // Anthropic-compatible MiniMax M3 occasionally emits dotted keys
    // ("meta.lifecycle.issue_types"), camelCase lifecycle fields, and
    // stringified nested values. Repair those before the strict schema gate.
    repairMapShape(codebaseMap);
    normalizePartialArtifactIntents(codebaseMap);
    normalizeNumericEvidence(codebaseMap);
    normalizePitfallLineReferences(codebaseMap);
    removePrematureEmptyArtifactIntents(codebaseMap);
    const moduleGraph = codebaseMap.module_graph as UnknownRecord | undefined;
    const typeContracts = codebaseMap.type_contract_surface as UnknownRecord | undefined;
    const conventions = codebaseMap.conventions as UnknownRecord | undefined;
    const operational = codebaseMap.operational_surface as UnknownRecord | undefined;

    normalizeEmptyNullableObject(moduleGraph, "client_server_split");
    normalizeEmptyNullableObject(moduleGraph, "monorepo_workspace");
    normalizeEmptyNullableObject(typeContracts, "one_type_trace");
    normalizeEmptyNullableObject(conventions, "versioning");
    normalizeEmptyNullableObject(conventions, "db_migration");
    normalizeEmptyNullableObject(operational, "deploy");

    return prepared as T;
}

function defineWriteMapTool(context: MapToolExecutionContext): ToolDefinition {
    return defineTool({
        name: "write_map",
        label: "Write Codebase Map",
        description:
            "Persist the 10-dimension codebase map to ./.agentify/runtime/audit/codebase_map.json. " +
            "Schema-enforced via TypeBox. Every write, including the first checkpoint, requires the complete top-level map; " +
            "use honest empty sections and `gap` coverage entries for unexplored areas. Submit the map inline with `mode: 'auto'`; " +
            "the tool safely creates its own draft transport when it exceeds 100KB. " +
            "Use `map_file` only for an already-existing JSON file. The tool reads, " +
            "validates, and writes the canonical map. Gap entries in the coverage block are " +
            "allowed in the data and reported in the result; weak `covered` entries are " +
            "also reported with the same closure rules as the final post-run gate. " +
            "Every `covered` dimension must include `evidence`: an array of `{ path, excerpt, kind }` " +
            "citations to real repository paths; the gate rejects covered claims that cannot be grounded. " +
            "Audit sessions do not have a general-purpose write tool, so do not attempt to " +
            "create a draft file yourself. " +
            "Call multiple times during exploration to persist progress; call once with the " +
            "final map before rendering the report.",
        parameters: WriteMapParamsSchema,
        prepareArguments: prepareMapArguments,
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const prepared = prepareMapArguments<typeof params>(params);
            const mode = prepared.mode ?? "auto";
            const hasInline = prepared.map !== undefined;
            const hasFile = typeof prepared.map_file === "string" && prepared.map_file.length > 0;

            if (!hasInline && !hasFile) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                "Error: write_map called with empty arguments. Provide either " +
                                "`map` (inline object) or `map_file` (path to a JSON file). " +
                                "Audit sessions cannot create a map file; submit inline `map` with " +
                                "`mode: \"auto\"` for large maps.",
                        },
                    ],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            if (hasInline && hasFile) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Error: write_map called with both `map` and `map_file`. Provide exactly one.",
                        },
                    ],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            let mapInput: unknown;
            let sourcePath: string;

            if (hasFile) {
                try {
                    const loaded = loadMapFromFile(prepared.map_file!, ctx.cwd);
                    mapInput = loaded.map;
                    sourcePath = loaded.absolutePath;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    return {
                        content: [{ type: "text", text: `Error: ${msg}` }],
                        isError: true,
                        details: undefined as unknown as Record<string, unknown>,
                    };
                }
            } else {
                if (mode === "file") {
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    "Error: write_map called with `mode: 'file'` and inline `map`. " +
                                    "Use inline `map` with `mode: \"auto\"`; audit sessions cannot create " +
                                    "a map file.",
                            },
                        ],
                        isError: true,
                        details: undefined as unknown as Record<string, unknown>,
                    };
                }
                const inlineSize = Buffer.byteLength(JSON.stringify(prepared.map), "utf8");
                if (inlineSize > MAX_INLINE_MAP_BYTES) {
                    if (mode === "inline") {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text:
                                        `Error: inline map is ${inlineSize} bytes, exceeds the ${MAX_INLINE_MAP_BYTES} byte cap. ` +
                                        "Retry with `mode: \"auto\"` so agentify can create a private draft.",
                                },
                            ],
                            isError: true,
                            details: undefined as unknown as Record<string, unknown>,
                        };
                    }
                    try {
                        const draftPath = writeDraftAtomically(
                            ctx.cwd,
                            JSON.stringify(prepared.map, null, 2),
                            context,
                        );
                        const loaded = loadMapFromFile(draftPath, ctx.cwd);
                        mapInput = loaded.map;
                        sourcePath = `auto-fallback:${draftPath}`;
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text:
                                        `Error: inline map (${inlineSize} bytes) exceeded the cap and ` +
                                        `auto-fallback to file failed: ${msg}. ` +
                                        `Use the file-based mode explicitly.`,
                                },
                            ],
                            isError: true,
                            details: undefined as unknown as Record<string, unknown>,
                        };
                    }
                } else {
                    mapInput = prepared.map;
                    sourcePath = "(inline)";
                }
            }

            const { map: withDefaults, injectedDefaults } = applyMapDefaults(mapInput);
            let validation = validateMap(withDefaults);
            let sanitizeNotes = "";
            if (!validation.ok && mapInput !== null && typeof mapInput === "object" && !Array.isArray(mapInput)) {
                // Same contract as the delta path: sanitize recovery must
                // surface what it changed and must never replace the detailed
                // validation error with an opaque throw.
                const primaryError = validation.error;
                const diagnostics: SanitizeDiagnostics = { dropped: [] };
                try {
                    const merged = mergeEvidenceIntoGapDraft(
                        mapInput as Record<string, unknown>,
                        diagnostics,
                    );
                    validation = validateMap(merged);
                    if (validation.ok) {
                        sourcePath = `${sourcePath}:draft-merged`;
                        sanitizeNotes = formatSanitizeDiagnostics(diagnostics);
                    }
                } catch (sanitizeError) {
                    const sanitizeMessage = sanitizeError instanceof Error
                        ? sanitizeError.message
                        : String(sanitizeError);
                    return {
                        content: [{
                            type: "text",
                            text:
                                `Error: ${primaryError} ` +
                                `Sanitized recovery also failed: ${sanitizeMessage}`,
                        }],
                        isError: true,
                        details: undefined as unknown as Record<string, unknown>,
                    };
                }
            }
            if (!validation.ok) {
                return {
                    content: [{ type: "text", text: `Error: ${validation.error}` }],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            const validMap = validation.value;
            const existingMap = readCanonicalMap(ctx.cwd, context);
            const closure = formatCoverageClosure(validMap, ctx.cwd);
            if (existingMap !== null && isBootstrapDraft(existingMap)) {
                const existingClosure = formatCoverageClosure(existingMap, ctx.cwd);
                if (closure.closed.length < existingClosure.closed.length) {
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    "Error: full map write would discard previously recorded audit evidence " +
                                    `(${existingClosure.closed.length} closed dimensions would become ${closure.closed.length}). ` +
                                    "Keep the canonical map intact and use write_map_delta to add or repair a single dimension.",
                            },
                        ],
                        isError: true,
                        details: undefined as unknown as Record<string, unknown>,
                    };
                }
            }
            if (
                existingMap !== null
                && isBootstrapDraft(existingMap)
                && !isBootstrapDraft(validMap)
            ) {
                const bootstrapEntry = existingMap.exploration_log.find((entry) => entry.action === "draft_bootstrap");
                if (bootstrapEntry) validMap.exploration_log.unshift(bootstrapEntry);
            }
            const downgradedDimensions = downgradeUnsupportedCoverage(validMap, closure);
            let writeResult: { path: string; size_bytes: number };
            try {
                writeResult = writeCanonicalMap(ctx.cwd, validMap, context);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text", text: `Error: failed to write canonical map: ${msg}` }],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            const injectedLine =
                injectedDefaults.length > 0
                    ? ` Injected defaults: ${injectedDefaults.join(", ")}.`
                    : "";
            const resultText =
                `Wrote codebase map to ${writeResult.path} (${writeResult.size_bytes} bytes). ` +
                `Source: ${sourcePath}.${injectedLine} ${closure.line}` +
                sanitizeNotes +
                (downgradedDimensions.length > 0
                    ? ` Unsupported covered claims persisted as gap: ${downgradedDimensions.join(", ")}.`
                    : "") +
                formatCoverageRepairGuidance(closure) +
                formatSpecialistEvidenceGuidance(closure, validMap);

            return {
                content: [{ type: "text", text: resultText }],
                details: {
                    path: writeResult.path,
                    size_bytes: writeResult.size_bytes,
                    source_path: sourcePath,
                    injected_defaults: injectedDefaults,
                    schema_version: validMap.schema_version ?? "1",
                    generated_at: validMap.generated_at ?? null,
                    coverage_summary: {
                        covered: closure.closed,
                        gap: closure.unresolved,
                        total: COVERAGE_DIMENSIONS.length,
                    },
                    coverage_closure: {
                        closed: closure.closed,
                        unresolved: closure.unresolved,
                        reasons: closure.reasons,
                    },
                    downgraded_dimensions: downgradedDimensions,
                    gap_warning: closure.warnings,
                    specialist_evidence_recorded: specialistEvidenceRecorded(validMap),
                },
            };
        },
    }) as unknown as ToolDefinition;
}

function defineWriteMapDeltaTool(context: MapToolExecutionContext): ToolDefinition {
    return defineTool({
        name: "write_map_delta",
        label: "Write Codebase Map Delta",
        description:
            "Merge a partial delta into the canonical codebase map. Each call should close one " +
            "dimension by including both the dimension data AND the matching coverage entry. " +
            "Merging does not silently strip or invent arrays: the arrays and objects you provide " +
            "overwrite the matching fields in the map. If a field is still empty after the merge, " +
            "your delta did not include it. " +
            "Use `shallow_overwrite` (default) for a clean top-level replacement, `deep_merge` to " +
            "merge nested objects recursively, or `append` to concatenate arrays. " +
            "When `dimension` is provided, the coverage entry is proposed as `covered`; " +
            "Agentify downgrades it to `gap` only if the evidence or substance check fails. " +
            "Every `covered` claim must include `evidence`: an array of `{ path, excerpt, kind }` " +
            "citations to real repository paths. " +
            "D1 example: `delta: { skeleton: { top_level_tree: ['README.md', 'get.sh', 'compile.sh'], entry_points: [{ path: 'get.sh', role: 'SDK acquisition script', language: 'bash', run_command: 'bash get.sh' }], first_5_files_for_fresh_agent: [{ path: 'README.md', why: 'project overview' }] }, coverage: { D1_topography: { status: 'covered', confidence: 'high', evidence_summary: 'Topography anchored to real root files.', evidence: [{ path: 'README.md', excerpt: 'Adoptium AQAvit test suite', kind: 'positive' }] } } }`. " +
            "D3 example: `delta: { observed_type_contract: { kind: 'typescript_interface', path: 'src/types.ts', name: 'Observed', fields: ['id', 'name'] }, coverage: { D3_type_contract: { status: 'covered', ... } } }` or `delta: { type_contract_surface: { stable_types: [{ path: 'src/types.ts', name: 'BuildEnv', purpose: 'shared make vars' }] }, coverage: { D3_type_contract: { ... } } }`. " +
            "D8 example: `delta: { security_surface: { paths: { zero_access: ['.env', '*.pem', 'secrets.*'] }, bash_blocked_patterns: ['rm -rf /', 'eval $(aws sts assume-role ...)'] }, coverage: { D8_security: { ... } } }`. " +
            "Keep the delta small but complete for the one dimension you are closing.",
        parameters: WriteMapDeltaParamsSchema,
        prepareArguments: prepareMapArguments,
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const prepared = prepareMapArguments<typeof params>(params);
            const existing = readCanonicalMap(ctx.cwd, context);
            if (existing === null) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                "Error: no canonical map exists at ./.agentify/runtime/audit/codebase_map.json. " +
                                "Call `write_map` first to write the initial map, then use `write_map_delta` " +
                                "for subsequent partial updates.",
                        },
                    ],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            if (prepared.delta === null || typeof prepared.delta !== "object" || Array.isArray(prepared.delta)) {
                return {
                    content: [{
                        type: "text",
                        text:
                            "Error: write_map_delta requires `delta` to be a JSON object. " +
                            "Omit `delta` only to record a no-op exploration log. " +
                            "To close a dimension, pass a small object such as `delta: { coverage: { D9_process: { status: 'covered', confidence: 'high', evidence_summary: 'No agentic layer observed.', evidence: [{ path: '.pi/', excerpt: 'No .pi/ directory present.', kind: 'absence' }] } } }`. " +
                            `Received: ${describeReceivedTransport(prepared.delta)}.`,
                    }],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            // Prompts name the concern-evidence gate "specialist evidence"; a
            // model may copy that label into `dimension`. Treat the aliases as
            // an omitted dimension so the concern payload is merged instead of
            // being rejected for closing no real coverage dimension.
            const dimension: CoverageDimensionName | undefined =
                params.dimension !== undefined
                && (NON_CLOSING_DELTA_DIMENSIONS as readonly string[]).includes(params.dimension)
                    ? undefined
                    : params.dimension as CoverageDimensionName | undefined;

            if (params.observed_type_contract && dimension !== "D3_type_contract") {
                return {
                    content: [{
                        type: "text",
                        text: "Error: observed_type_contract is valid only with dimension=D3_type_contract.",
                    }],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            const delta = params.observed_type_contract
                ? injectObservedTypeContract(
                    prepared.delta as UnknownRecord,
                    params.observed_type_contract,
                )
                : prepared.delta as UnknownRecord;

            let reserveWarning: string | undefined;
            if (dimension) {
                reserveWarning = consumeReserve(dimension).reason;
            }

            const strategy = (params.merge_strategy ?? "shallow_overwrite") as MapMergeStrategy;
            const mergeAndAnnotate = (mergeStrategy: MapMergeStrategy): Record<string, unknown> => {
                const merged = applyMapDelta(
                    existing as unknown as Record<string, unknown>,
                    delta,
                    mergeStrategy,
                );

                if (dimension) {
                    const dim = dimension;
                    const confidence = params.confidence ?? "medium";
                    const evidenceSummary =
                        params.evidence_summary ??
                        `Closed by gap_filler delta (${mergeStrategy}).`;
                    const topographyEntryPoints = (merged.skeleton as UnknownRecord | undefined)?.entry_points;
                    const canCloseTopography = Array.isArray(topographyEntryPoints)
                        && topographyEntryPoints.some(isTopographyEntryPoint);
                    const coverage = (merged.coverage ?? {}) as Record<string, unknown>;
                    const existingEntry = (coverage[dim] ?? {}) as Record<string, unknown>;
                    coverage[dim] = {
                        status: dim === "D1_topography" && !canCloseTopography ? "gap" : "covered",
                        confidence,
                        evidence_summary:
                            dim === "D1_topography" && !canCloseTopography
                                ? `${evidenceSummary} Add skeleton.entry_points before closing D1_topography.`
                                : evidenceSummary,
                        evidence:
                            params.evidence
                            ?? existingEntry.evidence
                            ?? [],
                    };
                    merged.coverage = coverage;
                }

                // A delta is allowed to omit the log, but it must never turn the
                // application-owned audit trail into an arbitrary object. Some
                // providers emit a keyed log object while filling a dimension;
                // retain the last valid trail in that case so the delta can still
                // pass through the bootstrap sanitizer below.
                const log = Array.isArray(merged.exploration_log)
                    ? merged.exploration_log as Array<Record<string, unknown>>
                    : structuredClone(existing.exploration_log) as Array<Record<string, unknown>>;
                log.push({
                    ts: new Date().toISOString(),
                    action: "gap_filler_delta",
                    target: dimension ?? "(no-dim)",
                    observation: `merged delta from write_map_delta (strategy=${mergeStrategy})`,
                });
                merged.exploration_log = log;
                // Re-apply shape repair to the merged map so any bad fields
                // inherited from the existing map (or malformed deltas) are
                // normalized before schema validation and the coverage gate.
                repairMapShape(merged as UnknownRecord);
                return merged;
            };

            let appliedStrategy = strategy;
            let merged = mergeAndAnnotate(appliedStrategy);
            let { map: withDefaults } = applyMapDefaults(merged);
            let mergedValidation = validateMap(withDefaults);
            if (!mergedValidation.ok && strategy === "shallow_overwrite") {
                appliedStrategy = "deep_merge";
                merged = mergeAndAnnotate(appliedStrategy);
                ({ map: withDefaults } = applyMapDefaults(merged));
                mergedValidation = validateMap(withDefaults);
            }
            let sanitizeNotes = "";
            if (!mergedValidation.ok && isBootstrapDraft(existing)) {
                // The sanitize fallback must never swallow the primary
                // validation error: its own failure is opaque by comparison,
                // and the model repairs against field-level detail.
                const primaryError = mergedValidation.error;
                const diagnostics: SanitizeDiagnostics = { dropped: [] };
                try {
                    const sanitized = mergeEvidenceIntoMap(merged, existing, diagnostics);
                    ({ map: withDefaults } = applyMapDefaults(sanitized));
                    mergedValidation = validateMap(withDefaults);
                    sanitizeNotes = formatSanitizeDiagnostics(diagnostics);
                } catch (sanitizeError) {
                    const sanitizeMessage = sanitizeError instanceof Error
                        ? sanitizeError.message
                        : String(sanitizeError);
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    `Error: merged map failed schema validation. ` +
                                    `Correct the reported delta fields and retry. ` +
                                    `${primaryError} ` +
                                    `Sanitized recovery also failed: ${sanitizeMessage}`,
                            },
                        ],
                        isError: true,
                        details: undefined as unknown as Record<string, unknown>,
                    };
                }
            }
            if (!mergedValidation.ok) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `Error: merged map failed schema validation. ` +
                                `Correct the reported delta fields and retry. ` +
                                `${mergedValidation.error}`,
                        },
                    ],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            const validMap = mergedValidation.value;
            const needsTopographyEvidence =
                dimension === "D1_topography"
                && (
                    validMap.skeleton.top_level_tree.length === 0
                    || validMap.skeleton.entry_points.length === 0
                    || validMap.skeleton.first_5_files_for_fresh_agent.length === 0
                );
            if (needsTopographyEvidence) {
                validMap.coverage.D1_topography = {
                    status: "gap",
                    confidence: params.confidence ?? "medium",
                    evidence_summary:
                        `${params.evidence_summary ?? "Topography evidence was submitted."} ` +
                        "Add a non-empty skeleton.top_level_tree, skeleton.entry_points objects with path, role, language, and run_command, plus first_5_files_for_fresh_agent objects with path and why before closing D1_topography.",
                };
            }
            const closure = formatCoverageClosure(validMap, ctx.cwd);
            const downgradedDimensions = downgradeUnsupportedCoverage(validMap, closure);
            let writeResult: { path: string; size_bytes: number };
            try {
                writeResult = writeCanonicalMap(ctx.cwd, validMap, context);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text", text: `Error: failed to write merged map: ${msg}` }],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            const resultText =
                `Merged delta into codebase map at ${writeResult.path} (${writeResult.size_bytes} bytes). ` +
                `Strategy: ${appliedStrategy}. Dimension: ${dimension ?? "(none)"}. ` +
                `Gap-filler count for ${dimension ?? "n/a"}: ${dimension ? getReserveCount(dimension) : 0} (soft ceiling: ${GAP_FILLER_SOFT_CEILING}). ` +
                `${closure.line}` +
                sanitizeNotes +
                (downgradedDimensions.length > 0
                    ? ` Unsupported covered claims persisted as gap: ${downgradedDimensions.join(", ")}.`
                    : "") +
                formatCoverageRepairGuidance(closure, dimension) +
                formatSpecialistEvidenceGuidance(closure, validMap) +
                (needsTopographyEvidence
                    ? " To close D1, retry with `delta: { skeleton: { top_level_tree: [\"src/\"], entry_points: [{ path: \"path/to/entry\", role: \"what it starts\", language: \"language\", run_command: \"documented command\" }], first_5_files_for_fresh_agent: [{ path: \"README.md\", why: \"starting context\" }] } }`."
                    : "") +
                (reserveWarning ? ` Note: ${reserveWarning}` : "");

            return {
                content: [{ type: "text", text: resultText }],
                details: {
                    path: writeResult.path,
                    size_bytes: writeResult.size_bytes,
                    dimension: dimension ?? null,
                    merge_strategy: appliedStrategy,
                    gap_filler_count: dimension ? getReserveCount(dimension) : 0,
                    gap_filler_soft_ceiling: GAP_FILLER_SOFT_CEILING,
                    coverage_summary: {
                        covered: closure.closed,
                        gap: closure.unresolved,
                        total: COVERAGE_DIMENSIONS.length,
                    },
                    coverage_closure: {
                        closed: closure.closed,
                        unresolved: closure.unresolved,
                        reasons: closure.reasons,
                    },
                    downgraded_dimensions: downgradedDimensions,
                    gap_warning: closure.warnings,
                    specialist_evidence_recorded: specialistEvidenceRecorded(validMap),
                },
            };
        },
    }) as unknown as ToolDefinition;
}

export function createWriteMapTools(config: MapPathConfig): MapTools {
    const context: MapToolExecutionContext = Object.freeze({
        stateDir: config.stateDir,
        mapFilename: config.mapFilename ?? DEFAULT_MAP_FILENAME,
    });
    const normalize = (value: string): string => value.replace(/\\/g, "/");
    return {
        writeMapTool: defineWriteMapTool(context),
        writeMapDeltaTool: defineWriteMapDeltaTool(context),
        canonicalMapPath: (cwd: string) => path.join(cwd, context.stateDir, context.mapFilename),
        canonicalMapRelative: normalize(path.join(context.stateDir, context.mapFilename)),
        draftDirectoryRelative: normalize(path.join(context.stateDir, ".agentify")),
        draftPathRelative: normalize(path.join(context.stateDir, ".agentify", "draft.json")),
        historyRelative: normalize(path.join(context.stateDir, "history")),
    };
}
