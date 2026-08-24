import { Value } from "typebox/value";
import {
    CodebaseMapSchema,
    PartialCodebaseMapSchema,
    type CodebaseMap,
} from "./schema.ts";
import { isExecutableCommandText } from "../command-text.ts";

export type CompleteMapValidation =
    | { ok: true; value: CodebaseMap }
    | { ok: false; error: string };

export type PartialMapValidation =
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; error: string };

function describeTypeBoxNode(node: unknown): string {
    if (!node || typeof node !== "object") return "unknown";
    const n = node as {
        type?: string | string[];
        enum?: unknown[];
        const?: unknown;
        anyOf?: unknown[];
        oneOf?: unknown[];
        allOf?: unknown[];
        format?: string;
        minimum?: number;
        maximum?: number;
        minLength?: number;
        maxLength?: number;
        pattern?: string;
        required?: string[];
        properties?: Record<string, unknown>;
        items?: unknown;
    };
    if (n.enum && Array.isArray(n.enum)) return `one of ${JSON.stringify(n.enum)}`;
    if (n.const !== undefined) return `const ${JSON.stringify(n.const)}`;
    if (n.anyOf) return `anyOf [${n.anyOf.length} options]`;
    if (n.oneOf) return `oneOf [${n.oneOf.length} options]`;
    if (n.allOf) return `allOf [${n.allOf.length} options]`;
    if (n.type === "array") {
        const items = n.items ? describeTypeBoxNode(n.items) : "unknown";
        return `array of ${items}`;
    }
    if (n.type === "object") {
        if (n.properties) {
            const keys = Object.keys(n.properties);
            const req = n.required ?? [];
            const reqMark = (key: string) => (req.includes(key) ? "" : "?");
            return `object { ${keys.map((key) => `${key}${reqMark(key)}`).join(", ")} }`;
        }
        return "object";
    }
    if (n.type === "string" && n.format) return `string (format: ${n.format})`;
    if (n.type === "string" && n.pattern) return "string (pattern)";
    if (n.type === "string" && (n.minLength !== undefined || n.maxLength !== undefined)) {
        return `string (length ${n.minLength ?? 0}..${n.maxLength ?? "∞"})`;
    }
    if (n.type === "number" || n.type === "integer") {
        if (n.minimum !== undefined || n.maximum !== undefined) {
            return `${n.type} (range ${n.minimum ?? "-∞"}..${n.maximum ?? "∞"})`;
        }
        return n.type;
    }
    if (typeof n.type === "string") return n.type;
    if (Array.isArray(n.type)) return n.type.join(" | ");
    return "unknown";
}

function truncateForError(value: string, max = 80): string {
    return value.length > max ? value.slice(0, max) + "…" : value;
}

function formatValidationErrors(errors: ReadonlyArray<unknown>, prefix: string): string {
    const formatted = errors
        .slice(0, 10)
        .map((error) => {
            const errAny = error as {
                path?: string;
                instancePath?: string;
                schemaPath?: string;
                schema?: unknown;
                value?: unknown;
                message: string;
            };
            const errPath = errAny.path || errAny.instancePath || "(root)";
            const expected = errAny.schema ? describeTypeBoxNode(errAny.schema) : "unknown";
            const valueSnippet =
                errAny.value !== undefined
                    ? ` (got: ${truncateForError(JSON.stringify(errAny.value))})`
                    : "";
            return `  - ${errPath}: ${errAny.message}, expected ${expected}${valueSnippet}`;
        })
        .join("\n");
    const moreCount = errors.length > 10 ? ` (and ${errors.length - 10} more)` : "";
    return `${prefix} with ${errors.length} error(s)${moreCount}:\n${formatted}`;
}

function describeTopLevelShape(map: unknown): string {
    if (map === null || typeof map !== "object" || Array.isArray(map)) return "";
    const keys = Object.keys(map as Record<string, unknown>);
    const known = new Set(Object.keys(CodebaseMapSchema.properties));
    const unexpected = keys.filter((key) => !known.has(key));
    const missing = [...known].filter((key) =>
        (CodebaseMapSchema.required as string[] | undefined)?.includes(key) && !keys.includes(key)
    );
    const parts: string[] = [];
    if (unexpected.length > 0) parts.push(`unexpected top-level keys: ${unexpected.join(", ")}`);
    if (missing.length > 0) parts.push(`missing required top-level keys: ${missing.join(", ")}`);
    return parts.length > 0 ? ` Top-level shape: ${parts.join("; ")}.` : "";
}

/** Narrative fields where a model can confess to recording a value it knows is false. */
function describedTextFields(map: CodebaseMap): Array<readonly [string, string]> {
    const fields: Array<readonly [string, string]> = [
        ["meta.domain_hypothesis", map.meta.domain_hypothesis],
        ...Object.entries(map.coverage).map(([dimension, entry]) =>
            [`coverage.${dimension}.evidence_summary`, entry.evidence_summary] as const),
        ...map.open_questions.map((question, index) =>
            [`open_questions[${index}]`, question] as const),
    ];
    const sdlc = (map.meta.lifecycle as { sdlc_model?: unknown }).sdlc_model;
    if (typeof sdlc === "string") fields.push(["meta.lifecycle.sdlc_model", sdlc]);
    return fields.filter(([, text]) => typeof text === "string" && text.length > 0);
}

function identified(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 && normalized !== "unknown" && normalized !== "n/a";
}

function semanticValidationErrors(map: CodebaseMap): string[] {
    const allCoverageClosed = Object.values(map.coverage).every((entry) => entry.status === "covered");
    if (!allCoverageClosed) return [];
    const errors: string[] = [];
    const projectType = map.meta.project_type.trim().toLowerCase();
    if ((projectType === "" || projectType === "unknown") && map.skeleton.entry_points.length > 0) {
        errors.push("meta.project_type is unknown despite recorded entry points");
    }
    if (
        map.meta.languages.length === 0
        && map.skeleton.entry_points.some((entry) => entry.language.trim().toLowerCase() !== "unknown")
    ) {
        errors.push("meta.languages is empty despite entry points with identified languages");
    }
    const readme = map.meta.documentation.readme_metrics;
    if (readme.present && readme.section_count > 0 && readme.line_count <= 0) {
        errors.push("README metrics record sections but no lines");
    }
    if (
        map.meta.documentation.changelog_present === false
        && map.skeleton.top_level_tree.some((entry) => /^changelog(?:\.[^/]+)?\/?$/i.test(entry))
    ) {
        errors.push("documentation says no changelog while the top-level tree contains one");
    }
    if (map.meta.lifecycle.review_loop.present && map.meta.lifecycle.review_loop.kind === "none") {
        errors.push("review_loop is present but its kind is none");
    }
    if (map.meta.lifecycle.documentation_loop.present && map.meta.lifecycle.documentation_loop.kind === "none") {
        errors.push("documentation_loop is present but its kind is none");
    }
    const generatedPath = (value: string): boolean =>
        /^(?:\.agentify|\.github\/agentify)(?:\/|$)/.test(value.replaceAll("\\", "/"));
    if (map.skeleton.top_level_tree.some(generatedPath)) {
        errors.push("audit topography contains Agentify-generated control paths");
    }
    const generatedEvidence = Object.entries(map.coverage).flatMap(([dimension, entry]) =>
        (entry.evidence ?? [])
            .filter((citation) => generatedPath(citation.path))
            .map((citation) => `${dimension}:${citation.path}`)
    );
    if (generatedEvidence.length > 0) {
        errors.push(`coverage cites Agentify-generated control paths: ${generatedEvidence.join(", ")}`);
    }
    if (map.open_questions.length > 0) {
        errors.push(
            "coverage is closed while questions remain open: "
            + map.open_questions.map((question) => `"${question.slice(0, 80)}"`).join(", "),
        );
    }

    // An evidence summary written as an instruction to the audit is scratchpad
    // content, not a finding about the repository.
    const scratchpad = /^\s*(?:try|set|record|fix|populate|add|next|todo|re-?run|note to self)\b/i;
    for (const [dimension, entry] of Object.entries(map.coverage)) {
        if (scratchpad.test(entry.evidence_summary)) {
            errors.push(
                `coverage.${dimension}.evidence_summary is an audit instruction rather than a finding: `
                + `"${entry.evidence_summary.slice(0, 80)}"`,
            );
        }
    }

    const hasEntryPoints = map.skeleton.entry_points.length > 0;
    if (hasEntryPoints && !identified(map.meta.domain_hypothesis)) {
        errors.push("meta.domain_hypothesis is unknown despite recorded entry points");
    }
    if (hasEntryPoints && !identified(map.skeleton.app_vs_agentic_layer.app_layer)) {
        errors.push("skeleton.app_vs_agentic_layer.app_layer is unknown despite recorded entry points");
    }
    if (hasEntryPoints && map.conventions.file_size.observed_avg <= 0) {
        errors.push("conventions.file_size.observed_avg is zero despite recorded source files");
    }
    if (hasEntryPoints && map.conventions.file_size.observed_max <= 0) {
        errors.push("conventions.file_size.observed_max is zero despite recorded source files");
    }
    if (
        isExecutableCommandText(map.validation_surface.test_command)
        && map.validation_surface.test_runtime_seconds_estimate <= 0
    ) {
        errors.push("validation_surface records a test command with a zero runtime estimate");
    }

    // A command field that cannot be executed is prose, not a command.
    for (const [label, command] of [
        ["operational_surface.build.command", map.operational_surface.build.command],
        ["operational_surface.run.command", map.operational_surface.run.command],
        ...map.skeleton.entry_points.map((entry, index) =>
            [`skeleton.entry_points[${index}].run_command`, entry.run_command] as const),
    ] as ReadonlyArray<readonly [string, string]>) {
        if (command.trim().length > 0 && !isExecutableCommandText(command)) {
            errors.push(`${label} holds prose rather than an executable command: ${command.trim()}`);
        }
    }

    // A subtree cannot be worked in parallel with a module it depends on.
    const dependencyPairs = new Set(map.module_graph.edges.flatMap((edge) => [
        `${edge.from}\u0000${edge.to}`,
        `${edge.to}\u0000${edge.from}`,
    ]));
    for (const group of map.module_graph.parallelizable_subtrees) {
        for (const left of group) {
            for (const right of group) {
                if (left !== right && dependencyPairs.has(`${left}\u0000${right}`)) {
                    errors.push(
                        `module_graph marks ${left} and ${right} parallelizable while recording a dependency between them`,
                    );
                }
            }
        }
    }

    // A pitfall with no line reference is an unproven whole-module hypothesis.
    const unreferencedPitfalls = map.pitfalls
        .filter((pitfall) => !Number.isInteger(pitfall.line_ref) || pitfall.line_ref < 1)
        .map((pitfall) => pitfall.module);
    if (unreferencedPitfalls.length > 0) {
        errors.push(`pitfalls carry no line reference: ${[...new Set(unreferencedPitfalls)].join(", ")}`);
    }

    // A generated field that admits it is false is never acceptable output.
    const schemaExcuse = /\bto satisfy (?:the )?schema\b|\bschema[- ]allowed enum\b|\bplaceholder value\b/i;
    for (const [label, text] of describedTextFields(map)) {
        if (schemaExcuse.test(text)) {
            errors.push(
                `${label} records a value the audit admits is false to satisfy the schema; record "unknown" instead`,
            );
        }
    }

    for (const expert of map.expert_evidence?.expert_domains ?? []) {
        if (!Number.isFinite(Date.parse(expert.last_updated))) {
            errors.push(`expert domain ${expert.domain} records an unparsable last_updated timestamp`);
        }
        const badRanges = expert.key_files.filter(({ line_range: [start, end] }) =>
            !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start
        );
        if (badRanges.length > 0) {
            errors.push(
                `expert domain ${expert.domain} records key files without a usable line range: `
                + badRanges.map((file) => file.path).join(", "),
            );
        }
    }
    return errors;
}

export function validateMap(map: unknown): CompleteMapValidation {
    const errors = Value.Errors(CodebaseMapSchema, map);
    if (errors.length === 0) {
        const value = map as CodebaseMap;
        const semanticErrors = semanticValidationErrors(value);
        if (semanticErrors.length === 0) return { ok: true, value };
        return {
            ok: false,
            error: `Semantic validation failed with ${semanticErrors.length} error(s):\n`
                + semanticErrors.map((error) => `  - ${error}`).join("\n"),
        };
    }
    return {
        ok: false,
        error: formatValidationErrors(errors, "Schema validation failed") + describeTopLevelShape(map),
    };
}

export function validatePartialMap(map: unknown): PartialMapValidation {
    const errors = Value.Errors(PartialCodebaseMapSchema, map);
    if (errors.length === 0) {
        return { ok: true, value: map as Record<string, unknown> };
    }
    return {
        ok: false,
        error: formatValidationErrors(errors, "Partial schema validation failed"),
    };
}
