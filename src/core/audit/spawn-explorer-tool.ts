// spawn-explorer-tool.ts
//
// Custom tool that spawns a fresh, stateless in-process sub-agent
// to perform a single dimension-shaped exploration of the codebase.
// The sub-agent runs in the same Node.js process as the parent, so
// the parent's Pi auth is reused (no subprocess, no auth forwarding).
// The sub-agent has a fresh message history, a different system
// prompt (one of the explorers/*.md files), and a narrow tool list.
//
// The sub-agent is created via createAgentSession() from the SDK
// with a custom DefaultResourceLoader that:
//   - replaces the system prompt with the dimension-specific prompt,
//   - skips project context files (AGENTS.md, CLAUDE.md, etc.),
//   - skips project extensions, skills, prompt templates, themes,
// so the sub-agent starts from a clean slate.
//
// After the sub-agent finishes, we extract the last assistant
// message's text and return it to the parent builder as the
// structured report. The parent merges the report's fields into the
// codebase_map.
//
// MODES (dimension-shaped, all stateless, all read-only):
//   - topography    — whole-codebase orientation
//   - module_graph  — import graph, client/server split, shared state
//   - type_tracer   — trace a specific type end-to-end
//   - conventions   — read sibling files, induce naming/logging/etc.
//   - operational   — build/run/deploy, env vars, ports, shutdown
//   - security      — path/command/env classifications, damage-control
//   - pitfalls      — git-log-driven risk discovery
//   - validation    — test/lint/typecheck commands + per-change-type
//   - gap_filler    — close an uncovered D1-D10 dimension (fallback mode)
//   - concern_scout — sweep the repository for its actual specialties
//   - concern_tracer— trace one named concern end to end
//   - custom        — system prompt composed by the parent;
//                     one per topic/specialization, bounded by the audit
//                     dispatch budget.
//
// Custom exploration accepts a self-contained inline prompt. Sub-agent
// dispatch is bounded by total/concurrent/time
// budgets so a bad audit cannot spawn unbounded work.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    createAgentSession,
    DefaultResourceLoader,
    defineTool,
    type AgentSessionEvent,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { AuditResourceBudget } from "./resource-budget.ts";
import { currentRepositoryCommit } from "./explorer-receipts.ts";
import { loadCanonicalMapAt } from "./map-storage.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { capProviderOutputTokens, forceProviderToolChoice } from "../pi-sdk-runtime.ts";
import { ConcernSchema, type Concern } from "./schema/concerns.ts";
import { assessSpecialistEvidence } from "./specialist-completion.ts";
import { getThinkingLevel } from "./state.ts";
import { makeDefenseHook } from "./defense-hook.ts";
import {
    createReadOnlyExecutionPolicy,
    READ_ONLY_TOOLS,
} from "../security/execution-policy.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPLORERS_DIR = path.join(HERE, "prompts", "explorers");

// A 32 KB report cap is enough
// for a structured ## Report; anything larger is truncated to
// prevent context overflow.
const MAX_REPORT_BYTES = 16_000;
// A repository audit must finish in a useful amount of time even when a
// provider stalls. These are deliberately conservative defaults: the parent
// can synthesize from its own scouts and honest gaps after bounded attempts.
const DEFAULT_MAX_TOTAL_SPAWNS = 16;
const DEFAULT_MAX_CONCURRENT_SPAWNS = 1;
// Large repository feature subtrees can require several model turns even with
// the explorer's read-only tool budget. Keep the timeout bounded, but leave
// enough room for a useful structured report rather than repeated retries.
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_MAX_TOTAL_COST_USD = 5;
const MAX_EXPLORER_READS = 32;
const MAX_EXPLORER_PROVIDER_CALLS = 40;
const MAX_CONCERN_RESPONSE_TOKENS = 12_000;

// The 9 dimension-shaped modes, the two concern modes that find and trace what
// this repository's specialties actually are, plus a custom mode that takes an
// inline system prompt composed by the builder.
const ExplorerMode = StringEnum(
    [
        "topography",
        "module_graph",
        "type_tracer",
        "conventions",
        "operational",
        "security",
        "pitfalls",
        "validation",
        "gap_filler",
        "concern_scout",
        "concern_tracer",
        "custom",
    ] as const,
    { default: "topography" },
);

const MODE_TO_FILE: Record<string, string> = {
    topography: "topography.md",
    module_graph: "module_graph.md",
    type_tracer: "type_tracer.md",
    conventions: "conventions.md",
    operational: "operational.md",
    security: "security.md",
    pitfalls: "pitfalls.md",
    validation: "validation.md",
    gap_filler: "gap_filler.md",
    concern_scout: "concern_scout.md",
    concern_tracer: "concern_tracer.md",
};

/** Per-mode step caps. */
const MODE_STEP_DEFAULTS: Record<string, { reads: number; bash: number; steps: number }> = {
    topography: { reads: 8, bash: 0, steps: 12 },
    module_graph: { reads: 10, bash: 0, steps: 15 },
    type_tracer: { reads: 8, bash: 0, steps: 12 },
    conventions: { reads: 7, bash: 0, steps: 10 },
    operational: { reads: 10, bash: 0, steps: 15 },
    security: { reads: 10, bash: 0, steps: 15 },
    pitfalls: { reads: 5, bash: 0, steps: 10 },
    validation: { reads: 10, bash: 0, steps: 15 },
    gap_filler: { reads: 8, bash: 0, steps: 12 },
    // Concern modes receive enough reads to verify behavior across source,
    // tests, and public surfaces, but must summarize instead of repeatedly
    // re-ingesting the repository.
    concern_scout: { reads: 10, bash: 0, steps: 14 },
    concern_tracer: { reads: 6, bash: 0, steps: 8 },
    // The builder specifies custom exploration limits per call.
    custom: { reads: 8, bash: 0, steps: 12 },
};

const SpawnExplorerParams = Type.Object({
    mode: Type.Optional(ExplorerMode),
    target_path: Type.String({
        description:
            "Directory to explore. Absolute path or cwd-relative path. " +
            "The resolved path must remain inside ctx.cwd; external paths are always rejected.",
    }),
    focus: Type.Optional(
        Type.String({
            description:
                "Optional focus. Semantics depend on mode: for type_tracer, the type name to trace; for gap_filler, the dimension (e.g., 'D5_pitfalls'); for others, a one-sentence hint.",
        }),
    ),
    concern: Type.Optional(
        Type.String({
            minLength: 1,
            description:
                "Required for concern_tracer: the exact application-bound concern identity. " +
                "The submitted report must use this name verbatim.",
        }),
    ),
    summary: Type.Optional(
        Type.String({
            description:
                "One-line focus summary passed to the sub-agent as context. " +
                "Useful for steering the sub-agent's exploration toward a specific aspect.",
        }),
    ),
    max_reads: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: MAX_EXPLORER_READS,
            description: `Optionally narrow the trusted per-mode repository-read cap (1-${MAX_EXPLORER_READS}); values above the mode default do not raise it.`,
        }),
    ),
    max_total_steps: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: MAX_EXPLORER_PROVIDER_CALLS,
            description: `Optionally narrow the trusted hard provider-call cap (1-${MAX_EXPLORER_PROVIDER_CALLS}); values above the mode default do not raise it.`,
        }),
    ),
    // Custom mode accepts a self-contained inline prompt from the parent.
    system_prompt: Type.Optional(
        Type.String({
            description:
                "Self-contained inline system prompt for a custom read-only explorer. " +
                "Compose it from repository evidence already gathered by the parent; " +
                "it must include every instruction the explorer needs and must not " +
                "depend on package-internal templates. Required for `custom` mode.",
        }),
    ),
    tools: Type.Optional(
        Type.Array(Type.String(), {
            description:
                "Optional read-only tool subset. Allowed values are read, grep, find, and ls; shell and mutation tools are rejected.",
        }),
    ),
});

let activeSpawnCount = 0;

interface BudgetRecovery {
    can_continue: boolean;
    actions: ReadonlyArray<string>;
    state_files: ReadonlyArray<string>;
}

/**
 * State-dir-aware budget recovery block. Constructed per tool
 * instance so the LLM-facing recovery text describes the active
 * state dir rather than assuming a literal path.
 */
function buildBudgetRecovery(stateDir: string): BudgetRecovery {
    return {
        can_continue: true,
        actions: [
            `Read ${stateDir}/codebase_map.json and the latest run log before dispatching any more explorers.`,
            "Reuse completed sub-agent reports and call write_map or write_map_delta with the strongest evidence already gathered.",
            "Narrow any remaining target_path/focus before retrying only if a budget remains.",
            "For genuinely unobservable gaps, record an honest null/open_question rather than inventing coverage.",
        ],
        state_files: [
            `${stateDir}/codebase_map.json`,
            `${stateDir}/logs/*.jsonl`,
            `${stateDir}/logs/*-spawn-*-report.txt`,
        ],
    };
}

function budgetRecoveryText(stateDir: string): string {
    return (
        `Resume path: read ${stateDir}/codebase_map.json and the latest run log, ` +
        "reuse completed sub-agent reports, persist the best known state with write_map/write_map_delta, " +
        "and use honest null/open_question entries for genuinely unobservable gaps."
    );
}

function makeBudgetError(text: string, budget: Record<string, number>, stateDir: string): {
    content: Array<{ type: "text"; text: string }>;
    isError: true;
    details: { budget: Record<string, number>; resume: ReturnType<typeof buildBudgetRecovery> };
} {
    return {
        content: [{ type: "text", text: `${text}\n\n${budgetRecoveryText(stateDir)}` }],
        isError: true,
        details: { budget, resume: buildBudgetRecovery(stateDir) },
    };
}

/**
 * Top-level entries present on disk but absent from the git tree at HEAD.
 *
 * Specialist evidence is bound to git blobs at the supporting commit, so a
 * concern traced through fetched, generated, or vendored code can never
 * survive materialization: every touchpoint is dropped and the portfolio comes
 * back empty with no explanation. Rather than let an explorer spend its whole
 * budget somewhere the evidence rules will silently reject, tell it up front
 * which roots are not part of the repository.
 *
 * Best-effort by design. A repository without git, or a git invocation that
 * fails, yields no constraint rather than a blocked audit.
 */
function untrackedTopLevelRoots(cwd: string): string[] {
    const result = spawnSync("git", ["-C", cwd, "ls-tree", "--name-only", "-z", "HEAD"], {
        encoding: "utf-8",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    const tracked = new Set(result.stdout.split("\0").filter(Boolean));
    if (tracked.size === 0) return [];
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(cwd, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.name !== ".git" && !tracked.has(entry.name))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort((left, right) => left.localeCompare(right));
}

const UNTRACKED_NOTE_PLACEHOLDER = /<untrackedPathsNote>/g;

function untrackedPathsNote(cwd: string): string {
    const roots = untrackedTopLevelRoots(cwd);
    if (roots.length === 0) {
        return "## Untracked paths\n\n"
            + "Every top-level entry in this repository is tracked in git. Cite any path "
            + "you actually observed.";
    }
    return "## Untracked paths\n\n"
        + "These top-level entries exist on disk but are **not tracked in git**. They are "
        + "fetched, generated, or vendored — they are not part of this repository, and a "
        + "specialist cannot be grounded in them:\n\n"
        + roots.map((root) => `- \`${root}\``).join("\n")
        + "\n\nDo not cite any path under them. If the repository's real work happens "
        + "through one of these — a vendored harness, a fetched toolchain — describe how "
        + "the *tracked* code invokes and configures it, and make those tracked files your "
        + "touchpoints instead.";
}

function resolveExplorerPromptPath(mode: string): string {
    const file = MODE_TO_FILE[mode];
    if (!file) {
        throw new Error(
            `Unknown explorer mode: "${mode}". Valid modes: ${Object.keys(MODE_TO_FILE).join(", ")}`,
        );
    }
    return path.join(EXPLORERS_DIR, file);
}

function readSubagentPrompt(mode: string, stateDir: string, cwd: string): string {
    const promptPath = resolveExplorerPromptPath(mode);
    return fs
        .readFileSync(promptPath, "utf-8")
        .replace(/<stateDir>/g, stateDir)
        .replace(UNTRACKED_NOTE_PLACEHOLDER, () => untrackedPathsNote(cwd));
}

/**
 * Resolve the system prompt for a sub-agent.
 *
 * For fixed modes (topography, module_graph, etc.), the prompt is
 * loaded from the explorer files in `prompts/explorers/`.
 *
 * For `custom` mode, the parent passes a self-contained inline prompt based on
 * gathered repository evidence.
 */
function resolveSubagentPrompt(
    mode: string,
    inlinePrompt: string | undefined,
    stateDir: string,
    cwd: string,
): { prompt: string; source: "inline" | "fixed" } {
    if (mode === "custom") {
        if (inlinePrompt) {
            return {
                prompt: inlinePrompt
                    .replace(/<stateDir>/g, stateDir)
                    .replace(UNTRACKED_NOTE_PLACEHOLDER, () => untrackedPathsNote(cwd)),
                source: "inline",
            };
        }
        throw new Error("custom mode requires a self-contained system_prompt based on repository evidence.");
    }
    // Fixed mode: load from disk.
    return { prompt: readSubagentPrompt(mode, stateDir, cwd), source: "fixed" };
}

function extractFinalAssistantText(
    messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): string {
    // Walk backwards to find the last assistant message with text content.
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.role !== "assistant") continue;
        const content = m.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            const textParts: string[] = [];
            for (const block of content) {
                if (
                    block &&
                    typeof block === "object" &&
                    "type" in block &&
                    (block as { type?: string }).type === "text" &&
                    "text" in block &&
                    typeof (block as { text?: unknown }).text === "string"
                ) {
                    textParts.push((block as { text: string }).text);
                }
            }
            if (textParts.length > 0) return textParts.join("");
        }
    }
    return "(no report — sub-agent did not produce text)";
}

function currentRepositoryTimestamp(cwd: string): string | null {
    const result = spawnSync("git", ["-C", cwd, "show", "-s", "--format=%cI", "HEAD"], {
        encoding: "utf8",
        windowsHide: true,
    });
    const timestamp = result.status === 0 ? result.stdout.trim() : "";
    return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function decodeStructuredConcernObject(
    parsed: unknown,
    observedAt: string,
): { concern: Concern | null; error: string | null } {
    if (!isRecord(parsed)) return { concern: null, error: "concern_tracer JSON report is not an object" };
    const blocker = typeof parsed.blocker_reason === "string" ? parsed.blocker_reason.trim() : "";
    if (blocker) return { concern: null, error: `concern_tracer reported blocker: ${blocker}` };
    const { adjacent_concerns: _adjacent, blocker_reason: _blocker, last_updated: _lastUpdated, ...fields } = parsed;
    const touchpoints = Array.isArray(fields.touchpoints) ? fields.touchpoints : [];
    const spansSubtrees = [...new Set(touchpoints.flatMap((touchpoint) => {
        if (!isRecord(touchpoint) || typeof touchpoint.path !== "string") return [];
        return [touchpoint.path.includes("/") ? touchpoint.path.split("/", 1)[0] : "."];
    }))].sort();
    const concern = { ...fields, spans_subtrees: spansSubtrees, last_updated: observedAt };
    if (!Value.Check(ConcernSchema, concern)) {
        const first = [...Value.Errors(ConcernSchema, concern)][0] as {
            instancePath?: string;
            message?: string;
        } | undefined;
        return {
            concern: null,
            error: `concern_tracer JSON report failed schema validation at ${first?.instancePath || "/"}: ${first?.message ?? "invalid concern"}`,
        };
    }
    return { concern: concern as Concern, error: null };
}

function decodeStructuredConcernReport(
    report: string,
    observedAt: string,
): { concern: Concern | null; error: string | null } {
    const fenced = report.match(/```json\s*([\s\S]*?)```/iu)?.[1];
    if (!fenced) return { concern: null, error: "concern_tracer did not return a fenced JSON report" };
    try {
        return decodeStructuredConcernObject(JSON.parse(fenced), observedAt);
    } catch {
        return { concern: null, error: "concern_tracer returned malformed JSON" };
    }
}

export function parseStructuredConcernReport(report: string, observedAt: string): Concern | null {
    return decodeStructuredConcernReport(report, observedAt).concern;
}

function normalizeSubmittedEvidencePaths(value: unknown, repositoryRoot: string | undefined): unknown {
    if (!repositoryRoot || !isRecord(value)) return value;
    const normalize = (candidate: unknown): unknown => {
        if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return candidate;
        const relative = path.relative(repositoryRoot, candidate);
        return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
            ? relative.split(path.sep).join("/")
            : candidate;
    };
    const mapPath = (candidate: unknown, key: "path" | "reference"): unknown =>
        isRecord(candidate) ? { ...candidate, [key]: normalize(candidate[key]) } : candidate;
    const touchpoints = Array.isArray(value.touchpoints)
        ? value.touchpoints.map((touchpoint) => mapPath(touchpoint, "path"))
        : value.touchpoints;
    const flows = Array.isArray(value.flows)
        ? value.flows.map((flow) => isRecord(flow) && Array.isArray(flow.steps)
            ? { ...flow, steps: flow.steps.map((step) => mapPath(step, "path")) }
            : flow)
        : value.flows;
    const evidencePaths = [
        ...(Array.isArray(touchpoints) ? touchpoints : []),
        ...(Array.isArray(flows) ? flows.flatMap((flow) => isRecord(flow) && Array.isArray(flow.steps) ? flow.steps : []) : []),
    ].flatMap((candidate) => isRecord(candidate) && typeof candidate.path === "string" ? [candidate.path] : [])
        .sort((left, right) => right.length - left.length);
    const mapReference = (candidate: unknown): unknown => {
        if (!isRecord(candidate)) return candidate;
        const normalized = normalize(candidate.reference);
        const reference = typeof normalized === "string"
            ? evidencePaths.find((evidencePath) => normalized.startsWith(`${evidencePath} `)) ?? normalized
            : normalized;
        return { ...candidate, reference };
    };
    return {
        ...value,
        touchpoints,
        flows,
        invariants: Array.isArray(value.invariants)
            ? value.invariants.map(mapReference)
            : value.invariants,
        pitfalls: Array.isArray(value.pitfalls)
            ? value.pitfalls.map(mapReference)
            : value.pitfalls,
    };
}

export function shouldForceConcernSubmission(
    providerCalls: number,
    maxProviderCalls: number,
    repositoryReadCalls: number,
    maxReads: number,
): boolean {
    return repositoryReadCalls >= maxReads || providerCalls >= Math.max(0, maxProviderCalls - 2);
}

export function activeExplorerToolsAfterRead(
    mode: string,
    repositoryReadCalls: number,
    maxReads: number,
    activeTools: ReadonlyArray<string>,
): string[] {
    return mode === "concern_tracer" && repositoryReadCalls >= maxReads
        ? ["submit_concern_report"]
        : [...activeTools];
}

export function concernSubmissionSteerMessage(
    mode: string,
    repositoryReadCalls: number,
    maxReads: number,
): string | null {
    return mode === "concern_tracer" && repositoryReadCalls === maxReads
        ? "Repository evidence collection is complete. Call submit_concern_report now; do not request another repository tool."
        : null;
}

const ConcernSubmissionSchema = Type.Object({
    report_json: Type.String({
        minLength: 2,
        maxLength: 32_768,
        description:
            "Compact JSON object containing the complete concern body. Do not use a markdown fence. " +
            "Omit last_updated; spans_subtrees is optional. Target 8 KB; Agentify rejects canonical reports above 16 KB.",
    }),
}, { additionalProperties: false });

export function createConcernSubmissionTool(
    observedAt: string,
    onSubmit: (concern: Concern) => void,
    repositoryRoot?: string,
    expectedConcern?: string,
): ToolDefinition {
    return defineTool({
        name: "submit_concern_report",
        label: "Submit concern report",
        description:
            "Submit the complete evidence-backed concern as compact JSON. Agentify parses and validates the body, " +
            "derives subtree reach from touchpoints, and binds freshness to the repository commit.",
        parameters: ConcernSubmissionSchema,
        async execute(_id, params) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(params.report_json);
            } catch {
                return {
                    content: [{ type: "text", text: "Error: report_json is not valid JSON; resubmit one compact JSON object." }],
                    isError: true,
                    details: { recorded: false, concern: null },
                };
            }
            const decoded = decodeStructuredConcernObject(
                normalizeSubmittedEvidencePaths(parsed, repositoryRoot),
                observedAt,
            );
            if (!decoded.concern) {
                return {
                    content: [{ type: "text", text: `Error: ${decoded.error ?? "invalid concern report"}` }],
                    isError: true,
                    details: { recorded: false, concern: null },
                };
            }
            if (expectedConcern !== undefined && decoded.concern.concern !== expectedConcern) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: concern must exactly match the application-bound identity ${JSON.stringify(expectedConcern)}; resubmit without renaming it.`,
                    }],
                    isError: true,
                    details: { recorded: false, concern: null },
                };
            }
            const canonicalReport = `## Report\n\`\`\`json\n${JSON.stringify(decoded.concern, null, 2)}\n\`\`\``;
            if (Buffer.byteLength(canonicalReport, "utf8") > MAX_REPORT_BYTES) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: validated concern exceeds ${MAX_REPORT_BYTES} bytes; remove redundant evidence and resubmit concisely.`,
                    }],
                    isError: true,
                    details: { recorded: false, concern: null },
                };
            }
            onSubmit(decoded.concern);
            return {
                content: [{ type: "text", text: "Typed concern report recorded. Stop now." }],
                details: { recorded: true, concern: decoded.concern.concern as string | null },
            };
        },
    });
}

function truncateReport(report: string): { report: string; truncated: boolean; report_length: number } {
    if (report.length <= MAX_REPORT_BYTES) {
        return { report, truncated: false, report_length: report.length };
    }
    const omitted = report.length - MAX_REPORT_BYTES;
    return {
        report:
            report.slice(0, MAX_REPORT_BYTES) +
            `\n\n[TRUNCATED: ${omitted} bytes omitted; see log for full report]`,
        truncated: true,
        report_length: report.length,
    };
}

function persistTruncatedReport(
    cwd: string,
    mode: string,
    runId: string,
    fullReport: string,
    stateDir: string,
): string {
    try {
        const logDir = path.join(cwd, stateDir, "logs");
        fs.mkdirSync(logDir, { recursive: true });
        const safeRunId = runId.replace(/[^a-zA-Z0-9-]/g, "-");
        const filePath = path.join(logDir, `${safeRunId}-spawn-${mode}-report.txt`);
        fs.writeFileSync(filePath, fullReport, { mode: 0o644 });
        return filePath;
    } catch {
        return "";
    }
}

function resolveTargetPath(target: string, cwd: string): string {
    if (path.isAbsolute(target)) return path.normalize(target);
    return path.normalize(path.join(cwd, target));
}

function isPathInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function sha256(s: string): string {
    // Use a tiny inline hash — we don't need crypto-grade, just stable.
    // Avoiding import of node:crypto keeps the file light.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

function buildRunId(): string {
    return `spawn-${Date.now()}-${sha256(os.tmpdir() + process.pid + Math.random().toString())}`;
}

export interface ExplorerSubSession {
    dispose: () => void;
    prompt: (text: string) => Promise<void>;
    messages: unknown[];
    subscribe?: (listener: (event: unknown) => void) => () => void;
    clearQueue?: () => unknown;
    abort?: () => Promise<void>;
}

export type CreateExplorerSession = (
    options: Parameters<typeof createAgentSession>[0],
) => Promise<{ session: ExplorerSubSession }>;

export interface SpawnExplorerToolOptions {
    agentDir: string;
    /**
     * Audit state dir relative to the repo root, without a trailing slash. Used as the
     * destination for sub-agent logs and as the source of truth for
     * budget-recovery messages.
     */
    stateDir: string;
    /**
     * Resolved model to use for explorer sub-agents. Computed by the
     * caller via `selectModelForRole(registry, config, "explorer")`.
     * This is the model passed to `createSession` for every mode.
     */
    explorerModel: Model<Api>;
    /** Hard cap for total sub-agents spawned by this tool instance. */
    maxTotalSpawns?: number;
    /** Hard cap for concurrently running sub-agents across tool instances. */
    maxConcurrentSpawns?: number;
    /** Wall-clock timeout for a single sub-agent prompt. */
    maxSubagentDurationMs?: number;
    /** Hard cap for cumulative provider-reported sub-agent cost. Pass null to disable. */
    maxTotalCostUsd?: number | null;
    /** Aggregate budget shared across every parent audit/repair session. */
    resourceBudget?: AuditResourceBudget;
    /** Test seam for running a fake sub-agent without contacting a model provider. */
    createSession?: CreateExplorerSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function roundCost(costUsd: number): number {
    return Number(costUsd.toFixed(12));
}

function successfulCurrentHeadScouts(cwd: string, stateDir: string) {
    const map = loadCanonicalMapAt(cwd, stateDir);
    const currentCommit = currentRepositoryCommit(cwd);
    return currentCommit !== null
        && map?.explorer_receipts?.repository_commit === currentCommit
        ? map.explorer_receipts.receipts.filter((receipt) =>
            receipt.mode === "concern_scout" && receipt.success
        )
        : [];
}

function supplementalScoutMatchesUncoveredCluster(
    cwd: string,
    stateDir: string,
    focus: string | undefined,
): boolean {
    const normalizedFocus = focus?.trim().toLowerCase() ?? "";
    if (!normalizedFocus) return false;
    const map = loadCanonicalMapAt(cwd, stateDir);
    if (map === null) return false;
    const scouts = successfulCurrentHeadScouts(cwd, stateDir);
    const uncovered = assessSpecialistEvidence(map, { cwd }).uncovered_clusters;
    return uncovered.some((cluster) => {
        const terms = [cluster.cluster_key, ...cluster.implementation_paths, ...cluster.test_paths]
            .map((term) => term.trim().toLowerCase())
            .filter((term) => term.length >= 4);
        const matched = terms.filter((term) => normalizedFocus.includes(term));
        return matched.length > 0 && !scouts.some((scout) => {
            const priorFocus = scout.focus?.trim().toLowerCase() ?? "";
            return matched.some((term) => priorFocus.includes(term));
        });
    });
}

function extractSessionCostUsd(messages: ReadonlyArray<unknown>): number | null {
    let total = 0;
    let found = false;
    for (const message of messages) {
        if (!isRecord(message)) continue;
        const usage = message.usage;
        if (!isRecord(usage)) continue;
        const cost = usage.cost;
        const totalCost = isRecord(cost) ? cost.total : cost;
        if (typeof totalCost !== "number" || !Number.isFinite(totalCost) || totalCost < 0) {
            continue;
        }
        total += totalCost;
        found = true;
    }
    return found ? roundCost(total) : null;
}

export function createSpawnExplorerTool(toolOptions: SpawnExplorerToolOptions): ToolDefinition {
    const maxTotalSpawns = toolOptions.maxTotalSpawns ?? DEFAULT_MAX_TOTAL_SPAWNS;
    const maxConcurrentSpawns = toolOptions.maxConcurrentSpawns ?? DEFAULT_MAX_CONCURRENT_SPAWNS;
    const maxSubagentDurationMs = toolOptions.maxSubagentDurationMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    const maxTotalCostUsd = toolOptions.maxTotalCostUsd ?? DEFAULT_MAX_TOTAL_COST_USD;
    const { stateDir } = toolOptions;
    const createSession: CreateExplorerSession = toolOptions.createSession ?? (async (sessionOptions) => {
        const { session } = await createAgentSession(sessionOptions);
        return { session: session as unknown as ExplorerSubSession };
    });
    let totalSpawnCount = 0;
    let totalCostUsd = 0;

    return defineTool({
    name: "spawn_explorer",
    label: "Spawn Explorer",
    description:
        "Spawn a fresh, stateless in-process sub-agent to perform a single bounded exploration. " +
        "The sub-agent does not inherit your context. Returns a structured ## Report tailored to the mode. " +
        "There are 12 modes. The first 9 are dimension-shaped fixed modes: " +
        "topography (whole-codebase orientation), module_graph (imports/split/shared state), " +
        "type_tracer (trace a type end-to-end; pass type name in focus), conventions (induce naming/logging/etc.), " +
        "operational (build/run/deploy/env/ports), security (path/command/env classifications), " +
        "pitfalls (git-log + grep for tribal knowledge), validation (test/lint/typecheck commands), " +
        "gap_filler (close an uncovered D1-D10 dimension; pass dimension in focus). " +
        "Two concern modes discover (`concern_scout`) and trace (`concern_tracer`) maintainer-recognizable specialties. " +
        "A successful application-attested concern_scout on current HEAD blocks duplicate broad scouting; " +
        "one focused supplemental scout is allowed only for a named compiler-uncovered cluster. " +
        "The final mode is `custom`: the parent supplies self-contained read-only " +
        "instructions based on gathered repository evidence through `system_prompt`. " +
        `Hard dispatch budgets: max ${maxTotalSpawns} total sub-agents per audit, ` +
        `max ${maxConcurrentSpawns} concurrent sub-agents, and max ${maxSubagentDurationMs}ms ` +
        "wall-clock time per sub-agent" +
        (maxTotalCostUsd === null ? "" : `, plus max $${maxTotalCostUsd.toFixed(2)} provider-reported sub-agent cost`) +
        ". Dispatch as many as the topic decomposition needs within those bounds. " +
        "Default mode: topography. Reports exceeding 16 KB fail closed and cannot establish " +
        "an explorer receipt. target_path is permanently domain-locked to ctx.cwd. " +
        "Use `summary` for a one-line focus hint passed as " +
        "additional context.",
    parameters: SpawnExplorerParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
        const mode = params.mode ?? "topography";

        // Validate the target-path domain lock.
        const resolvedTarget = resolveTargetPath(params.target_path, ctx.cwd);
        const insideCwd = isPathInside(resolvedTarget, ctx.cwd);
        if (!insideCwd) {
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Error: defense domain-lock: target_path '${params.target_path}' resolves to ` +
                            `'${resolvedTarget}', which is outside ctx.cwd '${ctx.cwd}'. ` +
                            `Explorer sessions are permanently confined to the repository.`,
                    },
                ],
                isError: true,
                details: undefined as unknown as Record<string, unknown>,
            };
        }
        const currentHeadScouts = mode === "concern_scout"
            ? successfulCurrentHeadScouts(ctx.cwd, stateDir)
            : [];
        if (
            mode === "concern_scout"
            && currentHeadScouts.length > 0
            && !supplementalScoutMatchesUncoveredCluster(ctx.cwd, stateDir, params.focus)
        ) {
            return {
                content: [{
                    type: "text",
                    text:
                        "Error: a successful current-HEAD concern_scout already exists in the application-attested receipt ledger. " +
                        "Reuse its proposed concerns. A supplemental scout is allowed only when focus names an exact current compiler-uncovered cluster; broad, unrelated, and repeated scouting is refused.",
                }],
                isError: true,
                details: {
                    duplicate_current_head_scout: true,
                    state_file: `${stateDir}/codebase_map.json`,
                },
            };
        }
        const expectedConcern = params.concern?.trim();
        if (mode === "concern_tracer" && !expectedConcern) {
            return makeBudgetError(
                "Error: concern_tracer requires concern with the exact application-bound concern identity.",
                {},
                stateDir,
            );
        }

        const subAgentModel = toolOptions.explorerModel;
        const subAgentModelLabel = `${subAgentModel.provider}/${subAgentModel.id}`;

        // Resolve step caps.
        const stepDefaults = MODE_STEP_DEFAULTS[mode] ?? { reads: 10, bash: 0, steps: 15 };
        const requestedMaxReads = params.max_reads ?? stepDefaults.reads;
        const maxBash = stepDefaults.bash;
        const requestedMaxSteps = params.max_total_steps ?? stepDefaults.steps;
        if (!Number.isSafeInteger(requestedMaxReads) || requestedMaxReads < 1 || requestedMaxReads > MAX_EXPLORER_READS) {
            return makeBudgetError(
                `Error: max_reads must be an integer between 1 and ${MAX_EXPLORER_READS}.`,
                { max_reads_limit: MAX_EXPLORER_READS },
                stateDir,
            );
        }
        if (!Number.isSafeInteger(requestedMaxSteps) || requestedMaxSteps < 1 || requestedMaxSteps > MAX_EXPLORER_PROVIDER_CALLS) {
            return makeBudgetError(
                `Error: max_total_steps must be an integer between 1 and ${MAX_EXPLORER_PROVIDER_CALLS}.`,
                { max_provider_calls_limit: MAX_EXPLORER_PROVIDER_CALLS },
                stateDir,
            );
        }
        const maxReads = Math.min(requestedMaxReads, stepDefaults.reads);
        const maxSteps = Math.min(requestedMaxSteps, stepDefaults.steps);

        // Resolve the sub-agent's system prompt. For fixed modes,
        // it's loaded from prompts/explorers/. For custom mode, the
        // builder composes it and passes via system_prompt.
        let subagentSystemPrompt: string;
        let promptSource: "inline" | "fixed";
        try {
            const resolved = resolveSubagentPrompt(
                mode,
                params.system_prompt,
                stateDir,
                ctx.cwd,
            );
            subagentSystemPrompt = resolved.prompt;
            promptSource = resolved.source;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${msg}`,
                    },
                ],
                isError: true,
                details: undefined as unknown as Record<string, unknown>,
            };
        }

        if (totalSpawnCount >= maxTotalSpawns) {
            return makeBudgetError(
                `Error: spawn_explorer budget exhausted: ${totalSpawnCount}/${maxTotalSpawns} total sub-agents already dispatched. ` +
                "Use the existing reports, write_map/write_map_delta, or mark the remaining gap honestly.",
                { max_total_spawns: maxTotalSpawns },
                stateDir,
            );
        }
        if (activeSpawnCount >= maxConcurrentSpawns) {
            return makeBudgetError(
                `Error: spawn_explorer concurrency budget exhausted: ${activeSpawnCount}/${maxConcurrentSpawns} sub-agents already running. ` +
                "Wait for current sub-agents to finish before dispatching more.",
                { max_concurrent_spawns: maxConcurrentSpawns },
                stateDir,
            );
        }
        if (maxTotalCostUsd !== null && totalCostUsd >= maxTotalCostUsd) {
            return makeBudgetError(
                `Error: spawn_explorer cost budget exhausted: $${totalCostUsd.toFixed(4)}/$${maxTotalCostUsd.toFixed(4)} ` +
                "provider-reported sub-agent cost already used. Reuse existing reports, narrow the audit, or mark remaining uncertainty honestly.",
                {
                    max_total_cost_usd: maxTotalCostUsd,
                    total_cost_usd: roundCost(totalCostUsd),
                },
                stateDir,
            );
        }

        let effectiveSubagentDurationMs = maxSubagentDurationMs;
        let maxProviderCalls = maxSteps;
        try {
            if (toolOptions.resourceBudget) {
                toolOptions.resourceBudget.assertProviderSessionCapacity(subAgentModel.contextWindow);
                effectiveSubagentDurationMs = Math.min(
                    effectiveSubagentDurationMs,
                    toolOptions.resourceBudget.reserveExplorer(mode),
                );
                maxProviderCalls = toolOptions.resourceBudget.remainingModelCalls(maxProviderCalls);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return makeBudgetError(`Error: ${message}.`, {}, stateDir);
        }
        const concernObservedAt = mode === "concern_tracer"
            ? currentRepositoryTimestamp(ctx.cwd)
            : null;
        if (mode === "concern_tracer" && !concernObservedAt) {
            return makeBudgetError(
                "Error: concern_tracer could not bind its report to the current repository commit timestamp.",
                {},
                stateDir,
            );
        }

        activeSpawnCount += 1;
        totalSpawnCount += 1;
        const start = Date.now();
        const runId = buildRunId();

        // Compose the user task for the sub-agent. Each fixed-mode
        // prompt uses positional $1 = TARGET_PATH and $2 = FOCUS; we
        // pass them space-separated. The prompt's variable section
        // explains what $2 means for its mode. We also pass a
        // model+step constraints block as a tail paragraph (the
        // sub-agent's prompt is unchanged; the parent injects this).
        const summarySuffix = params.summary ? `\n\n# Focus\n\n${params.summary}` : "";
        const constraintsBlock =
            `\n\n# Constraints (from parent)\n` +
            `- Model: ${subAgentModelLabel}\n` +
            `- Provider-call cap: ${maxProviderCalls} (${maxReads} repository reads, ${maxBash} bash invocations max)\n` +
            `- Return ## Report within ~${mode === "concern_tracer" ? 3_000 : maxSteps * 1_000} tokens.`;
        const task = mode === "custom"
            ? `${params.target_path}${summarySuffix}${constraintsBlock}`
            : `${params.target_path} ${params.focus ?? ""}${summarySuffix}${constraintsBlock}` +
              (expectedConcern ? `\n- Required concern identity: ${JSON.stringify(expectedConcern)}. Use it verbatim.` : "");

        let session: ExplorerSubSession | undefined;
        let resourceUsageRecorded = false;
        let providerCalls = 0;
        let oversizedReportPath: string | null = null;
        const submission: { concern: Concern | null } = { concern: null };

        try {
            const toolsForMode: ReadonlyArray<string> = params.tools ?? READ_ONLY_TOOLS;
            const readOnlySet = new Set<string>(READ_ONLY_TOOLS);
            const unsupportedTools = toolsForMode.filter((tool) => !readOnlySet.has(tool));
            if (unsupportedTools.length > 0) {
                throw new Error(
                    `explorer sessions are read-only; unsupported tools: ${unsupportedTools.join(", ")}`,
                );
            }
            const executionPolicy = createReadOnlyExecutionPolicy({
                cwd: ctx.cwd,
                mode: "audit-readonly",
                tools: toolsForMode,
            });
            let repositoryReadCalls = 0;
            const defenseHook = makeDefenseHook({ executionPolicy });

            // Build a clean resource loader for the sub-agent:
            // - no project context files (AGENTS.md, CLAUDE.md)
            // - no project extensions (the defense hook, etc. would
            //   interfere with the sub-agent's read-only purpose)
            // - no skills, prompt templates, themes
            // - the system prompt is fully replaced with the
            //   dimension-specific prompt (or the parent's custom
            //   prompt for custom mode).
            const resourceLoader = new DefaultResourceLoader({
                cwd: ctx.cwd,
                agentDir: toolOptions.agentDir,
                noContextFiles: true,
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                systemPrompt: subagentSystemPrompt,
                // Explorer sub-agents are read-only and use the same explicit
                // repository-root policy as the parent audit.
                extensionFactories: [
                    (pi) => {
                        pi.on("before_provider_request", (event) => {
                            let payload = mode === "concern_tracer"
                                ? capProviderOutputTokens(
                                    event.payload,
                                    subAgentModel.api,
                                    MAX_CONCERN_RESPONSE_TOKENS,
                                )
                                : event.payload;
                            if (
                                mode === "concern_tracer"
                                && submission.concern === null
                                && shouldForceConcernSubmission(
                                    providerCalls,
                                    maxProviderCalls,
                                    repositoryReadCalls,
                                    maxReads,
                                )
                            ) {
                                payload = forceProviderToolChoice(
                                    payload,
                                    subAgentModel.api,
                                    "submit_concern_report",
                                );
                            }
                            toolOptions.resourceBudget?.assertProviderInputCapacity(payload);
                            return payload;
                        });
                        pi.on("tool_call", async (event) => {
                            const defenseResult = await defenseHook(event);
                            if (defenseResult) return defenseResult;
                            if (readOnlySet.has(event.toolName)) {
                                if (repositoryReadCalls >= maxReads) {
                                    return {
                                        block: true,
                                        reason: `explorer repository-read cap reached: ${repositoryReadCalls}/${maxReads}`,
                                    };
                                }
                                repositoryReadCalls += 1;
                                if (mode === "concern_tracer" && repositoryReadCalls >= maxReads) {
                                    pi.setActiveTools(activeExplorerToolsAfterRead(
                                        mode,
                                        repositoryReadCalls,
                                        maxReads,
                                        [...toolsForMode, "submit_concern_report"],
                                    ));
                                    const steerMessage = concernSubmissionSteerMessage(
                                        mode,
                                        repositoryReadCalls,
                                        maxReads,
                                    );
                                    if (steerMessage) {
                                        pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
                                    }
                                }
                            }
                            return undefined;
                        });
                    },
                ],
            });
            await resourceLoader.reload();


            // Mirror the parent's thinking level so sub-agents do their
            // structured analysis with the same reasoning budget as the
            // builder. A sub-agent running at the SDK default would
            // silently do less reasoning and produce weaker reports.
            const parentThinkingLevel = getThinkingLevel();
            const concernSubmissionTool = mode === "concern_tracer"
                ? createConcernSubmissionTool(concernObservedAt as string, (concern) => {
                    submission.concern = concern;
                }, ctx.cwd, expectedConcern)
                : null;
            const sessionTools = concernSubmissionTool
                ? [...toolsForMode, concernSubmissionTool.name]
                : [...toolsForMode];
            const { session: createdSession } = await createSession({
                cwd: ctx.cwd,
                agentDir: toolOptions.agentDir,
                model: subAgentModel,
                thinkingLevel: parentThinkingLevel === "unknown" ? undefined : parentThinkingLevel,
                tools: sessionTools,
                customTools: concernSubmissionTool ? [concernSubmissionTool] : [],
                resourceLoader,
            });
            session = createdSession;

            // Send the task and wait for the sub-agent to finish, with
            // a hard wall-clock timeout. The session is disposed in the
            // finally block, including after timeout.
            if (!session) throw new Error("session not initialized");
            const explorerBudgetSession = toolOptions.resourceBudget?.beginSession();
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let unsubscribe: (() => void) | undefined;
            let rejectCallCap: ((error: Error) => void) | undefined;
            let callCapReached = false;
            const callCapPromise = new Promise<never>((_resolve, reject) => {
                rejectCallCap = reject;
            });
            if (session.subscribe) {
                unsubscribe = session.subscribe((event: unknown) => {
                    if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return;
                    if (event.message.role !== "assistant") return;
                    if (callCapReached) return;
                    providerCalls += 1;
                    if (toolOptions.resourceBudget && explorerBudgetSession) {
                        resourceUsageRecorded = true;
                        try {
                            toolOptions.resourceBudget.observeParentEvent(
                                event as unknown as AgentSessionEvent,
                                explorerBudgetSession,
                            );
                        } catch (error) {
                            callCapReached = true;
                            session?.clearQueue?.();
                            void session?.abort?.().catch(() => undefined);
                            rejectCallCap?.(error instanceof Error ? error : new Error(String(error)));
                            return;
                        }
                    }
                    if (
                        providerCalls >= maxProviderCalls
                        && event.message.stopReason !== "stop"
                        && !callCapReached
                    ) {
                        callCapReached = true;
                        session?.clearQueue?.();
                        void session?.abort?.().catch(() => undefined);
                        rejectCallCap?.(new Error(
                            `sub-agent reached hard provider call cap of ${maxProviderCalls} while requesting continuation; ` +
                            "use the partial report, narrow the exploration, or leave the obligation unresolved",
                        ));
                    }
                });
            }
            try {
                await Promise.race([
                    session.prompt(task),
                    callCapPromise,
                    new Promise<never>((_resolve, reject) => {
                        timeout = setTimeout(() => {
                            session?.clearQueue?.();
                            void session?.abort?.().catch(() => undefined);
                            reject(
                                new Error(
                                    `sub-agent exceeded timeout of ${effectiveSubagentDurationMs}ms; ` +
                                    "split the exploration into a narrower target or mark the gap honestly",
                                ),
                            );
                        }, effectiveSubagentDurationMs);
                    }),
                ]);
            } finally {
                if (timeout) clearTimeout(timeout);
                unsubscribe?.();
            }

            if (!session.subscribe) {
                providerCalls = session.messages.filter((message) => (
                    isRecord(message) && message.role === "assistant" && message.usage !== undefined
                )).length;
                if (providerCalls > maxProviderCalls) {
                    throw new Error(
                        `sub-agent exceeded hard provider call cap of ${maxProviderCalls}: observed ${providerCalls}`,
                    );
                }
            }

            // Extract the final assistant text from the sub-agent's
            // message history and return it as the tool result.
            const submittedConcern = submission.concern as Concern | null;
            if (mode === "concern_tracer" && submittedConcern === null) {
                throw new Error("concern_tracer did not call submit_concern_report with a valid typed concern");
            }
            const rawReport = submittedConcern
                ? `## Report\n\`\`\`json\n${JSON.stringify(submittedConcern, null, 2)}\n\`\`\``
                : extractFinalAssistantText(
                    session.messages as ReadonlyArray<{ role?: string; content?: unknown }>,
                );
            const rawReportBytes = Buffer.byteLength(rawReport, "utf8");
            if (rawReportBytes > MAX_REPORT_BYTES) {
                oversizedReportPath = persistTruncatedReport(ctx.cwd, mode, runId, rawReport, stateDir);
                throw new Error(
                    `sub-agent report exceeded hard output cap of ${MAX_REPORT_BYTES} bytes: ${rawReportBytes} bytes; ` +
                    "retry with a narrower focus and a concise report",
                );
            }
            const structuredConcern = mode === "concern_tracer"
                ? { concern: submittedConcern, error: null }
                : null;
            if (structuredConcern?.concern === null) {
                throw new Error(structuredConcern.error ?? "concern_tracer report is invalid");
            }

            // Truncate the report if it exceeds the cap.
            const { report, truncated, report_length } = truncateReport(rawReport);
            let truncatedPath = "";
            if (truncated) {
                truncatedPath = persistTruncatedReport(ctx.cwd, mode, runId, rawReport, stateDir);
            }

            // Count actual tool calls from the sub-agent for the step-cap diagnostic.
            const subagentMessages =
                session.messages as ReadonlyArray<{ role?: string; content?: unknown }>;
            const sessionCostUsd = extractSessionCostUsd(session.messages);
            if (!resourceUsageRecorded) {
                resourceUsageRecorded = true;
                toolOptions.resourceBudget?.recordExplorerMessages(session.messages);
            }
            if (sessionCostUsd !== null) {
                totalCostUsd = roundCost(totalCostUsd + sessionCostUsd);
            }
            const readCount = repositoryReadCalls;
            let bashCount = 0;
            for (const m of subagentMessages) {
                if (m.role !== "assistant") continue;
                if (!Array.isArray(m.content)) continue;
                for (const block of m.content) {
                    if (!block || typeof block !== "object") continue;
                    const b = block as { type?: string; name?: string };
                    if (b.type === "toolCall") {
                        if (b.name === "bash") bashCount += 1;
                    }
                }
            }

            const durationMs = Date.now() - start;
            const stepWarning =
                readCount > maxReads || bashCount > maxBash
                    ? ` [WARNING: sub-agent exceeded step cap: reads=${readCount}/${maxReads}, bash=${bashCount}/${maxBash}]`
                    : readCount >= maxReads * 0.8
                    ? ` [WARNING: 80% of reads used: ${readCount}/${maxReads}]`
                    : "";
            const costText = sessionCostUsd === null
                ? "cost=unknown"
                : `cost=$${sessionCostUsd.toFixed(4)}, total_cost=$${totalCostUsd.toFixed(4)}` +
                  (maxTotalCostUsd === null ? "" : `/$${maxTotalCostUsd.toFixed(4)}`);
            const costWarning =
                maxTotalCostUsd !== null && totalCostUsd > maxTotalCostUsd
                    ? " [WARNING: sub-agent cost budget exceeded; future spawns will be refused]"
                    : maxTotalCostUsd !== null && totalCostUsd >= maxTotalCostUsd * 0.8
                    ? " [WARNING: 80% of sub-agent cost budget used]"
                    : "";

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Sub-agent (mode=${mode}, model=${subAgentModelLabel}) explored ${params.target_path} in ${durationMs}ms. ` +
                            `provider_calls=${providerCalls}/${maxProviderCalls}, reads=${readCount}/${maxReads}, ` +
                            `bash=${bashCount}/${maxBash}, ${costText}${stepWarning}${costWarning}.\n\n` +
                            report,
                    },
                ],
                details: {
                    mode,
                    prompt_source: promptSource,
                    target_path: params.target_path,
                    resolved_target_path: resolvedTarget,
                    focus: params.focus ?? null,
                    expected_concern: expectedConcern ?? null,
                    summary: params.summary ?? null,
                    model: subAgentModelLabel,
                    tools: sessionTools,
                    duration_ms: durationMs,
                    report_length,
                    report_truncated: truncated,
                    report_truncated_path: truncatedPath || null,
                    report_concern: structuredConcern?.concern?.concern ?? null,
                    structured_concern: structuredConcern?.concern ?? null,
                    reads: readCount,
                    bash: bashCount,
                    cost_usd: sessionCostUsd,
                    total_cost_usd: totalCostUsd,
                    max_total_cost_usd: maxTotalCostUsd,
                    max_reads: maxReads,
                    max_bash: maxBash,
                    max_steps: maxSteps,
                    provider_calls: providerCalls,
                    max_provider_calls: maxProviderCalls,
                    max_total_spawns: maxTotalSpawns,
                    total_spawns_used: totalSpawnCount,
                    max_concurrent_spawns: maxConcurrentSpawns,
                    active_spawns: activeSpawnCount,
                    max_subagent_duration_ms: effectiveSubagentDurationMs,
                    domain_locked: insideCwd,
                    run_id: runId,
                },
            };
        } catch (err) {
            if (session && !resourceUsageRecorded) {
                resourceUsageRecorded = true;
                toolOptions.resourceBudget?.recordExplorerMessages(session.messages);
            }
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: sub-agent (mode=${mode}) for ${params.target_path} failed: ${params.focus?.trim() ? `focus=${JSON.stringify(params.focus.trim())}; ` : ""}${msg}`,
                    },
                ],
                isError: true,
                details: {
                    mode,
                    target_path: params.target_path,
                    resolved_target_path: resolvedTarget,
                    focus: params.focus ?? null,
                    summary: params.summary ?? null,
                    error_message: msg,
                    failure_kind: /timeout|timed out/i.test(msg)
                        ? "timeout"
                        : /report exceeded hard output cap/i.test(msg)
                        ? "output_limit"
                        : /resource budget exhausted/i.test(msg)
                        ? "resource_budget"
                        : "error",
                    report_truncated_path: oversizedReportPath,
                    provider_calls: providerCalls,
                    max_provider_calls: maxProviderCalls,
                    duration_ms: Date.now() - start,
                    run_id: runId,
                },
            };
        } finally {
            try {
                session?.dispose();
            } catch {
                // ignore disposal errors
            }
            activeSpawnCount -= 1;
        }
    },
    }) as unknown as ToolDefinition;
}

export type SpawnExplorerTool = ReturnType<typeof createSpawnExplorerTool>;
