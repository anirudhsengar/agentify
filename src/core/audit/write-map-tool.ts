// Compatibility façade for the structured write-map boundary.
//
// Cohesive internal owners live in the adjacent map-* and write-map-tools
// modules. Keep this path stable for repository callers and deprecated APIs.

export {
    AGENTIFY_OUTPUT_DIR,
    DRAFT_DIR,
    DRAFT_PATH,
    DRAFT_TRANSPORT_DIR,
    HISTORY_DIR,
    MAP_FILENAME,
    canonicalMapPath,
    loadCanonicalMap,
    setMapSessionStateDir,
} from "./legacy-write-map.ts";
export { loadCanonicalMapAt } from "./map-storage.ts";
export type { MapPathConfig } from "./map-storage.ts";
export {
    getReserveCount,
    resetReserveCounters,
} from "./map-observability.ts";
export {
    createWriteMapTools,
    writeMapDeltaTool,
    writeMapTool,
} from "./write-map-tools.ts";
export type { MapTools } from "./write-map-tools.ts";
