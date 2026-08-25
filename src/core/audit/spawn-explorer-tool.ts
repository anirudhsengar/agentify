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
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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
const MAX_REPORT_BYTES = 32_000;
// A repository audit must finish in a useful amount of time even when a
// provider stalls. These are deliberately conservative defaults: the parent
// can synthesize from its own scouts and honest gaps after bounded attempts.
const DEFAULT_MAX_TOTAL_SPAWNS = 16;
const DEFAULT_MAX_CONCURRENT_SPAWNS = 2;
// Large repository feature subtrees can require several model turns even with
// the explorer's read-only tool budget. Keep the timeout bounded, but leave
// enough room for a useful structured report rather than repeated retries.
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_MAX_TOTAL_COST_USD = 5;

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
    // Concern discovery is the widest and deepest exploration in the audit: the
    // scout sweeps the whole repository for specialties, and each tracer must
    // follow one concern end to end through every subtree it reaches. A
    // shallow trace produces a specialist that gives shallow answers, so these
    // modes get the largest read budgets.
    concern_scout: { reads: 20, bash: 0, steps: 28 },
    concern_tracer: { reads: 25, bash: 0, steps: 34 },
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
    summary: Type.Optional(
        Type.String({
            description:
                "One-line focus summary passed to the sub-agent as context. " +
                "Useful for steering the sub-agent's exploration toward a specific aspect.",
        }),
    ),
    max_reads: Type.Optional(
        Type.Number({
            description: "Override the per-mode default read cap.",
        }),
    ),
    max_total_steps: Type.Optional(
        Type.Number({
            description: "Override the per-mode default total step cap.",
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
    /** Test seam for running a fake sub-agent without contacting a model provider. */
    createSession?: CreateExplorerSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function roundCost(costUsd: number): number {
    return Number(costUsd.toFixed(12));
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
        "There are 10 modes. The first 9 are dimension-shaped fixed modes: " +
        "topography (whole-codebase orientation), module_graph (imports/split/shared state), " +
        "type_tracer (trace a type end-to-end; pass type name in focus), conventions (induce naming/logging/etc.), " +
        "operational (build/run/deploy/env/ports), security (path/command/env classifications), " +
        "pitfalls (git-log + grep for tribal knowledge), validation (test/lint/typecheck commands), " +
        "gap_filler (close an uncovered D1-D10 dimension; pass dimension in focus). " +
        "The 10th mode is `custom`: the parent supplies self-contained read-only " +
        "instructions based on gathered repository evidence through `system_prompt`. " +
        `Hard dispatch budgets: max ${maxTotalSpawns} total sub-agents per audit, ` +
        `max ${maxConcurrentSpawns} concurrent sub-agents, and max ${maxSubagentDurationMs}ms ` +
        "wall-clock time per sub-agent" +
        (maxTotalCostUsd === null ? "" : `, plus max $${maxTotalCostUsd.toFixed(2)} provider-reported sub-agent cost`) +
        ". Dispatch as many as the topic decomposition needs within those bounds. " +
        "Default mode: topography. Reports exceeding 32 KB are truncated; the full report is " +
        "persisted to the log dir. target_path is permanently domain-locked to ctx.cwd. " +
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

        const subAgentModel = toolOptions.explorerModel;
        const subAgentModelLabel = `${subAgentModel.provider}/${subAgentModel.id}`;

        // Resolve step caps.
        const stepDefaults = MODE_STEP_DEFAULTS[mode] ?? { reads: 10, bash: 0, steps: 15 };
        const maxReads = params.max_reads ?? stepDefaults.reads;
        const maxBash = stepDefaults.bash;
        const maxSteps = params.max_total_steps ?? stepDefaults.steps;

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
            `- Step cap: ${maxSteps} total (${maxReads} reads, ${maxBash} bash invocations max)\n` +
            `- Return ## Report within ~${maxSteps * 1000} tokens.`;
        const task = mode === "custom"
            ? `${params.target_path}${summarySuffix}${constraintsBlock}`
            : `${params.target_path} ${params.focus ?? ""}${summarySuffix}${constraintsBlock}`;

        let session: ExplorerSubSession | undefined;

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
                        pi.on("tool_call", makeDefenseHook({ executionPolicy }));
                    },
                ],
            });
            await resourceLoader.reload();


            // Mirror the parent's thinking level so sub-agents do their
            // structured analysis with the same reasoning budget as the
            // builder. A sub-agent running at the SDK default would
            // silently do less reasoning and produce weaker reports.
            const parentThinkingLevel = getThinkingLevel();
            const { session: createdSession } = await createSession({
                cwd: ctx.cwd,
                agentDir: toolOptions.agentDir,
                model: subAgentModel,
                thinkingLevel: parentThinkingLevel === "unknown" ? undefined : parentThinkingLevel,
                tools: [...toolsForMode],
                resourceLoader,
            });
            session = createdSession;

            // Send the task and wait for the sub-agent to finish, with
            // a hard wall-clock timeout. The session is disposed in the
            // finally block, including after timeout.
            if (!session) throw new Error("session not initialized");
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    session.prompt(task),
                    new Promise<never>((_resolve, reject) => {
                        timeout = setTimeout(() => {
                            reject(
                                new Error(
                                    `sub-agent exceeded timeout of ${maxSubagentDurationMs}ms; ` +
                                    "split the exploration into a narrower target or mark the gap honestly",
                                ),
                            );
                        }, maxSubagentDurationMs);
                    }),
                ]);
            } finally {
                if (timeout) clearTimeout(timeout);
            }

            // Extract the final assistant text from the sub-agent's
            // message history and return it as the tool result.
            const rawReport = extractFinalAssistantText(
                session.messages as ReadonlyArray<{ role?: string; content?: unknown }>,
            );

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
            if (sessionCostUsd !== null) {
                totalCostUsd = roundCost(totalCostUsd + sessionCostUsd);
            }
            let readCount = 0;
            let bashCount = 0;
            for (const m of subagentMessages) {
                if (m.role !== "assistant") continue;
                if (!Array.isArray(m.content)) continue;
                for (const block of m.content) {
                    if (!block || typeof block !== "object") continue;
                    const b = block as { type?: string; name?: string };
                    if (b.type === "tool_use") {
                        if (b.name === "read") readCount += 1;
                        else if (b.name === "bash") bashCount += 1;
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
                            `reads=${readCount}/${maxReads}, bash=${bashCount}/${maxBash}, ${costText}${stepWarning}${costWarning}.\n\n` +
                            report,
                    },
                ],
                details: {
                    mode,
                    prompt_source: promptSource,
                    target_path: params.target_path,
                    resolved_target_path: resolvedTarget,
                    focus: params.focus ?? null,
                    summary: params.summary ?? null,
                    model: subAgentModelLabel,
                    tools: toolsForMode,
                    duration_ms: durationMs,
                    report_length,
                    report_truncated: truncated,
                    report_truncated_path: truncatedPath || null,
                    reads: readCount,
                    bash: bashCount,
                    cost_usd: sessionCostUsd,
                    total_cost_usd: totalCostUsd,
                    max_total_cost_usd: maxTotalCostUsd,
                    max_reads: maxReads,
                    max_bash: maxBash,
                    max_steps: maxSteps,
                    max_total_spawns: maxTotalSpawns,
                    total_spawns_used: totalSpawnCount,
                    max_concurrent_spawns: maxConcurrentSpawns,
                    active_spawns: activeSpawnCount,
                    max_subagent_duration_ms: maxSubagentDurationMs,
                    domain_locked: insideCwd,
                    run_id: runId,
                },
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: sub-agent (mode=${mode}) for ${params.target_path} failed: ${msg}`,
                    },
                ],
                isError: true,
                details: undefined as unknown as Record<string, unknown>,
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
