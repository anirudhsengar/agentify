// Stable internal façade for the structured write-map boundary.
// All tools and paths are created from explicit state-directory configuration.

export { loadCanonicalMapAt } from "./map-storage.ts";
export type { MapPathConfig } from "./map-storage.ts";
export {
    getReserveCount,
    resetReserveCounters,
} from "./map-observability.ts";
export { createWriteMapTools } from "./write-map-tools.ts";
export type { MapTools } from "./write-map-tools.ts";
