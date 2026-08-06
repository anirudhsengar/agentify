import { Value } from "typebox/value";
import {
    CodebaseMapSchema,
    PartialCodebaseMapSchema,
    type CodebaseMap,
} from "./schema.ts";

export type CompleteMapValidation =
    | { ok: true; value: CodebaseMap }
    | { ok: false; error: string };

export type PartialMapValidation =
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; error: string };

function describeTypeBoxNode(node: unknown): string {
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
            const reqMark = (key: string) => (req.includes(key) ? "" : "?");
            return `object { ${keys.map((key) => `${key}${reqMark(key)}`).join(", ")} }`;
        }
        return "object";
    }
    if (n.type === "string" && n.format) return `string (format: ${n.format})`;
    if (n.type === "string" && n.pattern) return "string (pattern)";
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

function truncateForError(value: string, max = 80): string {
    return value.length > max ? value.slice(0, max) + "…" : value;
}

function formatValidationErrors(errors: ReadonlyArray<unknown>, prefix: string): string {
    const formatted = errors
        .slice(0, 10)
        .map((error) => {
            const errAny = error as {
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
    return `${prefix} with ${errors.length} error(s)${moreCount}:\n${formatted}`;
}

export function validateMap(map: unknown): CompleteMapValidation {
    const errors = Value.Errors(CodebaseMapSchema, map);
    if (errors.length === 0) {
        return { ok: true, value: map as CodebaseMap };
    }
    return {
        ok: false,
        error: formatValidationErrors(errors, "Schema validation failed"),
    };
}

export function validatePartialMap(map: unknown): PartialMapValidation {
    const errors = Value.Errors(PartialCodebaseMapSchema, map);
    if (errors.length === 0) {
        return { ok: true, value: map as Record<string, unknown> };
    }
    return {
        ok: false,
        error: formatValidationErrors(errors, "Partial schema validation failed"),
    };
}
