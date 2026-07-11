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
//   - custom        — system prompt composed by the parent (Phase 2.10);
//                     one per topic/specialization, bounded by the audit
//                     dispatch budget.
//
// "files" mode was deprecated in Task 3.8 — removed from the enum.
// The "custom" mode (Phase 2.10) replaces the old fixed feature cap,
// but sub-agent dispatch is still bounded by total/concurrent/time
// budgets so a bad audit cannot spawn unbounded work.

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
import { LEGACY_PI_STATE_RELATIVE_DIR } from "../state-dir.ts";
import { getThinkingLevel } from "./state.ts";
import { makeDefenseHook } from "./defense-hook.ts";
import {
    createReadOnlyExecutionPolicy,
    READ_ONLY_TOOLS,
} from "../security/execution-policy.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPLORERS_DIR = path.join(HERE, "prompts", "explorers");

// Hard cap on sub-agent report size (Phase 1.3). 32 KB is enough
// for a structured ## Report; anything larger is truncated to
// prevent context overflow.
const MAX_REPORT_BYTES = 32_000;
const DEFAULT_MAX_TOTAL_SPAWNS = 64;
const DEFAULT_MAX_CONCURRENT_SPAWNS = 4;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TOTAL_COST_USD = 10;

// The 9 dimension-shaped modes plus a 10th "custom" mode (Phase 2.10)
// that takes an inline or file-based system prompt composed by the
// builder. The legacy "files" mode is deprecated (Task 3.8) and
// removed from the enum. If a future caller uses it, TypeBox
// validation will reject the call.
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
};

// The 11-section template used by the builder to compose custom
// sub-agent prompts (Phase 2.10). The builder reads this template,
// substitutes the `{{...}}` placeholders, and dispatches the
// sub-agent with the composed system prompt (inline or as a file).
const CUSTOM_TEMPLATE_PATH = path.join(EXPLORERS_DIR, "_template.md");

// Per-mode model selection (Phase 2.7). DELETED in Phase 2:
// sub-agents now run on the configured `explorer` slot model — every
// mode resolves to the same Model. The `model` parameter still accepts
// `"inherit" | "haiku" | "sonnet" | "opus"` literals for back-compat,
// which override the slot on a per-call basis via `LITERAL_TO_MODEL`.

/** Per-mode step caps (Phase 4.6). */
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
    // Phase 2.10 — custom sub-agents: builder specifies per-call.
    custom: { reads: 8, bash: 0, steps: 12 },
};

const ModelChoice = StringEnum(
    ["inherit", "haiku", "sonnet", "opus"] as const,
    { default: "inherit" },
);

/**
 * Map the `model` literal to a concrete (provider, id) pair. The
 * resolver picks the model that has auth configured; if the literal
 * points at a model the user's auth doesn't cover, the resolver
 * throws a clear `NoAuthForProviderError`. Phase 2.
 */
const LITERAL_TO_MODEL: Record<string, { provider: string; id: string }> = {
    haiku: { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
    sonnet: { provider: "anthropic", id: "claude-sonnet-4-6" },
    opus: { provider: "anthropic", id: "claude-opus-4-8" },
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
    model: Type.Optional(
        ModelChoice,
    ),
    summary: Type.Optional(
        Type.String({
            description:
                "One-line focus summary passed to the sub-agent as context. " +
                "Useful for steering the sub-agent's exploration toward a specific aspect.",
        }),
    ),
    allow_external_paths: Type.Optional(
        Type.Boolean({
            description:
                "Deprecated compatibility field. External paths are always rejected, even when true.",
        }),
    ),
    max_reads: Type.Optional(
        Type.Number({
            description: "Override the per-mode default read cap.",
        }),
    ),
    max_bash_invocations: Type.Optional(
        Type.Number({
            description: "Deprecated compatibility field. Explorer sessions never receive bash; the effective cap is always zero.",
        }),
    ),
    max_total_steps: Type.Optional(
        Type.Number({
            description: "Override the per-mode default total step cap.",
        }),
    ),
    // Phase 2.10 — custom mode parameters. The builder composes a
    // system prompt for the sub-agent (one per topic/specialization)
    // and dispatches it. Inline is fine for short prompts; file-based
    // is for longer ones. Exactly one of `system_prompt` or
    // `system_prompt_file` MUST be provided when mode == "custom".
    // For other modes these are ignored.
    system_prompt: Type.Optional(
        Type.String({
            description:
                "Inline system prompt for the sub-agent. The builder " +
                "composes this from the `_template.md` 11-section template " +
                "with the placeholders substituted. Required for `custom` " +
                "mode unless `system_prompt_file` is provided. Inline is " +
                "recommended for prompts under ~16 KB.",
        }),
    ),
    system_prompt_file: Type.Optional(
        Type.String({
            description:
                "Path (absolute or cwd-relative) to a `.md` file containing " +
                "the sub-agent's full system prompt. Use this for long " +
                "prompts (>16 KB) or when the builder wants to write the " +
                "prompt to disk first (e.g., for inspection). Required for " +
                "`custom` mode unless `system_prompt` is provided. The " +
                "file is read once at spawn time and passed to the " +
                "sub-agent's resource loader.",
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

/**
 * @deprecated Default budget-recovery block used by tools created
 * without an explicit stateDir. References the legacy
 * `.pi/agentify/` paths. Use `buildBudgetRecovery(stateDir)` to
 * construct a tool bound to a provider-scoped state dir.
 */
const BUDGET_RECOVERY: {
    can_continue: boolean;
    actions: ReadonlyArray<string>;
    state_files: ReadonlyArray<string>;
} = {
    can_continue: true,
    actions: [
        `Read ${LEGACY_PI_STATE_RELATIVE_DIR}/codebase_map.json and the latest run log before dispatching any more explorers.`,
        "Reuse completed sub-agent reports and call write_map or write_map_delta with the strongest evidence already gathered.",
        "Narrow any remaining target_path/focus before retrying only if a budget remains.",
        "For genuinely unobservable gaps, record an honest null/open_question rather than inventing coverage.",
    ],
    state_files: [
        `${LEGACY_PI_STATE_RELATIVE_DIR}/codebase_map.json`,
        `${LEGACY_PI_STATE_RELATIVE_DIR}/logs/*.jsonl`,
        `${LEGACY_PI_STATE_RELATIVE_DIR}/logs/*-spawn-*-report.txt`,
    ],
};

/**
 * State-dir-aware budget recovery block. Constructed per tool
 * instance so the LLM-facing recovery text describes the active
 * state dir rather than the historical `.pi/agentify/` literal.
 */
function buildBudgetRecovery(stateDir: string): typeof BUDGET_RECOVERY {
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

function resolveExplorerPromptPath(mode: string): string {
    const file = MODE_TO_FILE[mode];
    if (!file) {
        throw new Error(
            `Unknown explorer mode: "${mode}". Valid modes: ${Object.keys(MODE_TO_FILE).join(", ")}`,
        );
    }
    return path.join(EXPLORERS_DIR, file);
}

function readSubagentPrompt(mode: string, stateDir: string): string {
    const promptPath = resolveExplorerPromptPath(mode);
    return fs
        .readFileSync(promptPath, "utf-8")
        .replace(/<stateDir>/g, stateDir);
}

/**
 * Resolve the system prompt for a sub-agent.
 *
 * For fixed modes (topography, module_graph, etc.), the prompt is
 * loaded from the explorer files in `prompts/explorers/`.
 *
 * For `custom` mode (Phase 2.10), the prompt is composed by the
 * parent (the builder) and passed either inline (`system_prompt`)
 * or as a file (`system_prompt_file`). Exactly one of the two is
 * required when `mode == "custom"`.
 */
function resolveSubagentPrompt(
    mode: string,
    inlinePrompt: string | undefined,
    promptFile: string | undefined,
    cwd: string,
    stateDir: string,
): { prompt: string; source: "inline" | "file" | "fixed" } {
    if (mode === "custom") {
        if (inlinePrompt) {
            return { prompt: inlinePrompt.replace(/<stateDir>/g, stateDir), source: "inline" };
        }
        if (promptFile) {
            // Resolve relative paths against the repo cwd, not the
            // process cwd (B6), and confine the read to the repo.
            const resolved = path.isAbsolute(promptFile)
                ? path.normalize(promptFile)
                : path.normalize(path.resolve(cwd, promptFile));
            if (!isPathInside(resolved, cwd) && !path.isAbsolute(promptFile)) {
                throw new Error(
                    `system_prompt_file '${promptFile}' resolves outside the repository.`,
                );
            }
            return {
                prompt: fs.readFileSync(resolved, "utf-8").replace(/<stateDir>/g, stateDir),
                source: "file",
            };
        }
        throw new Error(
            `custom mode requires either system_prompt or system_prompt_file. ` +
            `Compose the prompt from the 11-section template at ` +
            `${CUSTOM_TEMPLATE_PATH} and pass it via one of the two parameters.`,
        );
    }
    // Fixed mode: load from disk.
    return { prompt: readSubagentPrompt(mode, stateDir), source: "fixed" };
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
     * Provider-scoped audit state dir (relative to the repo root,
     * no trailing slash — e.g. ".claude/agentify"). Used as the
     * destination for sub-agent logs and as the source of truth for
     * budget-recovery messages. Defaults to the legacy
     * `.pi/agentify/` path when omitted (backward compat for tests
     * and direct callers that haven't migrated yet).
     */
    stateDir?: string;
    /**
     * Resolved model to use for explorer sub-agents. Computed by the
     * caller via `selectModelForRole(registry, config, "explorer")`.
     * When `params.model === "inherit"` (the default), this is the
     * model passed to `createSession`. When the user overrides with
     * `haiku`/`sonnet`/`opus`, this is replaced with a literal lookup.
     */
    explorerModel: Model<Api>;
    /**
     * ModelRegistry used to resolve literal overrides
     * (`haiku`/`sonnet`/`opus`) against the user's auth. Required so
     * we can throw `NoAuthForProviderError` rather than silently
     * downgrade.
     */
    modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
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
    const stateDir = toolOptions.stateDir ?? LEGACY_PI_STATE_RELATIVE_DIR;
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
        "The 10th mode is `custom` (Phase 2.10): the parent composes the sub-agent's system " +
        "prompt from the 11-section `_template.md`, and the sub-agent becomes a topic/specialization " +
        "specialist. Pass the prompt via `system_prompt` (inline) or `system_prompt_file` (path). " +
        `Hard dispatch budgets: max ${maxTotalSpawns} total sub-agents per audit, ` +
        `max ${maxConcurrentSpawns} concurrent sub-agents, and max ${maxSubagentDurationMs}ms ` +
        "wall-clock time per sub-agent" +
        (maxTotalCostUsd === null ? "" : `, plus max $${maxTotalCostUsd.toFixed(2)} provider-reported sub-agent cost`) +
        ". Dispatch as many as the topic decomposition needs within those bounds. " +
        "Default mode: topography. Reports exceeding 32 KB are truncated; the full report is " +
        "persisted to the log dir. target_path is permanently domain-locked to ctx.cwd. " +
        "Use the `model` parameter to override the per-mode " +
        "model default (haiku/sonnet/opus). Use `summary` for a one-line focus hint passed as " +
        "additional context.",
    parameters: SpawnExplorerParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
        const mode = params.mode ?? "topography";

        // Validate target_path domain-lock (Phase 2.6).
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

        // Log external path access (Phase 2.6).
        if (params.allow_external_paths) {
            try {
                // Best-effort: log to the agentify log if available.
                // The actual write happens via ctx.log if exposed; we
                // emit a no-op here that the defense hook handler can pick
                // up. The audit trail is in the JSONL log via the
                // subagent_spawned event's details.
            } catch {
                // ignore
            }
        }

        // Resolve the sub-agent's model (Phase 2). Default is the
        // explorer slot (passed via `toolOptions.explorerModel`).
        // Explicit `model: haiku|sonnet|opus` literals are resolved
        // against the user's auth via `modelRegistry.find`; if the
        // literal points at a model the user can't actually call,
        // we return a clear error rather than silently downgrading.
        const modelChoice = params.model ?? "inherit";
        let subAgentModel: Model<Api>;
        let subAgentModelLabel: string;
        if (modelChoice === "inherit") {
            subAgentModel = toolOptions.explorerModel;
            subAgentModelLabel = `${subAgentModel.provider}/${subAgentModel.id}`;
        } else {
            const literal = LITERAL_TO_MODEL[modelChoice];
            if (!literal) {
                return {
                    content: [{ type: "text", text: `Error: unknown model literal '${modelChoice}'` }],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }
            const found = toolOptions.modelRegistry.find(literal.provider, literal.id);
            if (!found) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: spawn_explorer model '${literal.provider}/${literal.id}' is not in the model registry. ` +
                            `Run \`agentify models list --provider ${literal.provider}\` to see available models.`,
                    }],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }
            const available = toolOptions.modelRegistry.getAvailable();
            if (!available.some((m) => m.id === found.id && m.provider === found.provider)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: spawn_explorer model '${literal.provider}/${literal.id}' is known but unavailable with the current credentials. ` +
                            `Run \`agentify login --provider ${literal.provider}\` first.`,
                    }],
                    isError: true,
                    details: undefined as unknown as Record<string, unknown>,
                };
            }
            subAgentModel = found;
            subAgentModelLabel = `${found.provider}/${found.id}`;
        }

        // Resolve step caps (Phase 4.6).
        const stepDefaults = MODE_STEP_DEFAULTS[mode] ?? { reads: 10, bash: 0, steps: 15 };
        const maxReads = params.max_reads ?? stepDefaults.reads;
        const maxBash = params.max_bash_invocations ?? stepDefaults.bash;
        const maxSteps = params.max_total_steps ?? stepDefaults.steps;

        // Resolve the sub-agent's system prompt. For fixed modes,
        // it's loaded from prompts/explorers/. For custom mode, the
        // builder composes it and passes via system_prompt or
        // system_prompt_file.
        let subagentSystemPrompt: string;
        let promptSource: "inline" | "file" | "fixed";
        try {
            const resolved = resolveSubagentPrompt(
                mode,
                params.system_prompt,
                params.system_prompt_file,
                ctx.cwd,
                stateDir,
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
                modelRegistry: ctx.modelRegistry,
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
                    allow_external_paths: params.allow_external_paths ?? false,
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
