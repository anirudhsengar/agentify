import * as fs from "node:fs";
import * as path from "node:path";
import type { CodebaseMap } from "./schema.ts";
import {
    EXECUTION_ALTERING_ENV,
    NEVER_SOURCE_DIRECTORIES,
    isBareGitRef,
} from "./repository-facts.ts";

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

/** Files where a repository documents which branch contributions target. */
const CONTRIBUTION_GUIDE_FILES = [
    "CONTRIBUTING.md", "CONTRIBUTING.rst", "CONTRIBUTING.txt", "CONTRIBUTING",
    ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md",
] as const;

const DOCUMENTED_PR_BASE =
    /pull requests?[^.\n]{0,80}?\bagainst\b[^.\n]{0,40}?\b(?:the\s+)?`?([A-Za-z0-9._\/-]+)`?\s+branch/i;

/**
 * The branch a repository documents as its pull-request base, read from the
 * repository itself. The contribution-branch guard depends on this being
 * recorded, so it must not rest on the model happening to notice it.
 */
export function documentedContributionBranch(cwd: string): { branch: string; path: string } | null {
    for (const relativePath of CONTRIBUTION_GUIDE_FILES) {
        const absolute = path.join(cwd, ...relativePath.split("/"));
        let content: string;
        try {
            const stat = fs.lstatSync(absolute);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) continue;
            content = fs.readFileSync(absolute, "utf-8");
        } catch {
            continue;
        }
        const match = DOCUMENTED_PR_BASE.exec(content);
        const branch = match?.[1]?.trim();
        if (branch && isBareGitRef(branch)) return { branch, path: relativePath };
    }
    return null;
}

function assessDimensionSubstance(
    map: CodebaseMap,
    dimension: CoverageDimension,
    cwd?: string,
): string | null {
    switch (dimension) {
        case "D1_topography":
            if (!hasItems(map.skeleton.top_level_tree)) return "covered but top_level_tree is empty";
            if (!hasItems(map.skeleton.entry_points)) return "covered but no entry point was recorded";
            if (!hasItems(map.skeleton.first_5_files_for_fresh_agent)) {
                return "covered but no first files were recorded for a fresh agent";
            }
            {
                // Dependency and cache trees are local workspace state, not source.
                const workspaceOnly = map.skeleton.top_level_tree.filter((entry) =>
                    NEVER_SOURCE_DIRECTORIES.has(entry.replaceAll("\\", "/").replace(/\/+$/, ""))
                );
                if (workspaceOnly.length > 0) {
                    return `covered but topography lists local workspace state rather than repository source: ${workspaceOnly.join(", ")}`;
                }
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
            // The trace is what makes a *high-confidence* type claim credible.
            // Without it the dimension can still close, at a confidence that
            // honestly reflects the evidence.
            if (
                map.coverage.D3_type_contract.confidence === "high"
                && map.type_contract_surface.one_type_trace === null
            ) {
                return "covered at high confidence but no end-to-end one_type_trace was recorded; "
                    + "record type_contract_surface.one_type_trace or lower the confidence";
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
            {
                // A command the repository forbids cannot also be its build
                // contract. Commander's audit recorded `npm publish` as both.
                const build = map.operational_surface.build.command.trim();
                const blockedMatch = (map.security_surface.bash_blocked_patterns ?? [])
                    .find((pattern) => pattern.trim().length > 0 && build.includes(pattern.trim()));
                if (build.length > 0 && blockedMatch !== undefined) {
                    return `covered but the declared build command is blocked by security policy: ${build} matches ${blockedMatch}`;
                }
            }
            {
                // A documented pull-request base has to appear in the recorded
                // branch policy, or the contribution-branch guard silently has
                // nothing to compare the default branch against.
                const documented = cwd ? documentedContributionBranch(cwd) : null;
                if (documented !== null) {
                    const recorded = [
                        map.operational_surface.git_workflow.main_branch.trim(),
                        ...(map.operational_surface.git_workflow.contribution_branches ?? [])
                            .map((branch) => branch.name.trim()),
                    ];
                    if (!recorded.includes(documented.branch)) {
                        return `covered but ${documented.path} documents pull requests against `
                            + `${documented.branch}, which the recorded branch policy omits`;
                    }
                }
            }
            {
                const workflow = map.operational_surface.git_workflow;
                if (!isBareGitRef(workflow.main_branch)) {
                    return `covered but git_workflow.main_branch is not a bare git ref name: ${workflow.main_branch.trim()}`;
                }
                const prose = (workflow.contribution_branches ?? [])
                    .filter((branch) => !isBareGitRef(branch.name))
                    .map((branch) => branch.name.trim());
                if (prose.length > 0) {
                    return `covered but contribution branch names are not bare git refs: ${prose.join(", ")}`;
                }
                const uncited = (workflow.contribution_branches ?? []).filter(({ evidence }) =>
                    !Number.isInteger(evidence.line_start)
                    || !Number.isInteger(evidence.line_end)
                    || evidence.line_start < 1
                    || evidence.line_end < evidence.line_start
                );
                if (uncited.length > 0) {
                    return "covered but a contribution branch cites no usable evidence line range: "
                        + uncited.map((branch) => branch.name).join(", ");
                }
            }
            return null;
        case "D8_security":
            if (!hasItems(map.security_surface.paths.zero_access)) {
                return "covered but zero-access security paths are empty";
            }
            if (!hasItems(map.security_surface.bash_blocked_patterns) && !hasItems(map.security_surface.damage_control_rules)) {
                return "covered but security damage-control evidence is empty";
            }
            {
                const unsafe = (map.security_surface.env_allowlist ?? [])
                    .filter((name) => EXECUTION_ALTERING_ENV.has(name.trim().toUpperCase()));
                if (unsafe.length > 0) {
                    return `covered but env_allowlist permits execution-altering variables: ${unsafe.join(", ")}`;
                }
            }
            if (
                map.coverage.D8_security.confidence === "high"
                && Object.values(map.security_surface.security_checklist).every((entry) => !hasItems(entry))
            ) {
                return "covered at high confidence but every security_checklist collection is empty; "
                    + "record security_surface.security_checklist or lower the confidence";
            }
            return null;
        case "D9_process":
            // A narrative that describes a review or documentation loop
            // contradicts a structured field saying there is none.
            if (
                !map.meta.lifecycle.review_loop.present
                && /\breview\b/i.test(map.meta.lifecycle.sdlc_model ?? "")
            ) {
                return "covered but lifecycle.review_loop.present is false while sdlc_model describes a review process";
            }
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

/** Excerpts shorter than this are labels rather than quotations. */
const MIN_VERIFIABLE_EXCERPT = 12;
const MAX_EXCERPT_SEARCH_BYTES = 2 * 1024 * 1024;

/**
 * Normalize for comparison. Case and whitespace are not what makes an excerpt
 * evidence; coming from the cited file is.
 */
function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function verifyCitationTarget(cwd: string, citation: EvidenceCitationLike): string | null {
    const { absolute, underRoot } = evidencePathUnderRoot(cwd, citation.path);
    if (!underRoot) {
        return `covered but evidence citation path escapes repository root: ${citation.path}`;
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
    // A citation whose excerpt is not in the file it names is not evidence.
    // Checking only that the path exists lets any real path support any claim.
    if (citation.kind === "positive" && exists) {
        const excerpt = collapseWhitespace(citation.excerpt);
        if (excerpt.length >= MIN_VERIFIABLE_EXCERPT) {
            let content: string;
            try {
                const stat = fs.lstatSync(absolute);
                if (!stat.isFile() || stat.size > MAX_EXCERPT_SEARCH_BYTES) return null;
                content = fs.readFileSync(absolute, "utf-8");
            } catch {
                return null;
            }
            if (!collapseWhitespace(content).includes(excerpt)) {
                return `covered but the evidence excerpt does not appear in ${citation.path}: "${citation.excerpt.slice(0, 80)}"`;
            }
        }
    }
    return null;
}

function assessEvidenceCitations(
    entry: { evidence?: readonly EvidenceCitationLike[] },
    dimension: CoverageDimension,
    cwd?: string,
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
            const failure = verifyCitationTarget(cwd, citation);
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
        const evidenceFailure = assessEvidenceCitations(entry, dimension, options?.cwd);
        if (evidenceFailure !== null) {
            unresolved.push(dimension);
            reasons[dimension] = evidenceFailure;
            continue;
        }
        const substanceFailure = assessDimensionSubstance(map, dimension, options?.cwd);
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
 * Repository-specialist discovery reads `expert_evidence.expert_domains` from
 * the canonical map. The audit is not complete until that structure has been
 * explicitly recorded: an honest empty `expert_domains` list is valid for a
 * repository with no cohesive recurring domain, but an absent field means the
 * model never considered specialists at all and discovery would silently
 * produce an empty portfolio.
 */
export function specialistEvidenceRecorded(map: CodebaseMap): boolean {
    return map.expert_evidence !== undefined;
}

export interface AuditCompletionResult {
    coverage: CoverageClosureResult;
    /** True once `expert_evidence` exists in the map, even when honestly empty. */
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
