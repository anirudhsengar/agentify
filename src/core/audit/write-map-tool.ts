// write-map-tool.ts
//
// The `write_map` and `write_map_delta` custom tools. Schema-enforced,
// TypeBox-validated.
//
// write_map (two modes):
//   1. Inline:    { map: {...} }            use for small maps (≤ 3KB).
//   2. File-based: { map_file: "<path>" }   use for large maps.
//
// In "auto" mode (the default), an inline map that exceeds
// MAX_INLINE_MAP_BYTES is transparently persisted via the
// .pi/agentify/.agentify/draft.json transport. The agent sees a
// successful result either way.
//
// write_map_delta (Phase 1.2):
//   Merges a partial delta into the canonical map. Used by
//   `gap_filler` sub-agents to close a single dimension's gap
//   without re-persisting the entire map. The delta is
//   schema-validated; the merge is configurable.
//
// Both tools report gap counts in their result so the agent can
// decide whether to dispatch a gap_filler sub-agent. The reported
// gaps use the same closure assessment as the final post-run gate,
// so "covered" status without substantive evidence is surfaced
// immediately to the agent.

import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
    CodebaseMapSchema,
    ConfidenceSchema,
    CoverageStatusSchema,
    PartialCodebaseMapSchema,
    WriteMapDeltaParamsSchema,
    WriteMapParamsSchema,
    applyMapDefaults,
    assessCoverageClosure,
    COVERAGE_DIMENSIONS,
    type CodebaseMap,
    type CoverageDimension,
} from "./schema.ts";

const AGENTIFY_OUTPUT_DIR = path.join(".pi", "agentify");
const MAP_FILENAME = "codebase_map.json";
const DRAFT_DIR = path.join(AGENTIFY_OUTPUT_DIR, ".agentify");
const DRAFT_PATH = path.join(DRAFT_DIR, "draft.json");
const HISTORY_DIR = path.join(AGENTIFY_OUTPUT_DIR, "history");

/** Absolute path to the canonical codebase map for a given repo root. */
export function canonicalMapPath(cwd: string): string {
    return path.join(cwd, AGENTIFY_OUTPUT_DIR, MAP_FILENAME);
}

/** Relative path (posix-style) of the transient draft transport dir. */
export const DRAFT_TRANSPORT_DIR = DRAFT_DIR;

/**
 * Load and schema-validate the canonical codebase map. Returns the
 * validated map, or `null` when the map is absent, unreadable, not
 * JSON, or does not satisfy the schema. Used by the post-run success
 * gate (see ADR 0014) so success reflects the real map, not merely
 * the existence of output files.
 */
export function loadCanonicalMap(cwd: string): CodebaseMap | null {
    const filePath = canonicalMapPath(cwd);
    if (!fs.existsSync(filePath)) return null;
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, "utf-8");
    } catch {
        return null;
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    return Value.Check(CodebaseMapSchema, parsed) ? (parsed as CodebaseMap) : null;
}

function formatCoverageClosure(map: CodebaseMap): {
    closed: CoverageDimension[];
    unresolved: CoverageDimension[];
    reasons: Record<string, string>;
    line: string;
    warnings: string[] | null;
} {
    const closure = assessCoverageClosure(map);
    const warnings =
        closure.unresolved.length > 0
            ? closure.unresolved.map((dim) => `${dim}: ${closure.reasons[dim] ?? "not closed"}`)
            : null;
    const line =
        warnings === null
            ? `All ${COVERAGE_DIMENSIONS.length} coverage dimensions closed.`
            : `${closure.closed.length}/${COVERAGE_DIMENSIONS.length} coverage dimensions closed. ` +
                `Unresolved: ${warnings.join("; ")}.`;
    return {
        closed: closure.closed,
        unresolved: closure.unresolved,
        reasons: closure.reasons,
        line,
        warnings,
    };
}

// Cap map_file size at 1 MB. A 1 MB JSON map is suspicious —
// either the LLM duplicated something or the JSON is malformed.
const MAX_MAP_FILE_BYTES = 1_000_000;

// Cap inline map at 100 KB (TypeBox's value validator is fine
// with this size, but anything larger is unreadable in tool args).
const MAX_INLINE_MAP_BYTES = 100_000;

// ============================================================================
// Per-dimension soft tracking (observability, not a cap)
// ============================================================================
//
// Per Phase 2.10, there is no hard cap on `gap_filler` dispatches
// per dimension. The LLM is the brain; the system is the loop.
// This counter exists for observability (so the log shows how
// many times the parent re-dispatched a gap_filler for the same
// dimension), not to block calls. The "ceiling" is a soft guidance
// to surface runaway retry patterns in the log; the LLM can still
// dispatch beyond it (and is expected to, occasionally, when the
// evidence demands it).

/** Per-dimension gap_filler dispatch counter. For observability. */
const perDimReserve: Map<CoverageDimension, number> = new Map();

/**
 * Soft guidance for the observability surface. Not a hard cap.
 * If the LLM dispatches gap_filler for the same dimension more
 * than this many times, it should consider that a signal to try
 * a different angle (or mark the gap honestly as uncovered).
 */
const GAP_FILLER_SOFT_CEILING = 3;

export function getReserveCount(dim: CoverageDimension): number {
    return perDimReserve.get(dim) ?? 0;
}

export function resetReserveCounters(): void {
    perDimReserve.clear();
}

function consumeReserve(dim: CoverageDimension): { allowed: boolean; reason?: string } {
    const current = perDimReserve.get(dim) ?? 0;
    const beyondSoftCeiling = current >= GAP_FILLER_SOFT_CEILING;
    perDimReserve.set(dim, current + 1);
    return {
        allowed: true,
        reason: beyondSoftCeiling
            ? `gap_filler dispatched ${current + 1}x for ${dim} (beyond soft ceiling of ${GAP_FILLER_SOFT_CEILING}; LLM should consider a different angle or mark honest null)`
            : undefined,
    };
}

// ============================================================================
// Map persistence helpers
// ============================================================================

function writeCanonicalMap(cwd: string, map: CodebaseMap): { path: string; size_bytes: number } {
    const dir = path.join(cwd, AGENTIFY_OUTPUT_DIR);
    fs.mkdirSync(dir, { recursive: true });

    // Archive the existing map before overwriting. Always on;
    // re-running agentify in the same codebase preserves a
    // timestamped previous copy under .pi/agentify/history/.
    const existingPath = path.join(dir, MAP_FILENAME);
    if (fs.existsSync(existingPath)) {
        try {
            const histDir = path.join(cwd, HISTORY_DIR);
            fs.mkdirSync(histDir, { recursive: true });
            const isoTs = new Date().toISOString().replace(/[:.]/g, "-");
            const archivePath = path.join(histDir, `codebase_map.${isoTs}.previous.json`);
            fs.copyFileSync(existingPath, archivePath);
        } catch {
            // Archive failures are non-fatal; the new write still happens.
        }
    }

    const filePath = path.join(dir, MAP_FILENAME);
    const content = JSON.stringify(map, null, 2);
    fs.writeFileSync(filePath, content, { mode: 0o644 });
    return { path: filePath, size_bytes: Buffer.byteLength(content, "utf8") };
}

/** Atomic write-then-rename for the draft transport. */
function writeDraftAtomically(cwd: string, content: string): string {
    const dir = path.join(cwd, DRAFT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(cwd, DRAFT_PATH);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, 0o644);
    return filePath;
}

function loadMapFromFile(
    filePath: string,
    cwd: string,
): { map: unknown; absolutePath: string } {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    let raw: string;
    try {
        const stat = fs.statSync(absolute);
        if (stat.size > MAX_MAP_FILE_BYTES) {
            throw new Error(
                `map_file is ${stat.size} bytes, exceeds ${MAX_MAP_FILE_BYTES} byte cap. ` +
                    `Likely a duplicated section; review the JSON and re-write.`,
            );
        }
        raw = fs.readFileSync(absolute, "utf-8");
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(
                `map_file at ${absolute} does not exist. Make sure you called the \`write\` tool first to create it.`,
            );
        }
        throw new Error(`failed to read map_file at ${absolute}: ${msg}`);
    }
    // Strip a leading BOM if present (Phase 1.5).
    if (raw.charCodeAt(0) === 0xfeff) {
        raw = raw.slice(1);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            `map_file at ${absolute} is not valid JSON: ${msg}. ` +
                `Check encoding (UTF-8 expected, no BOM) and that the file is fully written.`,
        );
    }
    return { map: parsed, absolutePath: absolute };
}

function readCanonicalMap(cwd: string): CodebaseMap | null {
    const filePath = path.join(cwd, AGENTIFY_OUTPUT_DIR, MAP_FILENAME);
    if (!fs.existsSync(filePath)) return null;
    const loaded = loadMapFromFile(filePath, cwd);
    return loaded.map as CodebaseMap;
}

function validateMap(map: unknown): { ok: true; value: CodebaseMap } | { ok: false; error: string } {
    const errors = Value.Errors(CodebaseMapSchema, map);
    if (errors.length === 0) {
        return { ok: true, value: map as CodebaseMap };
    }
    // Format the first 10 errors with full context. Error messages
    // must be specific enough for the agent to fix the input on
    // the next attempt.
    const formatted = errors
        .slice(0, 10)
        .map((e) => {
            // typebox 1.1.x error shape is TLocalizedValidationError with
            // `instancePath`, `schemaPath`, `keyword`, `params`, `message`.
            // The legacy shape used `path`, `schema`, `value`. We handle
            // both for forward/backward compat.
            const errAny = e as unknown as {
                path?: string;
                instancePath?: string;
                schemaPath?: string;
                schema?: unknown;
                value?: unknown;
                message: string;
            };
            const errPath = errAny.path || errAny.instancePath || "(root)";
            const expected = errAny.schema ? describeTypeBoxNode(errAny.schema) : "unknown";
            const valueSnippet =
                errAny.value !== undefined
                    ? ` (got: ${truncateForError(JSON.stringify(errAny.value))})`
                    : "";
            return `  - ${errPath}: ${errAny.message}, expected ${expected}${valueSnippet}`;
        })
        .join("\n");
    const moreCount = errors.length > 10 ? ` (and ${errors.length - 10} more)` : "";
    return {
        ok: false,
        error: `Schema validation failed with ${errors.length} error(s)${moreCount}:\n${formatted}`,
    };
}

function validatePartialMap(map: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    // Reuse the same error-formatting path via the canonical schema's
    // validation pipeline. We use PartialCodebaseMapSchema for partial
    // deltas; the rest of the error formatting is identical.
    const errors = Value.Errors(PartialCodebaseMapSchema, map);
    if (errors.length === 0) {
        return { ok: true, value: map as Record<string, unknown> };
    }
    const formatted = errors
        .slice(0, 10)
        .map((e) => {
            const errAny = e as unknown as {
                path?: string;
                instancePath?: string;
                schemaPath?: string;
                schema?: unknown;
                value?: unknown;
                message: string;
            };
            const errPath = errAny.path || errAny.instancePath || "(root)";
            const expected = errAny.schema ? describeTypeBoxNode(errAny.schema) : "unknown";
            const valueSnippet =
                errAny.value !== undefined
                    ? ` (got: ${truncateForError(JSON.stringify(errAny.value))})`
                    : "";
            return `  - ${errPath}: ${errAny.message}, expected ${expected}${valueSnippet}`;
        })
        .join("\n");
    const moreCount = errors.length > 10 ? ` (and ${errors.length - 10} more)` : "";
    return {
        ok: false,
        error: `Partial schema validation failed with ${errors.length} error(s)${moreCount}:\n${formatted}`,
    };
}

function describeTypeBoxNode(node: unknown): string {
    // Pull a short description from a TypeBox schema node so the
    // LLM knows what shape was expected when validation fails.
    if (!node || typeof node !== "object") return "unknown";
    const n = node as {
        type?: string | string[];
        enum?: unknown[];
        const?: unknown;
        anyOf?: unknown[];
        oneOf?: unknown[];
        allOf?: unknown[];
        format?: string;
        minimum?: number;
        maximum?: number;
        minLength?: number;
        maxLength?: number;
        pattern?: string;
        required?: string[];
        properties?: Record<string, unknown>;
        items?: unknown;
    };
    if (n.enum && Array.isArray(n.enum)) return `one of ${JSON.stringify(n.enum)}`;
    if (n.const !== undefined) return `const ${JSON.stringify(n.const)}`;
    if (n.anyOf) return `anyOf [${n.anyOf.length} options]`;
    if (n.oneOf) return `oneOf [${n.oneOf.length} options]`;
    if (n.allOf) return `allOf [${n.allOf.length} options]`;
    if (n.type === "array") {
        const items = n.items ? describeTypeBoxNode(n.items) : "unknown";
        return `array of ${items}`;
    }
    if (n.type === "object") {
        if (n.properties) {
            const keys = Object.keys(n.properties);
            const req = n.required ?? [];
            const reqMark = (k: string) => (req.includes(k) ? "" : "?");
            return `object { ${keys.map((k) => `${k}${reqMark(k)}`).join(", ")} }`;
        }
        return "object";
    }
    if (n.type === "string" && n.format) return `string (format: ${n.format})`;
    if (n.type === "string" && n.pattern) return `string (pattern)`;
    if (n.type === "string" && (n.minLength !== undefined || n.maxLength !== undefined)) {
        return `string (length ${n.minLength ?? 0}..${n.maxLength ?? "∞"})`;
    }
    if (n.type === "number" || n.type === "integer") {
        if (n.minimum !== undefined || n.maximum !== undefined) {
            return `${n.type} (range ${n.minimum ?? "-∞"}..${n.maximum ?? "∞"})`;
        }
        return n.type;
    }
    if (typeof n.type === "string") return n.type;
    if (Array.isArray(n.type)) return n.type.join(" | ");
    return "unknown";
}

function truncateForError(s: string, max = 80): string {
    return s.length > max ? s.slice(0, max) + "…" : s;
}

// ============================================================================
// Merge strategies (Phase 1.2)
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shallowOverwrite(
    target: Record<string, unknown>,
    delta: Record<string, unknown>,
): Record<string, unknown> {
    // Per-key replacement. Arrays and nested objects in the delta
    // replace the matching key in the target.
    return { ...target, ...delta };
}

function deepMerge(
    target: Record<string, unknown>,
    delta: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...target };
    for (const [k, v] of Object.entries(delta)) {
        const existing = result[k];
        if (isPlainObject(existing) && isPlainObject(v)) {
            result[k] = deepMerge(existing, v);
        } else {
            result[k] = v;
        }
    }
    return result;
}

function appendArrays(
    target: Record<string, unknown>,
    delta: Record<string, unknown>,
): Record<string, unknown> {
    // For arrays in the delta, push onto the existing target array.
    // For non-array values, shallow-overwrite.
    const result: Record<string, unknown> = { ...target };
    for (const [k, v] of Object.entries(delta)) {
        const existing = result[k];
        if (Array.isArray(v) && Array.isArray(existing)) {
            result[k] = [...existing, ...v];
        } else if (isPlainObject(existing) && isPlainObject(v)) {
            result[k] = deepMerge(existing, v);
        } else {
            result[k] = v;
        }
    }
    return result;
}

function applyMerge(
    target: Record<string, unknown>,
    delta: Record<string, unknown>,
    strategy: "shallow_overwrite" | "deep_merge" | "append",
): Record<string, unknown> {
    switch (strategy) {
        case "shallow_overwrite":
            return shallowOverwrite(target, delta);
        case "deep_merge":
            return deepMerge(target, delta);
        case "append":
            return appendArrays(target, delta);
    }
}

// ============================================================================
// write_map tool
// ============================================================================

export const writeMapTool = defineTool({
    name: "write_map",
    label: "Write Codebase Map",
    description:
        "Persist the 10-dimension codebase map to ./.pi/agentify/codebase_map.json. " +
        "Schema-enforced via TypeBox. Two modes: (1) inline `map` for small maps (≤ 3KB); " +
        "(2) `map_file` pointing to a JSON file for large maps. The tool reads, " +
        "validates, and writes the canonical map. Gap entries in the coverage block are " +
        "allowed in the data and reported in the result; weak `covered` entries are " +
        "also reported with the same closure rules as the final post-run gate. " +
        "In `auto` mode (default), inline maps that exceed 100KB are transparently " +
        "fall-backed to the file-based transport. " +
        "Call multiple times during exploration to persist progress; call once with the " +
        "final map before rendering the report.",
    parameters: WriteMapParamsSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
        const mode = params.mode ?? "auto";
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
                            "string, call the `write` tool with path=" +
                            "\".pi/agentify/.agentify/draft.json\" and content=<the json " +
                            "string>, then call write_map with " +
                            "{map_file: \".pi/agentify/.agentify/draft.json\"}.",
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
            // Inline path.
            if (mode === "file") {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                "Error: write_map called with `mode: 'file'` and inline `map`. " +
                                "Use the file-based mode instead: build the JSON as a string, " +
                                "call `write` with path=\".pi/agentify/.agentify/draft.json\" and " +
                                "content=<the json string>, then call write_map with " +
                                "{map_file: \".pi/agentify/.agentify/draft.json\"}.",
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
                                    "call `write` with path=\".pi/agentify/.agentify/draft.json\" and " +
                                    "content=<the json string>, then call write_map with " +
                                    "{map_file: \".pi/agentify/.agentify/draft.json\"}.",
                            },
                        ],
                        isError: true,
                details: undefined as unknown as Record<string, unknown>,
                    };
                }
                // mode === "auto" — fall back to file-based transport.
                try {
                    const draftPath = writeDraftAtomically(
                        ctx.cwd,
                        JSON.stringify(params.map, null, 2),
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

        // Apply defaults (schema_version, generated_at) before validation.
        const { map: withDefaults, injectedDefaults } = applyMapDefaults(mapInput);

        // Validate against the TypeBox schema.
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

        // Persist the canonical map.
        let writeResult: { path: string; size_bytes: number };
        try {
            writeResult = writeCanonicalMap(ctx.cwd, validMap);
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

// ============================================================================
// write_map_delta tool (Phase 1.2)
// ============================================================================

export const writeMapDeltaTool = defineTool({
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
        // 1. Read the canonical map.
        const existing = readCanonicalMap(ctx.cwd);
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

        // 2. Validate the delta.
        const validation = validatePartialMap(params.delta as unknown);
        if (!validation.ok) {
            return {
                content: [{ type: "text", text: `Error: ${validation.error}` }],
                isError: true,
                details: undefined as unknown as Record<string, unknown>,
            };
        }

        // 3. Reserve tracking (observability only — the soft ceiling
        //    never blocks; it surfaces a warning for runaway retries).
        let reserveWarning: string | undefined;
        if (params.dimension) {
            reserveWarning = consumeReserve(params.dimension).reason;
        }

        // 4. Merge the delta into the existing map.
        const strategy = params.merge_strategy ?? "shallow_overwrite";
        const merged = applyMerge(
            existing as unknown as Record<string, unknown>,
            validation.value,
            strategy,
        );

        // 5. Set the dimension's coverage entry (if requested).
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

        // 6. Append to exploration_log.
        const log = (merged.exploration_log ?? []) as Array<Record<string, unknown>>;
        log.push({
            ts: new Date().toISOString(),
            action: "gap_filler_delta",
            target: params.dimension ?? "(no-dim)",
            observation: `merged delta from write_map_delta (strategy=${strategy})`,
        });
        merged.exploration_log = log;

        // 7. Apply defaults.
        const { map: withDefaults } = applyMapDefaults(merged);

        // 8. Validate the merged result against the canonical schema.
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

        // 9. Persist the canonical map.
        let writeResult: { path: string; size_bytes: number };
        try {
            writeResult = writeCanonicalMap(ctx.cwd, validMap);
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
