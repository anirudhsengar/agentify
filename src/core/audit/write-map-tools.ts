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
    draftPathRelative,
    DEFAULT_MAP_FILENAME,
    readCanonicalMap,
    writeCanonicalMap,
    writeDraftAtomically,
    type MapPathConfig,
    type MapToolExecutionContext,
} from "./map-storage.ts";
import { validateMap, validatePartialMap } from "./map-validation.ts";

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

function defineWriteMapTool(context: MapToolExecutionContext): ToolDefinition {
    return defineTool({
        name: "write_map",
        label: "Write Codebase Map",
        description:
            "Persist the 10-dimension codebase map to ./.pi/agentify/codebase_map.json. " +
            "Schema-enforced via TypeBox. Submit the complete map inline with `mode: 'auto'`; " +
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
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const mode = params.mode ?? "auto";
            const configuredDraftPath = draftPathRelative(context).replace(/\\/g, "/");
            const hasInline = params.map !== undefined;
            const hasFile = typeof params.map_file === "string" && params.map_file.length > 0;

            if (!hasInline && !hasFile) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                "Error: write_map called with empty arguments. Provide either " +
                                "`map` (inline object) or `map_file` (path to a JSON file). " +
                                "For large maps, use the file-based mode: build the JSON as a " +
                                `string, call the \`write\` tool with path="${configuredDraftPath}" ` +
                                `and content=<the json string>, then call write_map with ` +
                                `{map_file: "${configuredDraftPath}"}.`,
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
                    const loaded = loadMapFromFile(params.map_file!, ctx.cwd);
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
                                    "Use the file-based mode instead: build the JSON as a string, " +
                                    `call \`write\` with path="${configuredDraftPath}" and ` +
                                    `content=<the json string>, then call write_map with ` +
                                    `{map_file: "${configuredDraftPath}"}.`,
                            },
                        ],
                        isError: true,
                        details: undefined as unknown as Record<string, unknown>,
                    };
                }
                const inlineSize = Buffer.byteLength(JSON.stringify(params.map), "utf8");
                if (inlineSize > MAX_INLINE_MAP_BYTES) {
                    if (mode === "inline") {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text:
                                        `Error: inline map is ${inlineSize} bytes, exceeds the ${MAX_INLINE_MAP_BYTES} byte cap. ` +
                                        `Use the file-based mode instead: build the JSON as a string, ` +
                                        `call \`write\` with path="${configuredDraftPath}" and ` +
                                        `content=<the json string>, then call write_map with ` +
                                        `{map_file: "${configuredDraftPath}"}.`,
                                },
                            ],
                            isError: true,
                            details: undefined as unknown as Record<string, unknown>,
                        };
                    }
                    try {
                        const draftPath = writeDraftAtomically(
                            ctx.cwd,
                            JSON.stringify(params.map, null, 2),
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
                    mapInput = params.map;
                    sourcePath = "(inline)";
                }
            }

            const { map: withDefaults, injectedDefaults } = applyMapDefaults(mapInput);
            const validation = validateMap(withDefaults);
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
            "map. The delta is schema-validated via PartialCodebaseMapSchema. The merge " +
            "strategy controls how delta fields are combined with the existing map " +
            "(`shallow_overwrite` = default, `deep_merge` = recursive merge, `append` = " +
            "push onto arrays). If `dimension` is provided, the corresponding coverage " +
            "entry is set to `covered` with the delta's `confidence` and `evidence_summary`. " +
            "Per-dimension gap_filler count is tracked (soft ceiling of 3, no hard cap; observability only).",
        parameters: WriteMapDeltaParamsSchema,
        async execute(_id, params, _signal, _onUpdate, ctx) {
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

            const validation = validatePartialMap(params.delta as unknown);
            if (!validation.ok) {
                return {
                    content: [{ type: "text", text: `Error: ${validation.error}` }],
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
                validation.value,
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
                                `This is a bug — the delta itself was valid. ` +
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
