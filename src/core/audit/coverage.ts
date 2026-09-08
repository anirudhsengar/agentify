import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodebaseMap } from "./schema.ts";

const AGENTIFY_GENERATED_EVIDENCE_PATH = /^(?:\.agentify(?:\/|$)|\.github\/agentify(?:\/|$)|\.github\/agentify-task-policy\.json$|\.github\/workflows\/agentify-(?:issue|learn)\.yml$)/;

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

export interface CoverageClosureOptions {
    /** Repository root for verifying that evidence citations point at real paths. */
    cwd?: string;
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
                !hasItems(map.type_contract_surface.type_definitions)
                && !hasItems(map.type_contract_surface.typescript_interfaces)
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

interface EvidenceCitationLike {
    path: string;
    excerpt: string;
    kind: "positive" | "absence";
}

function isEvidenceCitationLike(value: unknown): value is EvidenceCitationLike {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.path === "string"
        && typeof record.excerpt === "string"
        && (record.kind === "positive" || record.kind === "absence")
    );
}

function evidencePathUnderRoot(cwd: string, citationPath: string): { absolute: string; underRoot: boolean } {
    const resolved = path.resolve(cwd, citationPath);
    const root = path.resolve(cwd);
    const separator = path.sep;
    // Resolve-normalized paths under the root must either equal the root or start with root + separator.
    const underRoot = resolved === root || resolved.startsWith(`${root}${separator}`);
    return { absolute: resolved, underRoot };
}

function trackedRegularFilesAtHead(cwd: string): Set<string> | undefined {
    const result = spawnSync(
        "git",
        ["-C", cwd, "ls-tree", "-r", "-z", "--full-tree", "HEAD"],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.status !== 0) return undefined;
    const modes = new Map<string, string>();
    for (const entry of result.stdout.split("\0")) {
        const match = entry.match(/^(100644|100755|120000) blob [0-9a-f]+\t(.+)$/);
        if (match?.[1] !== undefined && match[2] !== undefined) modes.set(match[2], match[1]);
    }
    const tracked = new Set<string>();
    const resolvesToRegular = (repositoryPath: string, depth = 0): boolean => {
        const mode = modes.get(repositoryPath);
        if (mode === "100644" || mode === "100755") return true;
        if (mode !== "120000" || depth >= 4) return false;
        const targetResult = spawnSync(
            "git",
            ["-C", cwd, "show", `HEAD:${repositoryPath}`],
            { encoding: "utf8", maxBuffer: 4 * 1024 },
        );
        const target = targetResult.status === 0 ? targetResult.stdout : "";
        if (!target || target.includes("\0") || path.posix.isAbsolute(target)) return false;
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(repositoryPath), target));
        return resolved !== ".." && !resolved.startsWith("../")
            && resolvesToRegular(resolved, depth + 1);
    };
    for (const repositoryPath of modes.keys()) {
        if (resolvesToRegular(repositoryPath)) tracked.add(repositoryPath);
    }
    return tracked;
}

function verifyCitationTarget(
    cwd: string,
    citation: EvidenceCitationLike,
    trackedFiles: ReadonlySet<string> | undefined,
): string | null {
    const { absolute, underRoot } = evidencePathUnderRoot(cwd, citation.path);
    if (!underRoot) {
        return `covered but evidence citation path escapes repository root: ${citation.path}`;
    }
    const repositoryPath = path.relative(path.resolve(cwd), absolute).replaceAll(path.sep, "/");
    if (AGENTIFY_GENERATED_EVIDENCE_PATH.test(repositoryPath)) {
        return `covered but Agentify-generated evidence path cannot describe the repository: ${citation.path}`;
    }
    if (trackedFiles !== undefined) {
        const tracked = trackedFiles.has(repositoryPath);
        if (citation.kind === "positive" && !tracked) {
            return `covered but positive evidence path is not a regular file tracked at repository HEAD: ${citation.path}`;
        }
        if (citation.kind === "absence" && tracked) {
            return `covered but absence evidence path is tracked at repository HEAD: ${citation.path}`;
        }
        return null;
    }
    let exists: boolean;
    try {
        exists = fs.existsSync(absolute);
    } catch {
        exists = false;
    }
    if (citation.kind === "positive" && !exists) {
        return `covered but positive evidence path does not exist: ${citation.path}`;
    }
    if (citation.kind === "absence" && exists) {
        return `covered but absence evidence path exists: ${citation.path}`;
    }
    return null;
}

function assessEvidenceCitations(
    entry: { evidence?: readonly EvidenceCitationLike[] },
    dimension: CoverageDimension,
    cwd?: string,
    trackedFiles?: ReadonlySet<string>,
): string | null {
    const evidence = entry.evidence;
    if (!Array.isArray(evidence) || evidence.length === 0) {
        return "covered but no evidence citations were provided";
    }
    for (const citation of evidence) {
        if (!isEvidenceCitationLike(citation)) {
            return `covered but ${dimension} evidence is missing path, excerpt, or kind`;
        }
        if (cwd !== undefined) {
            const failure = verifyCitationTarget(cwd, citation, trackedFiles);
            if (failure !== null) return failure;
        }
    }
    return null;
}

/**
 * Decide, per dimension, whether the map has closed it for real.
 * A dimension is closed only when its coverage entry is `covered`,
 * its `evidence_summary` is non-empty, its evidence citations are present,
 * and any dimension-specific substance rule is satisfied.
 */
export function assessCoverageClosure(
    map: CodebaseMap,
    options?: CoverageClosureOptions,
): CoverageClosureResult {
    const closed: CoverageDimension[] = [];
    const unresolved: CoverageDimension[] = [];
    const reasons: Record<string, string> = {};
    const trackedFiles = options?.cwd === undefined
        ? undefined
        : trackedRegularFilesAtHead(options.cwd);

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
        const evidenceFailure = assessEvidenceCitations(
            entry,
            dimension,
            options?.cwd,
            trackedFiles,
        );
        if (evidenceFailure !== null) {
            unresolved.push(dimension);
            reasons[dimension] = evidenceFailure;
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

/**
 * Repository-specialist discovery reads `concern_evidence.concerns` from the
 * canonical map. The audit is not complete until that structure has been
 * explicitly recorded: an honest empty `concerns` list is valid for a
 * repository too small to have distinct specialties, but an absent field means
 * the model never looked for concerns at all and discovery would silently
 * produce an empty portfolio.
 *
 * `expert_evidence` is the superseded directory-shaped predecessor. It still
 * satisfies the gate so maps written before the concern contract can be
 * attached and migrated rather than re-audited from scratch.
 */
export function specialistEvidenceRecorded(map: CodebaseMap): boolean {
    return map.concern_evidence !== undefined || map.expert_evidence !== undefined;
}

export interface AuditCompletionResult {
    coverage: CoverageClosureResult;
    /** True once `concern_evidence` (or legacy `expert_evidence`) exists, even when honestly empty. */
    specialistEvidenceRecorded: boolean;
    /** True only when every coverage dimension is closed AND specialist evidence is recorded. */
    complete: boolean;
}

/**
 * The full audit completion gate: all ten coverage dimensions closed plus an
 * explicit specialist-evidence decision. The runtime and the installer attach
 * path use this so a session can never end (or be skipped) before specialist
 * discovery has its authoritative input.
 */
export function assessAuditCompletion(
    map: CodebaseMap,
    options?: CoverageClosureOptions,
): AuditCompletionResult {
    const coverage = assessCoverageClosure(map, options);
    const recorded = specialistEvidenceRecorded(map);
    return {
        coverage,
        specialistEvidenceRecorded: recorded,
        complete: coverage.unresolved.length === 0 && recorded,
    };
}
