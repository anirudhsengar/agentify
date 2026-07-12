import type { CodebaseMap } from "./schema.ts";

export interface AppliedMapDefaults {
    map: CodebaseMap;
    injectedDefaults: string[];
}

/**
 * Returns a shallow clone of `userMap` with `schema_version` and
 * `generated_at` filled in if absent. Does not mutate the input.
 * The injected field names are returned in `injectedDefaults` so
 * the caller can report which defaults were applied.
 */
export function applyMapDefaults(userMap: unknown): AppliedMapDefaults {
    const cloned: Record<string, unknown> = {
        ...(userMap as Record<string, unknown>),
    };
    const injectedDefaults: string[] = [];
    if (cloned.schema_version === undefined) {
        cloned.schema_version = "1";
        injectedDefaults.push("schema_version");
    }
    if (cloned.generated_at === undefined) {
        cloned.generated_at = new Date().toISOString();
        injectedDefaults.push("generated_at");
    }
    return { map: cloned as CodebaseMap, injectedDefaults };
}
