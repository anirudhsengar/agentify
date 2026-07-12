import * as fs from "node:fs";
import * as path from "node:path";

// Cap map_file size at 1 MB. A 1 MB JSON map is suspicious —
// either the LLM duplicated something or the JSON is malformed.
export const MAX_MAP_FILE_BYTES = 1_000_000;

// Cap inline map at 100 KB (TypeBox's value validator is fine
// with this size, but anything larger is unreadable in tool args).
export const MAX_INLINE_MAP_BYTES = 100_000;

export interface LoadedMapInput {
    map: unknown;
    absolutePath: string;
}

export function loadMapFromFile(filePath: string, cwd: string): LoadedMapInput {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    let raw: string;
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(absolute, "r");
        const stat = fs.fstatSync(descriptor);
        if (stat.size > MAX_MAP_FILE_BYTES) {
            throw new Error(
                `map_file is ${stat.size} bytes, exceeds ${MAX_MAP_FILE_BYTES} byte cap. ` +
                    `Likely a duplicated section; review the JSON and re-write.`,
            );
        }
        raw = fs.readFileSync(descriptor, "utf-8");
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(
                `map_file at ${absolute} does not exist. Make sure you called the \`write\` tool first to create it.`,
            );
        }
        throw new Error(`failed to read map_file at ${absolute}: ${msg}`);
    } finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Preserve the established read/validation result if close fails.
            }
        }
    }
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
