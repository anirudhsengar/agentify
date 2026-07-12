// agent-manager.ts — the live sub-agent registry.
//
// The orchestrator's create_agent / command_agent / delete_agent /
// interrupt_agent / list_agents / check_agent_status /
// read_system_logs / report_cost all dispatch to this class.
//
// Each "managed agent" is one Pi session created via
// `runtime.runSession()` with the orchestrator-supplied system
// prompt, tools, and (optionally) a subagent-template. The
// AgentManager holds:
//
//   - a Map<agent_id, ManagedAgent> of live sessions
//   - an AbortController per agent for interrupt_agent
//   - a per-agent paths object for state.json / events.jsonl /
//     execution.log persistence
//   - an event subscriber that forwards every AgentSessionEvent
//     to events.jsonl and updates cost/turns in state.json
//
// The manager is concurrency-safe (Map operations are atomic in
// single-threaded JS). Two create_agent calls with the same name
// get distinct suffixes (via generateAgentId's random hex).
//
// Per `principles/08-multi-agent.md` § "Primary Agents vs.
// Disposable Sub-Agents", sub-agents here are **disposable** —
// they live for one task and are deleted when done.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime } from "../types.ts";
import type {
  AgentState,
  AgentStatus,
} from "./state.ts";
import {
  AgentStatus as AgentStatusConst,
  abortAgent,
  completeAgent,
  deleteAgent as deleteAgentState,
  failAgent,
  generateAgentId,
  interruptAgent,
  isTerminal,
  makeQueuedAgentState,
  startAgent,
  updateAgent,
} from "./state.ts";
import {
  agentPaths,
  appendAgentEvent,
  appendAgentExecutionLog,
  ensureAgentDirs,
  readAgentState,
  writeAgentPrompt,
  writeAgentState,
  type AgentPaths,
} from "./paths.ts";
import type { SubagentRegistry } from "./subagent-registry.ts";
import type { AgentDefinition } from "./subagent-registry.ts";
import { writeCostRecord, readCostRecord, orchestratorPaths } from "./paths.ts";
import {
  createReadOnlyExecutionPolicy,
  createRepositoryWriteExecutionPolicy,
} from "../security/execution-policy.ts";

// ---------------------------------------------------------------------------
// Public types (returned by tools to the orchestrator LLM)
// ---------------------------------------------------------------------------

export interface CreateAgentArgs {
  name: string;
  /** Either inline system_prompt OR subagent_template must be set. */
  system_prompt?: string;
  /** Registry key; resolved against SubagentRegistry. */
  subagent_template?: string;
  /** Model choice. Default: 'inherit'. */
  model?: string | null;
  /** Thinking level. Default: inherit. */
  thinking_level?: string | null;
  /**
   * Named slot role for this sub-agent. Default: inherit parent's
   * role (typically "primary"). See `ModelRole`.
   */
  modelRole?: "primary" | "explorer" | "lite" | null;
  /** Initial user prompt. */
  user_prompt: string;
  /** Tool allowlist. Default: from template; if neither, ['read']. */
  tools?: string[];
  /** Domain globs (reserved for workflow-mode). */
  domain?: string[];
}

export interface CommandAgentArgs {
  agent_id: string;
  prompt: string;
}

export interface CreateAgentResult {
  agent_id: string;
  name: string;
  status: AgentStatus;
  started_at: string;
}

export interface ListAgentsFilter {
  status?: AgentStatus[];
}

function normalizeThinking(value: string): import("../types.ts").ThinkingLevel | undefined {
  if (value === "off" || value === "minimal" || value === "low"
      || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return undefined;
}

function normalizeModelRole(value: string | null): import("../types.ts").ModelRole | undefined {
  if (value === "primary" || value === "explorer" || value === "lite") {
    return value;
  }
  return undefined;
}

export interface AgentStatusPayload {
  agent_id: string;
  name: string;
  status: AgentStatus;
  parent_session_id: string;
  started_at: string;
  ended_at: string | null;
  turns: number;
  cost_usd: number | null;
  result_text: string | null;
  error_message: string | null;
  interrupt_kind: string | null;
  recent_events: Array<{ at: string; kind: string; fields?: Record<string, unknown> }>;
}

export interface ReadLogsArgs {
  /** When omitted, returns orchestrator-level logs. */
  agent_id?: string;
  tail?: number;
  offset?: number;
  event_type?: string;
  level?: "info" | "warn" | "error" | "debug";
}

export interface SystemLogPayload {
  source: "orchestrator" | "agent";
  agent_id: string | null;
  total: number;
  events: Array<{ at: string; kind: string; fields?: Record<string, unknown> }>;
}

export interface CostReport {
  orchestrator_session_id: string;
  orchestrator_cost_usd: number;
  subagents: Array<{
    agent_id: string;
    name: string;
    cost_usd: number | null;
    turns: number;
    status: AgentStatus;
  }>;
  aiws: Array<{
    aiw_id: string;
    workflow: string;
    cost_usd: number | null;
    status: string;
  }>;
  total_cost_usd: number;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ManagedAgent {
  state: AgentState;
  paths: AgentPaths;
  ac: AbortController;
  /** Resolved when the agent's session ends. */
  ended: Promise<void>;
  resolveEnded: () => void;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface AgentManagerOptions {
  configDir: string;
  cwd: string;
  runtime: AgentRuntime;
  registry: SubagentRegistry;
  orchestratorSessionId: string;
  config?: import("../types.ts").AgentifyConfig;
  /**
   * Per-event hook (used by the host to also stream to the
   * orchestrator's events.jsonl). Optional.
   */
  onAgentEvent?: (agentId: string, event: AgentSessionEvent) => void;
}

export class AgentManager {
  private readonly opts: AgentManagerOptions;
  private readonly agents = new Map<string, ManagedAgent>();
  /** Track orchestrator session id for cost reports. */
  private orchestratorCostUsd = 0;

  constructor(opts: AgentManagerOptions) {
    this.opts = opts;
  }

  // -------------------------------------------------------------------------
  // create_agent
  // -------------------------------------------------------------------------

  async createAgent(args: CreateAgentArgs): Promise<CreateAgentResult> {
    // Resolve template (if any). Template overrides system_prompt.
    let template: AgentDefinition | null = null;
    if (args.subagent_template) {
      template = this.opts.registry.get(args.subagent_template);
      if (!template) {
        throw new Error(
          `subagent_template "${args.subagent_template}" not found in registry. ` +
          `Known: ${this.opts.registry.list().map((a) => a.name).join(", ") || "(none)"}`,
        );
      }
    }

    // Compose system prompt: template body OR inline.
    const systemPrompt = args.system_prompt ?? template?.systemPrompt;
    if (!systemPrompt) {
      throw new Error(
        "create_agent requires either `system_prompt` or `subagent_template`",
      );
    }

    // Tools: explicit > template > default ['read'].
    const tools = args.tools && args.tools.length > 0
      ? args.tools
      : (template?.tools && template.tools.length > 0
          ? template.tools
          : ["read"]);

    // Cardinal rule: never allow create_agent in sub-agent tools.
    const filteredTools = tools.filter((t) => t !== "create_agent");

    // Model: explicit > template > inherit.
    const model = args.model ?? template?.model ?? "inherit";
    const thinkingLevel = args.thinking_level ?? null;
    // Slot role: explicit > template > inherit (null).
    const modelRole = args.modelRole ?? template?.modelRole ?? null;

    // Domain: explicit > template.
    const domain = args.domain ?? template?.domain ?? null;

    // Generate the agent_id.
    const agentId = generateAgentId(args.name);

    const initialState = makeQueuedAgentState({
      name: args.name,
      systemPrompt,
      userPrompt: args.user_prompt,
      tools: filteredTools,
      model,
      thinkingLevel,
      modelRole,
      parentSessionId: this.opts.orchestratorSessionId,
      subagentTemplate: args.subagent_template ?? template?.name ?? null,
      expertisePath: template?.expertise ?? null,
      domain,
      agentId,
    });

    const paths = agentPaths(this.opts.configDir, agentId);
    ensureAgentDirs(paths);
    writeAgentState(paths, initialState);
    writeAgentPrompt(paths, args.user_prompt);
    appendAgentExecutionLog(paths, `agent created (name=${args.name}, template=${args.subagent_template ?? "(none)"}, tools=${filteredTools.join(",")}, model=${model})`);

    // Persist event.
    appendAgentEvent(paths, { kind: "agent_created", fields: { name: args.name, tools: filteredTools, model } });

    // Mark as running + persist.
    const runningState = startAgent(initialState);
    writeAgentState(paths, runningState);

    // Spin up the runtime session.
    const ac = new AbortController();
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const managed: ManagedAgent = {
      state: runningState,
      paths,
      ac,
      ended,
      resolveEnded,
    };
    this.agents.set(agentId, managed);

    // Forward the session in the background; do NOT await. The
    // create_agent call returns immediately with status=running.
    void this.runAgent(managed, args.user_prompt).catch((err) => {
      // Surface the failure on the agent's state.
      const failed = failAgent(managed.state, (err as Error).message);
      writeAgentState(managed.paths, failed);
      appendAgentExecutionLog(managed.paths, `agent failed: ${(err as Error).message}`);
      managed.resolveEnded();
    });

    return {
      agent_id: agentId,
      name: args.name,
      status: runningState.status,
      started_at: runningState.started_at,
    };
  }

  // -------------------------------------------------------------------------
  // command_agent
  // -------------------------------------------------------------------------

  /**
   * Send a follow-up prompt to an existing agent. Currently this
   * implementation runs a *new* Pi session with the same system
   * prompt + the new user prompt. A future iteration could use
   * session.prompt() for in-place continuation; the current shape
   * mirrors the LESSONS' guidance that sub-agents are disposable
   * (one task, one session).
   */
  async commandAgent(args: CommandAgentArgs): Promise<CreateAgentResult> {
    const existing = this.agents.get(args.agent_id);
    if (!existing) {
      throw new Error(`command_agent: agent_id "${args.agent_id}" not found in live registry`);
    }
    if (existing.ac.signal.aborted) {
      throw new Error(`command_agent: agent ${args.agent_id} was aborted`);
    }

    // Record the command.
    appendAgentEvent(existing.paths, {
      kind: "command_received",
      fields: { prompt_preview: args.prompt.slice(0, 256) },
    });
    appendAgentExecutionLog(existing.paths, `command_agent: prompt="${args.prompt.slice(0, 80)}…"`);

    // Spawn a *new* session with the same config but new user prompt.
    // We record the result back to the existing agent's state.
    const newUserPrompt = args.prompt;
    writeAgentPrompt(existing.paths, newUserPrompt);

    void this.runAgent(existing, newUserPrompt).catch((err) => {
      const failed = failAgent(existing.state, (err as Error).message);
      writeAgentState(existing.paths, failed);
      appendAgentExecutionLog(existing.paths, `command_agent failed: ${(err as Error).message}`);
      existing.resolveEnded();
    });

    return {
      agent_id: existing.state.agent_id,
      name: existing.state.name,
      status: existing.state.status,
      started_at: existing.state.started_at,
    };
  }

  // -------------------------------------------------------------------------
  // delete_agent
  // -------------------------------------------------------------------------

  async deleteAgent(agentId: string, opts: { archive?: boolean } = {}): Promise<{ archived: boolean }> {
    const managed = this.agents.get(agentId);
    const paths = agentPaths(this.opts.configDir, agentId);

    // Soft-stop the session if live.
    if (managed) {
      managed.ac.abort();
      this.agents.delete(agentId);
    }

    const state = readAgentState(paths);
    const finalState = state
      ? deleteAgentState(state)
      : makeQueuedAgentState({
          name: agentId,
          systemPrompt: "",
          userPrompt: "",
          tools: [],
          parentSessionId: this.opts.orchestratorSessionId,
          agentId,
        });
    writeAgentState(paths, finalState);

    const archive = opts.archive !== false; // default true
    if (archive) {
      const archiveDir = path.join(this.opts.configDir, "orchestrator", "agents", "_archive", `${agentId}-${Date.now()}`);
      fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
      fs.renameSync(paths.agentRoot, archiveDir);
    } else {
      fs.rmSync(paths.agentRoot, { recursive: true, force: true });
    }

    return { archived: archive };
  }

  // -------------------------------------------------------------------------
  // interrupt_agent
  // -------------------------------------------------------------------------

  async interruptAgent(agentId: string, opts: { hard?: boolean } = {}): Promise<{ kind: "soft" | "hard" }> {
    const managed = this.agents.get(agentId);
    if (!managed) {
      throw new Error(`interrupt_agent: agent_id "${agentId}" not found in live registry`);
    }

    const kind: "soft" | "hard" = opts.hard === true ? "hard" : "soft";

    // Hard interrupt: force-abort the session immediately.
    if (kind === "hard") {
      managed.ac.abort();
    }
    // Soft interrupt: just signal the AbortController; the runtime
    // handles the in-flight turn (FakeRuntime flips `aborted` and
    // emits agent_end on the next tick).

    // Persist the state transition. For soft, we leave status=running
    // and add interrupt_kind=soft; the runtime flips it to
    // interrupted when the session actually ends. For hard, we
    // mark it immediately.
    const currentState = readAgentState(managed.paths) ?? managed.state;
    let nextState: AgentState;
    if (kind === "hard") {
      nextState = interruptAgent(currentState, "hard");
      managed.resolveEnded();
    } else {
      nextState = { ...currentState, interrupt_kind: "soft" };
    }
    writeAgentState(managed.paths, nextState);
    managed.state = nextState;
    appendAgentExecutionLog(managed.paths, `interrupt_agent (${kind})`);
    return { kind };
  }

  // -------------------------------------------------------------------------
  // list_agents
  // -------------------------------------------------------------------------

  listAgents(filter?: ListAgentsFilter): AgentState[] {
    // Live agents: from the in-memory map.
    const live = Array.from(this.agents.values()).map((m) => m.state);
    // Plus all on-disk states (covers agents that were running across
    // a previous orchestrator session).
    const onDisk: AgentState[] = [];
    const agentsRoot = path.join(this.opts.configDir, "orchestrator", "agents");
    if (fs.existsSync(agentsRoot)) {
      for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "_archive") continue;
        const s = readAgentState(agentPaths(this.opts.configDir, entry.name));
        if (s) onDisk.push(s);
      }
    }

    // Dedupe (live overrides on-disk).
    const map = new Map<string, AgentState>();
    for (const s of onDisk) map.set(s.agent_id, s);
    for (const s of live) map.set(s.agent_id, s);

    let states = Array.from(map.values());
    if (filter?.status && filter.status.length > 0) {
      const allowed = new Set(filter.status);
      states = states.filter((s) => allowed.has(s.status));
    }
    states.sort((a, b) => a.started_at.localeCompare(b.started_at));
    return states;
  }

  // -------------------------------------------------------------------------
  // check_agent_status
  // -------------------------------------------------------------------------

  checkAgentStatus(agentId: string, opts: { tail?: number; offset?: number } = {}): AgentStatusPayload {
    const paths = agentPaths(this.opts.configDir, agentId);
    const state = readAgentState(paths);
    if (!state) {
      throw new Error(`check_agent_status: agent_id "${agentId}" not found on disk`);
    }
    const eventsFile = paths.eventsFile;
    let events: Array<{ at: string; kind: string; fields?: Record<string, unknown> }> = [];
    if (fs.existsSync(eventsFile)) {
      const raw = fs.readFileSync(eventsFile, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as { at: string; kind: string; fields?: Record<string, unknown> });
        } catch {
          // skip malformed
        }
      }
    }
    if (opts.offset !== undefined && opts.offset > 0) {
      events = events.slice(opts.offset);
    }
    if (opts.tail !== undefined && opts.tail > 0) {
      events = events.slice(-opts.tail);
    }
    return {
      agent_id: state.agent_id,
      name: state.name,
      status: state.status,
      parent_session_id: state.parent_session_id,
      started_at: state.started_at,
      ended_at: state.ended_at,
      turns: state.turns,
      cost_usd: state.cost_usd,
      result_text: state.result_text,
      error_message: state.error_message,
      interrupt_kind: state.interrupt_kind,
      recent_events: events,
    };
  }

  // -------------------------------------------------------------------------
  // read_system_logs
  // -------------------------------------------------------------------------

  readSystemLogs(args: ReadLogsArgs): SystemLogPayload {
    const tail = args.tail ?? 50;
    const offset = args.offset ?? 0;

    let filePath: string;
    let source: "orchestrator" | "agent";
    let agentId: string | null = null;

    if (args.agent_id) {
      const paths = agentPaths(this.opts.configDir, args.agent_id);
      if (!fs.existsSync(paths.eventsFile)) {
        throw new Error(`read_system_logs: agent_id "${args.agent_id}" not found`);
      }
      filePath = paths.eventsFile;
      source = "agent";
      agentId = args.agent_id;
    } else {
      const orchestratorRoot = path.join(this.opts.configDir, "orchestrator");
      filePath = path.join(orchestratorRoot, "events.jsonl");
      source = "orchestrator";
    }

    let events: Array<{ at: string; kind: string; fields?: Record<string, unknown> }> = [];
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as { at: string; kind: string; fields?: Record<string, unknown> });
        } catch {
          // skip
        }
      }
    }

    // Filter by event_type if requested (substring on the kind field).
    if (args.event_type) {
      events = events.filter((e) => e.kind.includes(args.event_type!));
    }
    if (args.level) {
      events = events.filter((e) => {
        const level = (e.fields as Record<string, unknown> | undefined)?.["level"];
        return level === args.level;
      });
    }

    const total = events.length;
    if (offset > 0) events = events.slice(offset);
    if (tail > 0) events = events.slice(-tail);

    return { source, agent_id: agentId, total, events };
  }

  // -------------------------------------------------------------------------
  // report_cost
  // -------------------------------------------------------------------------

  /**
   * Build the cost report. Reads the orchestrator cost from the
   * in-memory accumulator + the cost.json snapshot; sums per-agent
   * and per-AIW costs from their on-disk state files.
   */
  reportCost(aiwCosts: Array<{ aiw_id: string; workflow: string; cost_usd: number | null; status: string }> = []): CostReport {
    const allAgents = this.listAgents();
    const subagents = allAgents.map((s) => ({
      agent_id: s.agent_id,
      name: s.name,
      cost_usd: s.cost_usd,
      turns: s.turns,
      status: s.status,
    }));
    const subagentSum = subagents.reduce((acc, a) => acc + (a.cost_usd ?? 0), 0);
    const aiwSum = aiwCosts.reduce((acc, a) => acc + (a.cost_usd ?? 0), 0);
    return {
      orchestrator_session_id: this.opts.orchestratorSessionId,
      orchestrator_cost_usd: this.orchestratorCostUsd,
      subagents,
      aiws: aiwCosts,
      total_cost_usd: this.orchestratorCostUsd + subagentSum + aiwSum,
    };
  }

  /** Called by the host on each orchestrator message_end. */
  recordOrchestratorCost(delta: number): void {
    this.orchestratorCostUsd += delta;
    const costPaths = orchestratorPaths(this.opts.configDir);
    const current = readCostRecord(costPaths);
    current.orchestrator_cost_usd = this.orchestratorCostUsd;
    const perAgentSum = Object.values(current.per_agent ?? {}).reduce((a, b) => a + b, 0);
    const perAiwSum = Object.values(current.per_aiw ?? {}).reduce((a, b) => a + b, 0);
    current.total_cost_usd = this.orchestratorCostUsd + perAgentSum + perAiwSum;
    writeCostRecord(costPaths, current);
  }

  /**
   * Await an agent's completion (resolves when `ended` resolves).
   * Used by the workflow composer to block on a sub-agent step.
   */
  async awaitAgentCompletion(agentId: string, timeoutMs = 5 * 60_000): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) {
      const paths = agentPaths(this.opts.configDir, agentId);
      const onDisk = readAgentState(paths);
      if (onDisk && isTerminal(onDisk)) return;
      throw new Error(`awaitAgentCompletion: agent '${agentId}' not found in live registry`);
    }
    if (isTerminal(managed.state)) return;
    await Promise.race([
      managed.ended,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  // -------------------------------------------------------------------------
  // shutdown (called by host)
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    // Soft-interrupt all live agents; mark state as interrupted.
    for (const managed of Array.from(this.agents.values())) {
      managed.ac.abort();
      const current = readAgentState(managed.paths) ?? managed.state;
      const interrupted = interruptAgent(current, "soft");
      writeAgentState(managed.paths, interrupted);
      managed.state = interrupted;
      appendAgentExecutionLog(managed.paths, `shutdown: soft-interrupted`);
      managed.resolveEnded();
    }
    this.agents.clear();
  }

  // -------------------------------------------------------------------------
  // Internal: run one Pi session for an agent
  // -------------------------------------------------------------------------

  private async runAgent(managed: ManagedAgent, userPrompt: string): Promise<void> {
    const state = managed.state;
    const sessionCwd = this.opts.cwd;

    // Append the start event.
    appendAgentEvent(managed.paths, { kind: "session_started", fields: { agent_id: state.agent_id } });

    // Resolve the model alias for the runtime (the runtime expects
    // a provider/model pair; tests pass a fake that ignores it).
    // Phase 3: overlay `state.model` (literal override),
    // `state.thinking_level`, and `state.model_role` (slot hint) on
    // top of the parent's config so sub-agents honor the per-agent
    // model the orchestrator captured at create_agent time.
    const parentConfig = (this.opts.config ?? {}) as import("../types.ts").AgentifyConfig;
    const agentOverride: Partial<import("../types.ts").AgentifyConfig> = {};
    if (state.model) agentOverride.model = state.model;
    if (state.thinking_level) agentOverride.thinkingLevel = normalizeThinking(state.thinking_level);
    const config: import("../types.ts").AgentifyConfig = {
      ...parentConfig,
      ...agentOverride,
    };
    const modelRole = normalizeModelRole(state.model_role);

    const hasWriteTools = state.tools.some((tool) =>
      tool === "write" || tool === "edit" || tool === "write_file" || tool === "multi_edit"
    );
    const executionPolicy = hasWriteTools || state.tools.includes("bash")
      ? createRepositoryWriteExecutionPolicy({
          cwd: sessionCwd,
          tools: state.tools,
          allowDevelopmentCommands: state.tools.includes("bash"),
        })
      : createReadOnlyExecutionPolicy({
          cwd: sessionCwd,
          mode: "review-readonly",
          tools: state.tools,
        });

    const result = await this.opts.runtime.runSession({
      cwd: sessionCwd,
      configDir: this.opts.configDir,
      config,
      ...(modelRole ? { modelRole } : {}),
      systemPrompt: state.system_prompt,
      userPrompt,
      tools: state.tools,
      executionPolicy,
      signal: managed.ac.signal,
      onEvent: (event) => this.handleAgentEvent(managed, event),
      agentDomain: state.domain,
    });

    appendAgentEvent(managed.paths, { kind: "session_ended", fields: { turns: result.turns, costUsd: result.costUsd, aborted: result.aborted } });

    // Update cost record for this agent.
    const costPaths = orchestratorPaths(this.opts.configDir);
    const costRecord = readCostRecord(costPaths);
    if (result.costUsd !== null) {
      costRecord.per_agent[managed.state.agent_id] = result.costUsd;
    }
    writeCostRecord(costPaths, costRecord);

    // Persist terminal state.
    const current = readAgentState(managed.paths) ?? managed.state;
    let next: AgentState;
    if (current.status === AgentStatusConst.Interrupted) {
      // Already marked interrupted; keep the state but refresh ended_at.
      next = { ...current, ended_at: new Date().toISOString() };
    } else if (current.interrupt_kind !== null) {
      // A soft interrupt was requested. Even if the runtime finished
      // naturally, we mark it as interrupted (the orchestrator's
      // intent was to stop the work).
      next = interruptAgent(current, current.interrupt_kind as "soft" | "hard");
    } else if (result.aborted) {
      next = abortAgent(current);
    } else {
      next = completeAgent(current, {
        turns: result.turns,
        costUsd: result.costUsd,
        resultText: managed.state.result_text,
      });
    }
    writeAgentState(managed.paths, next);
    managed.state = next;

    appendAgentExecutionLog(managed.paths, `session ended (turns=${result.turns}, cost=${result.costUsd ?? "?"}, aborted=${result.aborted})`);

    // Release the command_agent waiter.
    managed.resolveEnded();
  }

  // -------------------------------------------------------------------------
  // Internal: per-event handler
  // -------------------------------------------------------------------------

  private handleAgentEvent(managed: ManagedAgent, event: AgentSessionEvent): void {
    this.opts.onAgentEvent?.(managed.state.agent_id, event);

    const e = event as unknown as Record<string, unknown>;
    const type = (e["type"] as string | undefined) ?? null;
    if (!type) return;

    // Append a compact summary to events.jsonl.
    if (type === "tool_execution_start") {
      const toolName = (e["toolName"] as string | undefined) ?? (e["tool_name"] as string | undefined) ?? "unknown";
      // For write-like tools, capture the path so the auto-improve
      // scheduler (auto-improve) can resolve which experts the agent
      // touched. Mirrors the defense hook's path-param coverage so the
      // model can't slip a path past us via an alternate key.
      const fields: Record<string, unknown> = { tool_name: toolName };
      const writeLike = toolName === "write" || toolName === "edit" || toolName === "write_file" || toolName === "multi_edit" || toolName === "create_file" || toolName === "patch";
      if (writeLike) {
        const input = e["input"] as Record<string, unknown> | undefined;
        const candidates = ["path", "filePath", "file_path", "filepath", "filename", "file"];
        for (const key of candidates) {
          const v = input?.[key];
          if (typeof v === "string" && v.length > 0) {
            fields["path"] = v;
            break;
          }
        }
      }
      appendAgentEvent(managed.paths, {
        kind: "tool_execution_start",
        fields,
      });
    } else if (type === "message_end") {
      const message = (e["message"] as Record<string, unknown> | undefined) ?? {};
      const usage = (message["usage"] as Record<string, unknown> | undefined) ?? {};
      const cost = (usage["cost"] as Record<string, unknown> | undefined) ?? {};
      const costTotal = typeof cost["total"] === "number" ? (cost["total"] as number) : null;
      appendAgentEvent(managed.paths, {
        kind: "message_end",
        fields: { cost_usd: costTotal },
      });

      // Update in-memory + on-disk state with running cost/turns.
      const current = managed.state;
      const newCost = costTotal !== null
        ? ((current.cost_usd ?? 0) + costTotal)
        : current.cost_usd;
      const newTurns = current.turns + 1;
      const updated = updateAgent(current, { cost_usd: newCost, turns: newTurns });
      managed.state = updated;
      // Skip state write for performance; the next transition writes.
    } else if (type === "text_delta") {
      const delta = (e["delta"] as string | undefined) ?? "";
      const current = managed.state;
      const nextText = (current.result_text ?? "") + delta;
      managed.state = updateAgent(current, { result_text: nextText });
    }
  }
}