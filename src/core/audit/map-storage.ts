import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import { CodebaseMapSchema, type CodebaseMap } from "./schema.ts";
import { loadMapFromFile } from "./map-input.ts";

export const DEFAULT_MAP_FILENAME = "codebase_map.json";

export interface MapPathConfig {
    /** State dir, e.g. ".claude/agentify". */
    stateDir: string;
    /** Override the canonical map filename. Defaults to `codebase_map.json`. */
    mapFilename?: string;
}

export interface MapToolExecutionContext {
    stateDir: string;
    mapFilename: string;
}

export function draftPathRelative(context: MapToolExecutionContext): string {
    return path.join(context.stateDir, ".agentify", "draft.json");
}

function loadValidatedCanonicalCandidate(filePath: string): CodebaseMap | null {
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

export function loadCanonicalMapAt(cwd: string, stateDir: string): CodebaseMap | null {
    return loadValidatedCanonicalCandidate(
        path.join(cwd, stateDir, DEFAULT_MAP_FILENAME),
    );
}

export function readCanonicalMap(
    cwd: string,
    context: MapToolExecutionContext,
): CodebaseMap | null {
    const filePath = path.join(cwd, context.stateDir, context.mapFilename);
    if (!fs.existsSync(filePath)) return null;
    const loaded = loadMapFromFile(filePath, cwd);
    return loaded.map as CodebaseMap;
}

export function writeCanonicalMap(
    cwd: string,
    map: CodebaseMap,
    context: MapToolExecutionContext,
): { path: string; size_bytes: number } {
    const dir = path.join(cwd, context.stateDir);
    fs.mkdirSync(dir, { recursive: true });

    const existingPath = path.join(dir, context.mapFilename);
    if (fs.existsSync(existingPath)) {
        try {
            const histDir = path.join(dir, "history");
            fs.mkdirSync(histDir, { recursive: true });
            const isoTs = new Date().toISOString().replace(/[:.]/g, "-");
            const archivePath = path.join(histDir, `codebase_map.${isoTs}.previous.json`);
            fs.copyFileSync(existingPath, archivePath);
        } catch {
            // Archive failures are non-fatal; the new write still happens.
        }
    }

    const filePath = path.join(dir, context.mapFilename);
    const content = JSON.stringify(map, null, 2);
    fs.writeFileSync(filePath, content, { mode: 0o644 });
    return { path: filePath, size_bytes: Buffer.byteLength(content, "utf8") };
}

export function writeDraftAtomically(
    cwd: string,
    content: string,
    context: MapToolExecutionContext,
): string {
    const filePath = path.join(cwd, draftPathRelative(context));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, 0o644);
    return filePath;
}
