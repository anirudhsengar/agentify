import {
    assessCoverageClosure,
    COVERAGE_DIMENSIONS,
    type CodebaseMap,
    type CoverageDimension,
} from "./schema.ts";

export interface FormattedCoverageClosure {
    closed: CoverageDimension[];
    unresolved: CoverageDimension[];
    reasons: Record<string, string>;
    line: string;
    warnings: string[] | null;
}

export function formatCoverageClosure(map: CodebaseMap): FormattedCoverageClosure {
    const closure = assessCoverageClosure(map);
    const warnings =
        closure.unresolved.length > 0
            ? closure.unresolved.map((dimension) =>
                `${dimension}: ${closure.reasons[dimension] ?? "not closed"}`,
            )
            : null;
    const line =
        warnings === null
            ? `All ${COVERAGE_DIMENSIONS.length} coverage dimensions closed.`
            : `${closure.closed.length}/${COVERAGE_DIMENSIONS.length} coverage dimensions closed. ` +
                `Unresolved: ${warnings.join("; ")}.`;
    return {
        closed: closure.closed,
        unresolved: closure.unresolved,
        reasons: closure.reasons,
        line,
        warnings,
    };
}
