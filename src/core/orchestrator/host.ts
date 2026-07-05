// host.ts — the OrchestratorHost: the seam between the orchestrator
// module and the standalone CLI daemon.
//
// The host owns:
//
//   - The orchestrator's Pi session (via runtime.runSession).
//   - The AgentManager (sub-agent CRUD).
//   - The AiwBridge (AIW CRUD).
//   - The SubagentRegistry (template discovery).
//   - The orchestrator's system prompt (rendered at boot with the
//     6 substitutions).
//   - The 10 management tools (customTools passed to the session).
//
// `chat(prompt)` pipes one user message into the orchestrator
// session and awaits agent_end. The session persists across
// messages (Pi's session manager handles compaction).
//
// `shutdown()` aborts the orchestrator session, soft-interrupts
// all live agents, and writes a final session record.

import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, AgentRuntimeSessionOptions, AgentifyConfig } from "../types.ts";
import { AgentManager } from "./agent-manager.ts";
import { AiwBridge } from "./aiw-bridge.ts";
import { SubagentRegistry } from "./subagent-registry.ts";
import { createManagementTools, MANAGEMENT_TOOL_NAMES } from "./tools/index.ts";
import {
  renderOrchestratorPrompt,
  DEFAULT_AIW_TYPES,
} from "./orchestrator-prompt.ts";
import {
  appendOrchestratorEvent,
  appendOrchestratorExecutionLog,
  ensureOrchestratorDirs,
  listAgentDirs,
  orchestratorPaths,
  readAgentState,
  readOrchestratorSession,
  writeOrchestratorSession,
  listOpenEscalations,
} from "./paths.ts";
import { WorkflowRegistry } from "./workflow-registry.ts";
import { startWorkflowRunner } from "./workflow-runner.ts";
import { AutoImproveScheduler } from "./auto-improve.ts";

export interface OrchestratorHostOptions {
  configDir: string;
  cwd: string;
  runtime: AgentRuntime;
  config?: AgentifyConfig;
  /**
   * For tests; default false. When true, does not actually start
   * the orchestrator session; just wires the host.
   */
  noBoot?: boolean;
}

export interface OrchestratorStatus {
  session_id: string;
  started_at: string;
  cwd: string;
  config_dir: string;
  live_agents: number;
  live_aiws: number;
}

export interface OrchestratorReply {
  text: string;
  turns: number;
  cost_usd: number | null;
  spawned_agents: string[];
  spawned_aiws: string[];
  aborted: boolean;
}

export class OrchestratorHost {
  readonly sessionId: string;
  readonly configDir: string;
  readonly cwd: string;
  private readonly runtime: AgentRuntime;
  private readonly registry: SubagentRegistry;
  private readonly workflowRegistry: WorkflowRegistry;
  private readonly workflowRunner: ReturnType<typeof startWorkflowRunner>;
  private readonly config: AgentifyConfig;
  private readonly agentManager: AgentManager;
  private readonly aiwBridge: AiwBridge;
  private readonly tools: ReturnType<typeof createManagementTools>;
  private readonly orchPaths: ReturnType<typeof orchestratorPaths>;
  /** auto-improve: orchestrator-side auto-LEARN scheduler. */
  private readonly autoImprove: AutoImproveScheduler;
  private started = false;
  private orchestratorAc = new AbortController();
  private orchestratorCostUsd = 0;
  private orchestratorTurns = 0;
  private lastReplyText = "";

  constructor(opts: OrchestratorHostOptions) {
    this.configDir = opts.configDir;
    this.cwd = opts.cwd;
    this.runtime = opts.runtime;
    this.config = opts.config ?? {};
    this.orchPaths = orchestratorPaths(opts.configDir);

    // Reuse an existing session id if one was written by a previous
    // boot (e.g., daemon resume).
    const existing = readOrchestratorSession(this.orchPaths);
    this.sessionId = existing?.session_id ?? generateOrchestratorSessionId();

    // Pre-create the orchestrator directories.
    ensureOrchestratorDirs(this.orchPaths);

    // Sub-agent registry.
    this.registry = SubagentRegistry.fromCwd(opts.cwd, opts.configDir);

    // Workflow registry (orchestrator workflows).
    this.workflowRegistry = WorkflowRegistry.fromCwd(opts.cwd, opts.configDir);

    // Agent manager.
    this.agentManager = new AgentManager({
      configDir: opts.configDir,
      cwd: opts.cwd,
      runtime: opts.runtime,
      registry: this.registry,
      orchestratorSessionId: this.sessionId,
      config: opts.config,
      onAgentEvent: (agentId, event) => this.handleAgentEvent(agentId, event),
    });

    // AIW bridge.
    this.aiwBridge = new AiwBridge({
      configDir: opts.configDir,
      cwd: opts.cwd,
      noWorktree: true,
    });

    // Workflow runner (orchestrator workflows).
    this.workflowRunner = startWorkflowRunner({
      configDir: opts.configDir,
      cwd: opts.cwd,
      agentManager: this.agentManager,
      aiwBridge: this.aiwBridge,
    });

    // Tools.
    this.tools = createManagementTools({
      agentManager: this.agentManager,
      aiwBridge: this.aiwBridge,
      workflowRegistry: this.workflowRegistry,
      workflowRunner: this.workflowRunner,
      configDir: opts.configDir,
      projectWorkflowsDir: this.workflowRegistry.projectWorkflowsDir,
    });

    // auto-improve: auto-LEARN scheduler. Fires on every
    // agent_end with an expertise_path.
    this.autoImprove = new AutoImproveScheduler({
      configDir: opts.configDir,
      cwd: opts.cwd,
    });
  }

  /**
   * Boot the orchestrator session. Writes the session record and
   * logs. Does NOT actually start the Pi session — that happens
   * on the first `chat()` call.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    writeOrchestratorSession(this.orchPaths, {
      session_id: this.sessionId,
      started_at: new Date().toISOString(),
      cwd: this.cwd,
    });
    appendOrchestratorEvent(this.orchPaths, {
      kind: "orchestrator_started",
      fields: {
        session_id: this.sessionId,
        cwd: this.cwd,
        tools: [...MANAGEMENT_TOOL_NAMES],
      },
    });
    appendOrchestratorExecutionLog(
      this.orchPaths,
      `orchestrator started: session=${this.sessionId}, cwd=${this.cwd}`,
    );
  }

  /**
   * Send a prompt to the orchestrator session. Returns the
   * orchestrator's final reply text, accumulated cost, and any
   * sub-agents / AIWs that were spawned during this turn.
   *
   * The orchestrator's session is **one long-lived session** that
   * grows with each user message. We do NOT recreate it per chat.
   */
  async chat(userPrompt: string): Promise<OrchestratorReply> {
    if (!this.started) this.start();

    // Snapshot the fleet BEFORE the chat (to compute deltas).
    const agentsBefore = new Set(this.agentManager.listAgents().map((s) => s.agent_id));
    const aiwsBefore = new Set(this.aiwBridge.listAllAiw().map((s) => s.aiw_id));

    appendOrchestratorEvent(this.orchPaths, {
      kind: "chat_received",
      fields: { prompt_preview: userPrompt.slice(0, 256) },
    });

    // Render the system prompt with the live snapshot.
    const liveAgentsMarkdown = this.formatLiveAgentsForPrompt();
    const openEscalations = listOpenEscalations(this.configDir);
    const escalationsMarkdown = openEscalations.length === 0
      ? "(no open escalations)"
      : openEscalations.map((t) =>
          `| \`${t.ticket_id}\` | ${t.agent_name} (${t.agent_id}) | ${truncate(t.reason, 60)} | ${truncate(t.question, 80)} |`
        ).join("\n");
    const liveWorkflowsMarkdown = this.formatLiveWorkflowsForPrompt();
    const systemPrompt = renderOrchestratorPrompt({
      subagentRegistryMarkdown: this.registry.formatForPrompt(),
      workflowRegistryMarkdown: this.workflowRegistry.formatForPrompt(),
      availableAiwTypes: DEFAULT_AIW_TYPES,
      sessionDir: this.orchPaths.orchestratorRoot,
      conversationLog: this.orchPaths.eventsFile,
      parentSessionId: this.sessionId,
      activeAgentsMarkdown: liveAgentsMarkdown,
      openEscalationsMarkdown: escalationsMarkdown,
      liveWorkflowsMarkdown,
    });

    // Build session options. tools: [] (no Pi built-ins).
    // customTools: the 10 management tools.
    const sessionOptions: AgentRuntimeSessionOptions = {
      cwd: this.cwd,
      configDir: this.configDir,
      config: this.config,
      systemPrompt,
      userPrompt,
      tools: [], // cardinal rule: no Pi built-ins.
      customTools: this.tools,
      signal: this.orchestratorAc.signal,
      onEvent: (e) => this.handleOrchestratorEvent(e),
    };

    const result = await this.runtime.runSession(sessionOptions);

    appendOrchestratorEvent(this.orchPaths, {
      kind: "chat_ended",
      fields: { turns: result.turns, costUsd: result.costUsd, aborted: result.aborted },
    });

    // Compute deltas (agents/AIWs spawned this turn).
    const agentsAfter = new Set(this.agentManager.listAgents().map((s) => s.agent_id));
    const aiwsAfter = new Set(this.aiwBridge.listAllAiw().map((s) => s.aiw_id));
    const spawnedAgents: string[] = [];
    for (const id of agentsAfter) if (!agentsBefore.has(id)) spawnedAgents.push(id);
    const spawnedAiw: string[] = [];
    for (const id of aiwsAfter) if (!aiwsBefore.has(id)) spawnedAiw.push(id);

    return {
      text: this.lastReplyText,
      turns: result.turns,
      cost_usd: result.costUsd,
      spawned_agents: spawnedAgents,
      spawned_aiws: spawnedAiw,
      aborted: result.aborted,
    };
  }

  private formatLiveWorkflowsForPrompt(): string {
    const runs = this.workflowRunner.list();
    const live = runs.filter((r) => r.status === "running" || r.status === "queued" || r.status === "paused_for_domain_fix");
    if (live.length === 0) return "(no live workflows)";
    return live.map((r) => {
      return `| \`${r.workflow_run_id}\` | ${r.workflow_name} | ${r.status} | $${r.cost_usd.toFixed(4)} |`;
    }).join("\n");
  }

  /**
   * Snapshot of the current state.
   */
  status(): OrchestratorStatus {
    return {
      session_id: this.sessionId,
      started_at: this.started ? new Date().toISOString() : "",
      cwd: this.cwd,
      config_dir: this.configDir,
      live_agents: this.agentManager.listAgents({ status: ["running", "queued"] }).length,
      live_aiws: this.aiwBridge.listLiveAiw().length,
    };
  }

  /**
   * Abort the orchestrator session, soft-interrupt all live
   * agents, and write a final session record. After shutdown,
   * the host cannot be reused.
   */
  async shutdown(): Promise<void> {
    appendOrchestratorExecutionLog(this.orchPaths, "shutdown requested");
    this.orchestratorAc.abort();
    await this.agentManager.shutdown();
    // auto-improve: drain any pending auto-LEARN jobs before exit.
    await this.autoImprove.drain();
    appendOrchestratorEvent(this.orchPaths, {
      kind: "orchestrator_shutdown",
      fields: { orchestrator_cost_usd: this.orchestratorCostUsd },
    });
    appendOrchestratorExecutionLog(
      this.orchPaths,
      `shutdown complete: cost=$${this.orchestratorCostUsd.toFixed(4)}`,
    );
  }

  /**
   * Return the AgentManager (for read-only inspection by the CLI).
   */
  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  /**
   * Return the AiwBridge (for read-only inspection by the CLI).
   */
  getAiwBridge(): AiwBridge {
    return this.aiwBridge;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private handleOrchestratorEvent(event: AgentSessionEvent): void {
    const e = event as unknown as Record<string, unknown>;
    const type = (e["type"] as string | undefined) ?? null;
    if (!type) return;

    if (type === "message_end") {
      const message = (e["message"] as Record<string, unknown> | undefined) ?? {};
      const usage = (message["usage"] as Record<string, unknown> | undefined) ?? {};
      const cost = (usage["cost"] as Record<string, unknown> | undefined) ?? {};
      const costTotal = typeof cost["total"] === "number" ? (cost["total"] as number) : null;
      if (costTotal !== null) {
        this.orchestratorCostUsd += costTotal;
        this.agentManager.recordOrchestratorCost(costTotal);
      }
      this.orchestratorTurns += 1;
    } else if (type === "text_delta") {
      const delta = (e["delta"] as string | undefined) ?? "";
      this.lastReplyText += delta;
    }
  }

  private handleAgentEvent(agentId: string, event: AgentSessionEvent): void {
    // Forward to orchestrator-level events.jsonl for cross-cutting
    // observability. The agent's own events.jsonl is also written
    // by the AgentManager.
    const e = event as unknown as Record<string, unknown>;
    const type = (e["type"] as string | undefined) ?? null;
    if (!type) return;
    appendOrchestratorEvent(this.orchPaths, {
      kind: "agent_event",
      fields: { agent_id: agentId, event_type: type },
    });
    // auto-improve: on agent_end, fire the auto-LEARN scheduler.
    // The scheduler reads the agent's state.json + events.jsonl
    // and runs `runSelfImprove` for any matching expert. The
    // scheduler is fire-and-forget here (it manages its own
    // per-domain serialization + locks); we do not block the
    // orchestrator's main event loop.
    if (type === "agent_end") {
      void this.autoImprove.onAgentEnd(agentId).catch((err) => {
        appendOrchestratorEvent(this.orchPaths, {
          kind: "auto_improve_error",
          fields: { agent_id: agentId, error: (err as Error).message },
        });
      });
    }
  }

  private formatLiveAgentsForPrompt(): string {
    const live = this.agentManager.listAgents({ status: ["running", "queued"] });
    if (live.length === 0) return "(no live agents)";
    return live.map((s) => {
      return `| \`${s.agent_id}\` | ${s.name} | ${s.status} | turns=${s.turns} | $${(s.cost_usd ?? 0).toFixed(4)} |`;
    }).join("\n");
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function generateOrchestratorSessionId(): string {
  return `orch-${randomBytes(8).toString("hex")}`;
}
