// worker.ts — Class 4 G4: a domain-locked orchestrator worker.
//
// A worker is a long-running subprocess that:
//   1. Boots an OrchestratorHost (the same engine the parent uses)
//   2. Registers as a peer in the local Coms mesh with fixed domain
//      globs (e.g. "src/core/webhook/**")
//   3. Listens for `create_agent` commands from the parent orchestrator
//      via the peer mesh (Stage 2)
//   4. Executes them locally via the AgentManager
//   5. Returns the agent_id back to the parent
//
// Workers are the simplest form of multi-process orchestrator. They
// share the project's filesystem but constrain their writes via
// the defense hook (Layer E domain lock in `src/core/audit/defense-hook.ts`).
//
// Source of truth:
//   - principles/08-multi-agent.md § "Domain Locking"
//
// The worker uses the ComsPeer (Stage 2) for inter-process
// communication. The protocol is a thin JSON-encoded envelope
// wrapped in a `worker:command` prefix on the peer-mesh body:
//
//   { "op": "create_agent", "args": {...} }     -> { "agent_id": "..." }
//   { "op": "list_agents",  "args": {} }        -> { "agents": [...] }
//   { "op": "check_agent_status", "args": {...} } -> { ... }
//   { "op": "ping",         "args": {} }        -> { "pong": true, ... }
//
// The worker's ComsPeer listens on a Unix socket; the parent's
// orchestrator discovers the worker via the file registry.

import { OrchestratorHost } from "./host.ts";
import { ComsPeer } from "./comms/server.ts";
import { AgentManager } from "./agent-manager.ts";
import type { AgentRuntime } from "../types.ts";
import { PiSdkRuntime } from "../pi-sdk-runtime.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkerOptions {
  configDir: string;
  cwd: string;
  /** Comma-separated domain globs (e.g. "src/core/webhook/**,tests/webhook/**"). */
  domain: string[];
  /** Peer name. Default: `worker-<random>`. */
  name?: string;
  /** Coms root. Default: ~/.pi/coms. */
  comsRoot?: string;
  /** Override the runtime (for tests). */
  runtime?: AgentRuntime;
}

// ---------------------------------------------------------------------------
// Protocol envelope
// ---------------------------------------------------------------------------

interface CommandEnvelope {
  op: "create_agent" | "list_agents" | "check_agent_status" | "ping";
  args: Record<string, unknown>;
  /** msg_id echoed in the response for tracing. */
  msg_id?: string;
}

interface ResponseEnvelope {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export class OrchestratorWorker {
  readonly host: OrchestratorHost;
  readonly peer: ComsPeer;
  private readonly agentManager: AgentManager;
  private readonly domainGlobs: string[];
  private closed = false;

  constructor(opts: WorkerOptions) {
    const runtime: AgentRuntime = opts.runtime ?? new PiSdkRuntime();
    this.host = new OrchestratorHost({
      configDir: opts.configDir,
      cwd: opts.cwd,
      runtime,
    });
    // Use the host's agentManager (exposed via getter).
    this.agentManager = this.host.getAgentManager();
    this.domainGlobs = opts.domain;
    const peerName = opts.name ?? `worker-${randomShortId()}`;
    this.peer = new ComsPeer({
      name: peerName,
      cwd: opts.cwd,
      purpose: `domain-locked worker: ${opts.domain.join(", ")}`,
      color: "#FF7EDB",
      ...(opts.comsRoot ? { comsRoot: opts.comsRoot } : {}),
    });
  }

  /** Start the worker: register as a peer + listen for commands. */
  async start(): Promise<void> {
    await this.peer.listen();
    this.peer.on("prompt", (env) => {
      void this.handleCommand(env.body, env.msg_id, env.sender);
    });
  }

  /** Stop the worker: deregister + close. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.peer.close(); } catch { /* ignore */ }
    try { await this.host.shutdown(); } catch { /* ignore */ }
  }

  /** The domain globs this worker is constrained to. */
  get domain(): string[] {
    return this.domainGlobs;
  }

  /**
   * Route a `create_agent` command. The worker creates a local
   * sub-agent (respecting the domain lock via the defense hook) and
   * returns the agent_id.
   *
   * Public so tests can invoke directly without going through
   * the peer mesh.
   */
  async routeCreateAgent(args: Record<string, unknown>): Promise<{ agent_id: string; name: string; status: string; started_at: string }> {
    // Inject domain so the sub-agent state carries it. The defense hook
    // reads AgentState.domain and blocks writes outside the globs.
    const argsWithDomain = {
      ...args,
      domain: this.domainGlobs,
    };
    return this.agentManager.createAgent(argsWithDomain as Parameters<typeof this.agentManager.createAgent>[0]);
  }

  /** Route `list_agents`. */
  routeListAgents(): { agents: Array<{ agent_id: string; name: string; status: string }> } {
    const agents = this.agentManager.listAgents().map((s) => ({
      agent_id: s.agent_id,
      name: s.name,
      status: s.status,
    }));
    return { agents };
  }

  /** Route `check_agent_status`. */
  routeCheckAgentStatus(args: Record<string, unknown>): unknown {
    const agentId = args["agent_id"] as string;
    if (!agentId) {
      throw new Error("check_agent_status: agent_id is required");
    }
    return this.agentManager.checkAgentStatus(agentId);
  }

  /** Route `ping` (liveness). */
  routePing(): { pong: true; name: string; domain: string[]; pid: number } {
    return { pong: true, name: this.peer.name, domain: this.domainGlobs, pid: process.pid };
  }

  // -------------------------------------------------------------------------
  // Internal: handle an inbound command via peer mesh
  // -------------------------------------------------------------------------

  private async handleCommand(body: string, msgId: string, _sender: string): Promise<void> {
    let cmd: CommandEnvelope;
    try {
      cmd = JSON.parse(body) as CommandEnvelope;
    } catch (err) {
      await this.peer.fail(msgId, "invalid_envelope", `worker: invalid JSON envelope: ${(err as Error).message}`);
      return;
    }
    try {
      let result: unknown;
      switch (cmd.op) {
        case "create_agent":
          result = await this.routeCreateAgent(cmd.args);
          break;
        case "list_agents":
          result = this.routeListAgents();
          break;
        case "check_agent_status":
          result = this.routeCheckAgentStatus(cmd.args);
          break;
        case "ping":
          result = this.routePing();
          break;
        default:
          await this.peer.fail(msgId, "invalid_envelope", `worker: unknown op: ${(cmd as { op: string }).op}`);
          return;
      }
      const resp: ResponseEnvelope = { ok: true, result };
      await this.peer.reply(msgId, JSON.stringify(resp));
    } catch (err) {
      const resp: ResponseEnvelope = { ok: false, error: (err as Error).message };
      try {
        await this.peer.reply(msgId, JSON.stringify(resp));
      } catch {
        // Best-effort.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomShortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
