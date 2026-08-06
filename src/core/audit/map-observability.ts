import type { CoverageDimension } from "./schema.ts";

const perDimReserve: Map<CoverageDimension, number> = new Map();

export const GAP_FILLER_SOFT_CEILING = 3;

export function getReserveCount(dimension: CoverageDimension): number {
    return perDimReserve.get(dimension) ?? 0;
}

export function resetReserveCounters(): void {
    perDimReserve.clear();
}

export function consumeReserve(
    dimension: CoverageDimension,
): { allowed: boolean; reason?: string } {
    const current = perDimReserve.get(dimension) ?? 0;
    const beyondSoftCeiling = current >= GAP_FILLER_SOFT_CEILING;
    perDimReserve.set(dimension, current + 1);
    return {
        allowed: true,
        reason: beyondSoftCeiling
            ? `gap_filler dispatched ${current + 1}x for ${dimension} (beyond soft ceiling of ${GAP_FILLER_SOFT_CEILING}; LLM should consider a different angle or mark honest null)`
            : undefined,
    };
}
