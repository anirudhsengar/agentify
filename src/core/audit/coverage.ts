import type { CodebaseMap } from "./schema.ts";

export const COVERAGE_DIMENSIONS = [
    "D1_topography",
    "D2_module_boundaries",
    "D3_type_contract",
    "D4_conventions",
    "D5_pitfalls",
    "D6_validation",
    "D7_operational",
    "D8_security",
    "D9_process",
    "D10_documentation",
] as const;

export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

/** Hard cap on generated AGENTS.md length (see builder prompt). */
export const AGENTS_MD_MAX_LINES = 200;

/** Minimum pitfalls the map must carry when D5 is claimed covered. */
export const MIN_PITFALLS_FOR_COVERED = 1;

export interface CoverageSummary {
    covered: CoverageDimension[];
    gap: CoverageDimension[];
    total: number;
}

export interface CoverageClosureResult {
    /** Dimensions that are `covered` AND satisfy the substance rules. */
    closed: CoverageDimension[];
    /** Dimensions that are `gap`, or `covered` but failing substance. */
    unresolved: CoverageDimension[];
    /** Human-readable reasons keyed by dimension for the unresolved set. */
    reasons: Record<string, string>;
}

/**
 * The TypeBox contract validates shape, while this module enforces the
 * evidence/substance gate that gives a `covered` status its runtime meaning.
 * Keep reason text and dimension order stable because they are surfaced in
 * logs, tool feedback, and generated-output gates.
 */
export function extractCoverageSummary(map: CodebaseMap): CoverageSummary {
    const covered: CoverageDimension[] = [];
    const gap: CoverageDimension[] = [];
    for (const dim of COVERAGE_DIMENSIONS) {
        const status = map.coverage[dim].status;
        if (status === "covered") covered.push(dim);
        else gap.push(dim);
    }
    return { covered, gap, total: COVERAGE_DIMENSIONS.length };
}

function isNonEmptyString(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

function hasItems<T>(value: T[] | undefined): value is [T, ...T[]] {
    return Array.isArray(value) && value.length > 0;
}

function hasMandatoryCommand(value: { mandatory: string[]; optional: string[] } | undefined): boolean {
    return Array.isArray(value?.mandatory) && value.mandatory.some(isNonEmptyString);
}

function assessDimensionSubstance(map: CodebaseMap, dimension: CoverageDimension): string | null {
    switch (dimension) {
        case "D1_topography":
            if (!hasItems(map.skeleton.top_level_tree)) return "covered but top_level_tree is empty";
            if (!hasItems(map.skeleton.entry_points)) return "covered but no entry point was recorded";
            if (!hasItems(map.skeleton.first_5_files_for_fresh_agent)) {
                return "covered but no first files were recorded for a fresh agent";
            }
            return null;
        case "D2_module_boundaries":
            if (
                !hasItems(map.module_graph.edges)
                && !hasItems(map.module_graph.parallelizable_subtrees)
                && !hasItems(map.module_graph.shared_abstractions)
                && !hasItems(map.module_graph.shared_state)
                && map.module_graph.client_server_split === null
            ) {
                return "covered but no module boundary evidence was recorded";
            }
            return null;
        case "D3_type_contract":
            if (
                !hasItems(map.type_contract_surface.typescript_interfaces)
                && !hasItems(map.type_contract_surface.pydantic_models)
                && !hasItems(map.type_contract_surface.db_models)
                && !hasItems(map.type_contract_surface.idks)
                && !hasItems(map.type_contract_surface.stable_types)
                && map.type_contract_surface.one_type_trace === null
            ) {
                return "covered but no type or contract evidence was recorded";
            }
            return null;
        case "D4_conventions":
            if (!isNonEmptyString(map.conventions.naming.files) || !isNonEmptyString(map.conventions.naming.functions)) {
                return "covered but naming convention evidence is incomplete";
            }
            if (!isNonEmptyString(map.conventions.logging.pattern)) {
                return "covered but logging convention evidence is incomplete";
            }
            return null;
        case "D5_pitfalls": {
            const withRefs = map.pitfalls.filter(
                (pitfall) =>
                    pitfall
                    && typeof pitfall.line_ref === "number"
                    && isNonEmptyString(pitfall.module)
                    && isNonEmptyString(pitfall.what)
                    && isNonEmptyString(pitfall.consequence),
            );
            if (withRefs.length < MIN_PITFALLS_FOR_COVERED) {
                return (
                    `covered but only ${withRefs.length} substantive pitfall(s); `
                    + `need >= ${MIN_PITFALLS_FOR_COVERED} with module, what, consequence, and line_ref`
                );
            }
            return null;
        }
        case "D6_validation":
            if (!isNonEmptyString(map.validation_surface.test_command)) {
                return "covered but test/validation command evidence is empty";
            }
            if (
                !hasMandatoryCommand(map.validation_surface.per_change_type.chore)
                || !hasMandatoryCommand(map.validation_surface.per_change_type.bug)
                || !hasMandatoryCommand(map.validation_surface.per_change_type.feature)
            ) {
                return "covered but mandatory per-change validation commands are incomplete";
            }
            return null;
        case "D7_operational":
            if (!isNonEmptyString(map.operational_surface.build.command)) {
                return "covered but build command evidence is empty";
            }
            if (!isNonEmptyString(map.operational_surface.run.command)) {
                return "covered but run command evidence is empty";
            }
            if (!isNonEmptyString(map.operational_surface.git_workflow.main_branch)) {
                return "covered but git workflow evidence is incomplete";
            }
            return null;
        case "D8_security":
            if (!hasItems(map.security_surface.paths.zero_access)) {
                return "covered but zero-access security paths are empty";
            }
            if (!hasItems(map.security_surface.bash_blocked_patterns) && !hasItems(map.security_surface.damage_control_rules)) {
                return "covered but security damage-control evidence is empty";
            }
            return null;
        case "D9_process":
            if (!isNonEmptyString(map.meta.lifecycle.sdlc_model)) {
                return "covered but process lifecycle model is empty";
            }
            if (!hasItems(map.meta.lifecycle.issue_types)) {
                return "covered but issue process types are empty";
            }
            return null;
        case "D10_documentation": {
            const docsPresent = isNonEmptyString(map.meta.documentation.agents_md)
                || map.meta.documentation.has_ai_docs
                || map.meta.documentation.has_app_docs
                || map.meta.documentation.has_specs
                || map.meta.documentation.readme_metrics.present;
            if (!docsPresent) return "covered but no documentation surface was recorded";
            if (map.meta.documentation.readme_metrics.present && map.meta.documentation.readme_metrics.section_count <= 0) {
                return "covered but README documentation metrics are incomplete";
            }
            return null;
        }
    }
}

/**
 * Decide, per dimension, whether the map has closed it for real.
 * A dimension is closed only when its coverage entry is `covered`,
 * its `evidence_summary` is non-empty, and any dimension-specific
 * substance rule is satisfied.
 */
export function assessCoverageClosure(map: CodebaseMap): CoverageClosureResult {
    const closed: CoverageDimension[] = [];
    const unresolved: CoverageDimension[] = [];
    const reasons: Record<string, string> = {};

    for (const dimension of COVERAGE_DIMENSIONS) {
        const entry = map.coverage?.[dimension];
        if (!entry || entry.status !== "covered") {
            unresolved.push(dimension);
            reasons[dimension] = "coverage status is not 'covered'";
            continue;
        }
        if (!isNonEmptyString(entry.evidence_summary)) {
            unresolved.push(dimension);
            reasons[dimension] = "covered but evidence_summary is empty";
            continue;
        }
        const substanceFailure = assessDimensionSubstance(map, dimension);
        if (substanceFailure !== null) {
            unresolved.push(dimension);
            reasons[dimension] = substanceFailure;
            continue;
        }
        closed.push(dimension);
    }

    return { closed, unresolved, reasons };
}
