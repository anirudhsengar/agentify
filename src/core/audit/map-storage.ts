import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import { LEGACY_PI_STATE_RELATIVE_DIR } from "../state-dir.ts";
import { CodebaseMapSchema, type CodebaseMap } from "./schema.ts";
import { loadMapFromFile } from "./map-input.ts";

export const DEFAULT_MAP_FILENAME = "codebase_map.json";
export const LEGACY_DRAFT_DIRECTORY_RELATIVE = path.join(
    LEGACY_PI_STATE_RELATIVE_DIR,
    ".agentify",
);
export const LEGACY_DRAFT_PATH_RELATIVE = path.join(
    LEGACY_DRAFT_DIRECTORY_RELATIVE,
    "draft.json",
);
export const LEGACY_HISTORY_DIRECTORY_RELATIVE = path.join(
    LEGACY_PI_STATE_RELATIVE_DIR,
    "history",
);

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

const mapToolExecutionContext = new AsyncLocalStorage<MapToolExecutionContext>();
let currentSessionStateDir = LEGACY_PI_STATE_RELATIVE_DIR;

export function setLegacyMapSessionStateDir(stateDir: string): void {
    currentSessionStateDir = stateDir;
}

export function activeMapPathConfig(): MapToolExecutionContext {
    return mapToolExecutionContext.getStore() ?? {
        stateDir: currentSessionStateDir,
        mapFilename: DEFAULT_MAP_FILENAME,
    };
}

export function activeDraftPathRelative(): string {
    const scoped = mapToolExecutionContext.getStore();
    return scoped
        ? path.join(scoped.stateDir, ".agentify", "draft.json")
        : LEGACY_DRAFT_PATH_RELATIVE;
}

export function runWithMapToolExecutionContext<T>(
    context: MapToolExecutionContext,
    fn: () => T,
): T {
    return mapToolExecutionContext.run(context, fn);
}

export function legacyCanonicalMapPath(cwd: string): string {
    return path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, DEFAULT_MAP_FILENAME);
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

export function loadLegacyCanonicalMap(cwd: string): CodebaseMap | null {
    return loadValidatedCanonicalCandidate(legacyCanonicalMapPath(cwd));
}

export function loadCanonicalMapAt(cwd: string, stateDir: string): CodebaseMap | null {
    const candidates = [
        path.join(cwd, stateDir, DEFAULT_MAP_FILENAME),
        path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, DEFAULT_MAP_FILENAME),
    ];
    for (const filePath of candidates) {
        if (!fs.existsSync(filePath)) continue;
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
        if (Value.Check(CodebaseMapSchema, parsed)) {
            return parsed as CodebaseMap;
        }
    }
    return null;
}

export function readCanonicalMap(cwd: string): CodebaseMap | null {
    const scoped = mapToolExecutionContext.getStore();
    const filePath = scoped
        ? path.join(cwd, scoped.stateDir, scoped.mapFilename)
        : legacyCanonicalMapPath(cwd);
    if (!fs.existsSync(filePath)) return null;
    const loaded = loadMapFromFile(filePath, cwd);
    return loaded.map as CodebaseMap;
}

export function writeCanonicalMap(
    cwd: string,
    map: CodebaseMap,
): { path: string; size_bytes: number } {
    const config = activeMapPathConfig();
    const dir = path.join(cwd, config.stateDir);
    fs.mkdirSync(dir, { recursive: true });

    const existingPath = path.join(dir, config.mapFilename);
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

    const filePath = path.join(dir, config.mapFilename);
    const content = JSON.stringify(map, null, 2);
    fs.writeFileSync(filePath, content, { mode: 0o644 });
    return { path: filePath, size_bytes: Buffer.byteLength(content, "utf8") };
}

export function writeDraftAtomically(cwd: string, content: string): string {
    const filePath = path.join(cwd, activeDraftPathRelative());
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, 0o644);
    return filePath;
}
