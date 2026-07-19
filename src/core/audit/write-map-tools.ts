import * as path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
    WriteMapDeltaParamsSchema,
    WriteMapParamsSchema,
    applyMapDefaults,
    COVERAGE_DIMENSIONS,
} from "./schema.ts";
import { formatCoverageClosure } from "./map-coverage.ts";
import { applyMapDelta, type MapMergeStrategy } from "./map-delta.ts";
import { mergeEvidenceIntoGapDraft } from "./map-draft.ts";
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
    "artifact_intents",
]);

function isEmptyRecord(value: unknown): value is UnknownRecord {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
    );
}

function parseSerializedObject(value: unknown): unknown {
    let candidate = value;
    // OpenAI-compatible transports may stringify a tool argument twice. Keep
    // this deliberately bounded: only an object reached within two JSON layers
    // is accepted; all other values continue to strict TypeBox validation.
    for (let layer = 0; layer < 2 && typeof candidate === "string"; layer += 1) {
        try {
            candidate = JSON.parse(candidate) as unknown;
        } catch {
            return value;
        }
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

/**
 * Some OpenAI-compatible providers serialize a null value for an object-or-null
 * field as an empty object. Normalize only those known nullable object fields
 * before the SDK applies the strict TypeBox parameter schema.
 */
function prepareMapArguments<T>(input: unknown): T {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        return input as T;
    }

    const prepared = structuredClone(input) as UnknownRecord;
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
    }
    const map = isEmptyRecord(prepared.map) ? undefined : prepared.map;
    const delta = isEmptyRecord(prepared.delta) ? undefined : prepared.delta;
    const candidate = map ?? delta;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return prepared as T;
    }

    const codebaseMap = candidate as UnknownRecord;
    normalizePartialArtifactIntents(codebaseMap);
    normalizeNumericEvidence(codebaseMap);
    removePrematureEmptyArtifactIntents(codebaseMap);
    const moduleGraph = codebaseMap.module_graph as UnknownRecord | undefined;
    const typeContracts = codebaseMap.type_contract_surface as UnknownRecord | undefined;
    const conventions = codebaseMap.conventions as UnknownRecord | undefined;
    const operational = codebaseMap.operational_surface as UnknownRecord | undefined;

    normalizeEmptyNullableObject(moduleGraph, "client_server_split");
    normalizeEmptyNullableObject(moduleGraph, "monorepo_workspace");
    normalizeEmptyNullableObject(typeContracts, "openapi_or_graphql");
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
            "Persist the 10-dimension codebase map to ./.pi/agentify/codebase_map.json. " +
            "Schema-enforced via TypeBox. Every write, including the first checkpoint, requires the complete top-level map; " +
            "use honest empty sections and `gap` coverage entries for unexplored areas. Submit the map inline with `mode: 'auto'`; " +
            "the tool safely creates its own draft transport when it exceeds 100KB. " +
            "Use `map_file` only for an already-existing JSON file. The tool reads, " +
            "validates, and writes the canonical map. Gap entries in the coverage block are " +
            "allowed in the data and reported in the result; weak `covered` entries are " +
            "also reported with the same closure rules as the final post-run gate. " +
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
            if (!validation.ok && mapInput !== null && typeof mapInput === "object" && !Array.isArray(mapInput)) {
                const merged = mergeEvidenceIntoGapDraft(mapInput as Record<string, unknown>);
                validation = validateMap(merged);
                if (validation.ok) sourcePath = `${sourcePath}:draft-merged`;
            }
            if (!validation.ok) {
                return {
                    content: [{ type: "text", text: `Error: ${validation.error}` }],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            const validMap = validation.value;
            const closure = formatCoverageClosure(validMap);
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
                `Source: ${sourcePath}.${injectedLine} ${closure.line}`;

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
                    gap_warning: closure.warnings,
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
            "Merge a partial delta into the canonical codebase map. Used by `gap_filler` " +
            "sub-agents to close a single dimension's gap without re-persisting the entire " +
            "map. Agentify merges the delta and strictly validates the complete result. The merge " +
            "strategy controls how delta fields are combined with the existing map " +
            "(`shallow_overwrite` = default, `deep_merge` = recursive merge, `append` = " +
            "push onto arrays). If `dimension` is provided, the corresponding coverage " +
            "entry is set to `covered` with the delta's `confidence` and `evidence_summary`. " +
            "Per-dimension gap_filler count is tracked (soft ceiling of 3, no hard cap; observability only).",
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
                                "Error: no canonical map exists at ./.pi/agentify/codebase_map.json. " +
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
                    content: [{ type: "text", text: "Error: write_map_delta requires an object delta." }],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }

            let reserveWarning: string | undefined;
            if (params.dimension) {
                reserveWarning = consumeReserve(params.dimension).reason;
            }

            const strategy = (params.merge_strategy ?? "shallow_overwrite") as MapMergeStrategy;
            const merged = applyMapDelta(
                existing as unknown as Record<string, unknown>,
                prepared.delta as Record<string, unknown>,
                strategy,
            );

            if (params.dimension) {
                const dim = params.dimension;
                const confidence = params.confidence ?? "medium";
                const evidenceSummary =
                    params.evidence_summary ??
                    `Closed by gap_filler delta (${strategy}).`;
                const coverage = (merged.coverage ?? {}) as Record<string, unknown>;
                coverage[dim] = {
                    status: "covered",
                    confidence,
                    evidence_summary: evidenceSummary,
                };
                merged.coverage = coverage;
            }

            const log = (merged.exploration_log ?? []) as Array<Record<string, unknown>>;
            log.push({
                ts: new Date().toISOString(),
                action: "gap_filler_delta",
                target: params.dimension ?? "(no-dim)",
                observation: `merged delta from write_map_delta (strategy=${strategy})`,
            });
            merged.exploration_log = log;

            const { map: withDefaults } = applyMapDefaults(merged);
            const mergedValidation = validateMap(withDefaults);
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
            const closure = formatCoverageClosure(validMap);
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
                `Strategy: ${strategy}. Dimension: ${params.dimension ?? "(none)"}. ` +
                `Gap-filler count for ${params.dimension ?? "n/a"}: ${params.dimension ? getReserveCount(params.dimension) : 0} (soft ceiling: ${GAP_FILLER_SOFT_CEILING}). ` +
                `${closure.line}` +
                (reserveWarning ? ` Note: ${reserveWarning}` : "");

            return {
                content: [{ type: "text", text: resultText }],
                details: {
                    path: writeResult.path,
                    size_bytes: writeResult.size_bytes,
                    dimension: params.dimension ?? null,
                    merge_strategy: strategy,
                    gap_filler_count: params.dimension ? getReserveCount(params.dimension) : 0,
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
                    gap_warning: closure.warnings,
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
