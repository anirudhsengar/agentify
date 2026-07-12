import { LEGACY_PI_STATE_RELATIVE_DIR } from "../state-dir.ts";
import {
    DEFAULT_MAP_FILENAME,
    LEGACY_DRAFT_DIRECTORY_RELATIVE,
    LEGACY_DRAFT_PATH_RELATIVE,
    LEGACY_HISTORY_DIRECTORY_RELATIVE,
    legacyCanonicalMapPath,
    loadLegacyCanonicalMap,
    setLegacyMapSessionStateDir,
} from "./map-storage.ts";
import type { CodebaseMap } from "./schema.ts";

/**
 * @deprecated Historical constant kept for backward compatibility.
 * Use `createWriteMapTools({ stateDir })` instead. Always resolves
 * to the legacy `.pi/agentify/` path.
 */
export const AGENTIFY_OUTPUT_DIR = LEGACY_PI_STATE_RELATIVE_DIR;
/** @deprecated See {@link AGENTIFY_OUTPUT_DIR}. */
export const MAP_FILENAME = DEFAULT_MAP_FILENAME;
/** @deprecated See {@link AGENTIFY_OUTPUT_DIR}. */
export const DRAFT_DIR = LEGACY_DRAFT_DIRECTORY_RELATIVE;
/** @deprecated See {@link AGENTIFY_OUTPUT_DIR}. */
export const DRAFT_PATH = LEGACY_DRAFT_PATH_RELATIVE;
/** @deprecated See {@link AGENTIFY_OUTPUT_DIR}. */
export const HISTORY_DIR = LEGACY_HISTORY_DIRECTORY_RELATIVE;

/**
 * @deprecated Production callers must use `createWriteMapTools({ stateDir })`.
 * Set the per-session state dir that the legacy `writeMapTool` and
 * `writeMapDeltaTool` use for write/read paths. Tests that bypass the
 * supported run path keep the default legacy path.
 */
export function setMapSessionStateDir(stateDir: string): void {
    setLegacyMapSessionStateDir(stateDir);
}

/**
 * @deprecated Probe the legacy `.pi/agentify/codebase_map.json` path.
 * Use `loadCanonicalMapAt(cwd, stateDir)` instead.
 */
export function canonicalMapPath(cwd: string): string {
    return legacyCanonicalMapPath(cwd);
}

/**
 * @deprecated Relative path (posix-style) of the transient draft
 * transport dir under the legacy `.pi/agentify/`. Use
 * `createWriteMapTools({ stateDir })` instead.
 */
export const DRAFT_TRANSPORT_DIR = DRAFT_DIR;

/**
 * Load and schema-validate the canonical codebase map. Returns the
 * validated map, or `null` when the map is absent, unreadable, not
 * JSON, or does not satisfy the schema.
 *
 * @deprecated Probes the legacy `.pi/agentify/codebase_map.json`
 * path. Use `loadCanonicalMapAt(cwd, stateDir)` with the resolved state dir.
 */
export function loadCanonicalMap(cwd: string): CodebaseMap | null {
    return loadLegacyCanonicalMap(cwd);
}
