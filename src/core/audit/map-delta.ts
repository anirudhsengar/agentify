export type MapMergeStrategy = "shallow_overwrite" | "deep_merge" | "append";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shallowOverwrite(
    target: Record<string, unknown>,
    delta: Record<string, unknown>,
): Record<string, unknown> {
    return { ...target, ...delta };
}

function deepMerge(
    target: Record<string, unknown>,
    delta: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(delta)) {
        const existing = result[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            result[key] = deepMerge(existing, value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

function appendArrays(
    target: Record<string, unknown>,
    delta: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(delta)) {
        const existing = result[key];
        if (Array.isArray(value) && Array.isArray(existing)) {
            result[key] = [...existing, ...value];
        } else if (isPlainObject(existing) && isPlainObject(value)) {
            result[key] = deepMerge(existing, value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

export function applyMapDelta(
    target: Record<string, unknown>,
    delta: Record<string, unknown>,
    strategy: MapMergeStrategy,
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
