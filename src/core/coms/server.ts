// coms/server.ts — the unified ComsPeer (one socket per peer).
//
// One ComsPeer per Pi session. The peer's single Unix socket
// handles BOTH inbound prompts (server role) AND inbound
// responses (client role). This is the canonical Pi-to-Pi
// architecture: each peer has exactly one socket, and the
// dispatcher routes envelopes to the right consumer.
//
// Public methods (the "4-tool surface" — LEARNINGS3.md § 11.4):
//   - listen(): start the socket + register in the peer registry
//   - close(): stop + deregister
//   - list(): live peers in the project
//   - send(target, body, opts?): enqueue a prompt; returns the
//     PendingMessage (status=pending). Use `await(msg_id)` to block.
//   - get(msg_id): non-blocking poll on a pending message
//   - await(msg_id, timeoutMs?): block until response / error
//   - reply(msg_id, body, opts?): send a response envelope back
//     to the original sender (called by the host extension on
//     agent_end)
//   - fail(msg_id, code, error): send an error envelope back
//   - setContextUsedPct(pct): update the advertised context usage
//
// Public events (for the host extension):
//   - 'prompt' — a PromptEnvelope arrived; the host must call
//     reply() or fail() to clear it
//   - 'closed' — server is fully closed
//   - 'error'  — internal error
//
// Source of truth:
//   - LESSONS/PI_MASTERY.md § 11.7
//   - principles/08-multi-agent.md § "Pattern 3"
//   - principles/15-anti-patterns.md § "Multi-Agent Anti-Patterns"
//     (the cardinal reply-by-assistant-message rule)

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { PeerRegistry } from "./registry.ts";
import {
  DEFAULT_AWAIT_TIMEOUT_MS,
  DEFAULT_COMS_ROOT,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_HOPS,
  DEFAULT_SOCKET_TIMEOUT_MS,
  type ComsEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
  type PeerEntry,
  type PendingMessage,
  type PromptEnvelope,
  type ResponseEnvelope,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public events
// ---------------------------------------------------------------------------

export interface ComsPeerEvents {
  /** A prompt envelope was received. The host must call reply()
   *  or fail() to clear it. */
  prompt: (env: PromptEnvelope) => void;
  /** A response envelope was sent back to the original sender. */
  response_sent: (env: ResponseEnvelope) => void;
  /** An error envelope was sent back (hop limit, etc.). */
  error_sent: (env: ErrorEnvelope) => void;
  /** Peer has finished `close()`. */
  closed: () => void;
  /** Unexpected error. */
  error: (err: Error) => void;
}

export declare interface ComsPeer {
  on<U extends keyof ComsPeerEvents>(event: U, listener: ComsPeerEvents[U]): this;
  emit<U extends keyof ComsPeerEvents>(event: U, ...args: Parameters<ComsPeerEvents[U]>): boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ComsPeerOptions {
  /** Logical peer name (the registry key). */
  name: string;
  /** Project hash; defaults to projectHash(cwd). */
  project?: string;
  /** Cwd the peer is operating in. */
  cwd: string;
  /** Purpose / description for the pool widget. */
  purpose?: string;
  /** Color for the pool widget. */
  color?: string;
  /** Coms root. Default ~/.pi/coms. */
  comsRoot?: string;
  /** Heartbeat interval (default 30s). */
  heartbeatMs?: number;
  /** Max hops for incoming/outgoing prompts (default 5). */
  maxHops?: number;
  /** Socket connect + send timeout (default 5s). */
  socketTimeoutMs?: number;
  /** Initial context usage 0-100. */
  contextUsedPct?: number;
  /** Override session id (for deterministic test paths). */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ComsPeer extends EventEmitter {
  readonly name: string;
  readonly cwd: string;
  readonly purpose: string;
  readonly color: string;
  readonly project: string;
  readonly comsRoot: string;
  readonly socketPath: string;
  readonly maxHops: number;
  readonly socketTimeoutMs: number;
  readonly sessionId: string;

  private readonly registry: PeerRegistry;
  private server: net.Server | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private listening = false;
  private closed = false;
  private contextUsedPct: number;
  /** Inbound prompts awaiting reply. */
  private readonly inFlight = new Map<string, InFlight>();
  /** Outbound prompts awaiting response. */
  private readonly pending = new Map<string, Pending>();
  /** Waiters: msg_id -> Set of resolvers to call on response/error. */
  private readonly waiters = new Map<string, Set<(p: PendingMessage) => void>>();

  constructor(opts: ComsPeerOptions) {
    super();
    if (!opts.name || opts.name.length === 0) {
      throw new Error("ComsPeer: name is required");
    }
    this.name = opts.name;
    this.cwd = opts.cwd;
    this.purpose = opts.purpose ?? "";
    this.color = opts.color ?? "#36F9F6";
    this.comsRoot = expandHome(opts.comsRoot ?? DEFAULT_COMS_ROOT);
    this.project = opts.project ?? requireProjectHash(this.cwd);
    this.sessionId = opts.sessionId ?? generateSessionId();
    this.socketPath = path.join(this.comsRoot, "sockets", `${this.sessionId}.sock`);
    this.maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
    this.socketTimeoutMs = opts.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
    this.contextUsedPct = opts.contextUsedPct ?? 0;

    this.registry = new PeerRegistry({
      registryDir: this.comsRoot,
      project: this.project,
    });
  }

  /**
   * Bind the Unix socket, register in the peer registry, start
   * heartbeat. Idempotent.
   */
  async listen(): Promise<void> {
    if (this.listening) return;
    if (this.closed) throw new Error("ComsPeer: cannot listen() after close()");

    await unlinkStaleSocket(this.socketPath);
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });

    this.server = net.createServer((conn) => this.handleConnection(conn));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    this.listening = true;

    this.upsertRegistry();

    const hbMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = setInterval(() => {
      try {
        this.upsertRegistry();
      } catch (err) {
        this.emit("error", err as Error);
      }
    }, hbMs);
    this.heartbeatTimer.unref();
  }

  /**
   * The 4-tool surface.
   */

  /** coms_list: live peers. */
  list(): PeerEntry[] {
    return this.registry.list().live;
  }

  /**
   * coms_send: enqueue a prompt. Returns immediately with the
   * pending entry. Caller awaits with `await(msg_id)`.
   */
  send(
    target: string,
    body: string,
    opts: { conversationId?: string; hops?: number } = {},
  ): PendingMessage {
    if (target === this.name) {
      throw new Error(`coms_send: cannot send to self (${this.name})`);
    }
    if (typeof body !== "string" || body.length === 0) {
      throw new Error("coms_send: body must be a non-empty string");
    }
    const hops = opts.hops ?? 0;
    if (hops > this.maxHops) {
      throw new Error(`coms_send: hops (${hops}) exceeds max (${this.maxHops})`);
    }
    const peer = this.registry.get(target);
    if (!peer) {
      throw new Error(`coms_send: target "${target}" not found in registry`);
    }
    const msgId = generateMsgId();
    const env: PromptEnvelope = {
      type: "prompt",
      msg_id: msgId,
      sender: this.name,
      target,
      body,
      ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
      hops,
      ts: new Date().toISOString(),
    };

    const pending: PendingMessage = {
      msg_id: msgId,
      sender: this.name,
      target,
      body,
      ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
      hops,
      status: "pending",
      queued_at: new Date().toISOString(),
    };
    const entry: Pending = {
      pending,
    };
    this.pending.set(msgId, entry);

    void this.deliverPrompt(env, peer.socketPath, peer.pid, msgId).catch(() => {
      // delivery_failed already recorded in deliverPrompt(); suppress.
    });

    return pending;
  }

  /** coms_get: non-blocking status poll. */
  get(msgId: string): PendingMessage | null {
    const entry = this.pending.get(msgId);
    if (!entry) return null;
    return entry.pending;
  }

  /**
   * coms_await: block until the response arrives (or timeout).
   * Safe to call multiple times on the same msg_id (each caller
   * gets its own resolution).
   */
  async await(msgId: string, timeoutMs = DEFAULT_AWAIT_TIMEOUT_MS): Promise<PendingMessage> {
    const entry = this.pending.get(msgId);
    if (!entry) {
      throw new Error(`coms_await: unknown msg_id "${msgId}"`);
    }
    // Fast-path: already resolved.
    if (entry.pending.status === "complete" || entry.pending.status === "error" || entry.pending.status === "timeout") {
      return entry.pending;
    }
    return new Promise<PendingMessage>((resolve) => {
      // Register a waiter.
      let waiterSet = this.waiters.get(msgId);
      if (!waiterSet) {
        waiterSet = new Set();
        this.waiters.set(msgId, waiterSet);
      }
      const waiter = (pending: PendingMessage): void => {
        clearTimeout(timer);
        resolve(pending);
      };
      waiterSet.add(waiter);

      // Timeout.
      const timer = setTimeout(() => {
        // Promote pending to timeout.
        const e = this.pending.get(msgId);
        if (e && (e.pending.status === "pending" || e.pending.status === "delivered")) {
          e.pending.status = "timeout";
          e.pending.error = `coms_await timed out after ${timeoutMs}ms`;
          e.pending.errorCode = "timeout";
          e.pending.completed_at = new Date().toISOString();
        }
        const waiters = this.waiters.get(msgId);
        if (waiters) {
          for (const w of waiters) {
            try { w(this.pending.get(msgId)?.pending ?? { msg_id: msgId, sender: this.name, target: "", body: "", hops: 0, status: "timeout", queued_at: new Date().toISOString() }); } catch { /* ignore */ }
          }
          this.waiters.delete(msgId);
        }
      }, timeoutMs);
      timer.unref();

      // Re-check status (covers the race where the response arrived
      // between the fast-path check and registering the waiter).
      const e2 = this.pending.get(msgId);
      if (e2 && (e2.pending.status === "complete" || e2.pending.status === "error" || e2.pending.status === "timeout")) {
        clearTimeout(timer);
        const waiters = this.waiters.get(msgId);
        if (waiters) {
          waiters.delete(waiter);
          if (waiters.size === 0) this.waiters.delete(msgId);
        }
        resolve(e2.pending);
      }
    });
  }

  /**
   * Send a response envelope back to the original sender. Called
   * by the host extension on `agent_end` of the receiver's session.
   */
  async reply(msgId: string, body: string, opts: { conversationId?: string; aborted?: boolean } = {}): Promise<void> {
    const inflight = this.inFlight.get(msgId);
    if (!inflight) {
      throw new Error(`ComsPeer.reply: unknown msg_id "${msgId}"`);
    }
    const env: ResponseEnvelope = {
      type: "response",
      msg_id: msgId,
      sender: this.name,
      target: inflight.sender,
      body,
      ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
      hops: inflight.hops,
      ts: new Date().toISOString(),
      aborted: opts.aborted ?? false,
    };
    await this.deliver(env, inflight.senderSocketPath, inflight.senderPid);
    this.inFlight.delete(msgId);
    this.emit("response_sent", env);
  }

  /** Send an error envelope back. */
  async fail(msgId: string, code: ErrorCode, error: string): Promise<void> {
    const inflight = this.inFlight.get(msgId);
    if (!inflight) return;
    const env: ErrorEnvelope = {
      type: "error",
      msg_id: msgId,
      sender: this.name,
      target: inflight.sender,
      hops: inflight.hops,
      ts: new Date().toISOString(),
      error,
      code,
    };
    try {
      await this.deliver(env, inflight.senderSocketPath, inflight.senderPid);
      this.emit("error_sent", env);
    } catch {
      // Best-effort.
    }
    this.inFlight.delete(msgId);
  }

  /**
   * Update the advertised context usage (called by the host
   * extension periodically).
   */
  setContextUsedPct(pct: number): void {
    this.contextUsedPct = Math.max(0, Math.min(100, pct));
    try {
      this.upsertRegistry();
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  /**
   * Stop listening, deregister, close. Idempotent. Rejects any
   * pending outbound messages.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
        // Drop active connections (force-close after a short grace).
        const conns = (s as unknown as { connections?: Array<{ destroy: () => void }> }).connections;
        if (Array.isArray(conns)) {
          setTimeout(() => {
            for (const c of conns) {
              try { c.destroy(); } catch { /* ignore */ }
            }
          }, 100).unref();
        }
      });
    }
    try { this.registry.remove(this.name); } catch { /* ignore */ }
    try { fs.unlinkSync(this.socketPath); } catch { /* ENOENT */ }
    this.listening = false;

    // Reject pending outbound.
    for (const [, entry] of this.pending) {
      if (entry.pending.status === "pending" || entry.pending.status === "delivered") {
        entry.pending.status = "error";
        entry.pending.error = "peer closed";
        entry.pending.errorCode = "delivery_failed";
        entry.pending.completed_at = new Date().toISOString();
        this.notifyWaiters(entry.pending.msg_id, entry.pending);
      }
    }
    this.pending.clear();

    this.emit("closed");
  }

  // -------------------------------------------------------------------------
  // Internal: connection handler — dispatches inbound envelopes
  // -------------------------------------------------------------------------

  private handleConnection(conn: net.Socket): void {
    conn.setTimeout(this.socketTimeoutMs);
    let buf = "";
    const cleanup = (): void => {
      try { conn.end(); } catch { /* ignore */ }
      try { conn.destroy(); } catch { /* ignore */ }
    };
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
    });
    conn.on("end", () => {
      const lines = buf.split("\n");
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let env: ComsEnvelope;
        try {
          env = JSON.parse(t) as ComsEnvelope;
        } catch {
          cleanup();
          return;
        }
        if (env.type === "prompt") {
          this.handleInboundPrompt(env);
        } else if (env.type === "response") {
          this.handleInboundResponse(env);
        } else if (env.type === "error") {
          this.handleInboundError(env);
        }
      }
      cleanup();
    });
    conn.on("error", () => cleanup());
    conn.on("timeout", () => cleanup());
  }

  /**
   * Inbound prompt from another peer. Apply hop limit check, look
   * up the sender's socket, store in inFlight, emit 'prompt'.
   */
  private handleInboundPrompt(env: PromptEnvelope): void {
    const incomingHops = env.hops + 1;
    if (incomingHops > this.maxHops) {
      // Send back an error envelope.
      const errEnv: ErrorEnvelope = {
        type: "error",
        msg_id: env.msg_id,
        sender: this.name,
        target: env.sender,
        hops: incomingHops,
        ts: new Date().toISOString(),
        error: `hop limit exceeded: hops=${incomingHops}, max=${this.maxHops}`,
        code: "hop_limit_exceeded",
      };
      const senderEntry = this.registry.get(env.sender);
      if (senderEntry) {
        void this.deliver(errEnv, senderEntry.socketPath, senderEntry.pid).catch(() => undefined);
        this.emit("error_sent", errEnv);
      }
      return;
    }
    if (env.target !== this.name) {
      // Misdirected; drop.
      return;
    }
    const senderEntry = this.registry.get(env.sender);
    if (!senderEntry) {
      // Cannot reply; drop.
      return;
    }
    this.inFlight.set(env.msg_id, {
      sender: env.sender,
      senderSocketPath: senderEntry.socketPath,
      senderPid: senderEntry.pid,
      conversationId: env.conversation_id,
      hops: incomingHops,
    });
    this.emit("prompt", { ...env, hops: incomingHops });
  }

  private handleInboundResponse(env: ResponseEnvelope): void {
    const entry = this.pending.get(env.msg_id);
    if (!entry) return;
    entry.pending.status = "complete";
    entry.pending.response = env;
    entry.pending.completed_at = new Date().toISOString();
    this.notifyWaiters(env.msg_id, entry.pending);
  }

  private handleInboundError(env: ErrorEnvelope): void {
    const entry = this.pending.get(env.msg_id);
    if (!entry) return;
    entry.pending.status = "error";
    entry.pending.error = env.error;
    entry.pending.errorCode = env.code;
    entry.pending.completed_at = new Date().toISOString();
    this.notifyWaiters(env.msg_id, entry.pending);
  }

  private notifyWaiters(msgId: string, pending: PendingMessage): void {
    const waiters = this.waiters.get(msgId);
    if (waiters) {
      for (const w of waiters) {
        try { w(pending); } catch { /* ignore */ }
      }
      this.waiters.delete(msgId);
    }
  }

  // -------------------------------------------------------------------------
  // Internal: low-level socket send
  // -------------------------------------------------------------------------

  private deliver(env: ComsEnvelope, socketPath: string, targetPid: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!isPidAlive(targetPid)) {
        reject(new Error(`target peer pid ${targetPid} is dead`));
        return;
      }
      const conn = net.createConnection({ path: socketPath });
      let settled = false;
      const finish = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch { /* ignore */ }
        try { conn.destroy(); } catch { /* ignore */ }
        if (err) reject(err); else resolve();
      };
      conn.setTimeout(this.socketTimeoutMs);
      conn.on("connect", () => {
        conn.write(JSON.stringify(env) + "\n");
        // Signal EOF so the receiver's `end` event fires and
        // processes the envelope.
        conn.end();
      });
      conn.on("timeout", () => finish(new Error("socket timeout")));
      conn.on("error", (err) => finish(err));
      conn.on("end", () => finish(null));
      conn.on("close", () => finish(null));
    });
  }

  /**
   * Send a prompt and track its state. On delivery failure, mark
   * the pending entry as error (and notify waiters).
   */
  private async deliverPrompt(
    env: PromptEnvelope,
    socketPath: string,
    targetPid: number,
    msgId: string,
  ): Promise<void> {
    try {
      await this.deliver(env, socketPath, targetPid);
      const entry = this.pending.get(msgId);
      if (entry && entry.pending.status === "pending") {
        entry.pending.status = "delivered";
        entry.pending.delivered_at = new Date().toISOString();
      }
    } catch (err) {
      const entry = this.pending.get(msgId);
      if (entry) {
        entry.pending.status = "error";
        entry.pending.error = (err as Error).message;
        entry.pending.errorCode = "delivery_failed";
        entry.pending.completed_at = new Date().toISOString();
        this.notifyWaiters(msgId, entry.pending);
      }
    }
  }

  private upsertRegistry(): void {
    const entry: PeerEntry = {
      name: this.name,
      pid: process.pid,
      socketPath: this.socketPath,
      project: this.project,
      cwd: this.cwd,
      purpose: this.purpose,
      color: this.color,
      lastHeartbeat: new Date().toISOString(),
      contextUsedPct: this.contextUsedPct,
    };
    this.registry.upsert(entry);
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface InFlight {
  sender: string;
  senderSocketPath: string;
  senderPid: number;
  conversationId?: string;
  hops: number;
}

interface Pending {
  pending: PendingMessage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
    if (p === "~") return home;
    return path.join(home, p.slice(2));
  }
  return p;
}

function requireProjectHash(cwd: string): string {
  // Inline to avoid a circular import (registry.ts imports types.ts
  // and we want server.ts independent for forward-compat).
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function generateSessionId(): string {
  // 16-char session id.
  return randomBytes(8).toString("hex");
}

function generateMsgId(): string {
  // 26-char ULID-ish.
  const ts = Date.now().toString(36).padStart(10, "0");
  const rand = randomBytes(8).toString("hex").slice(0, 16);
  return `${ts}-${rand}`;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

async function unlinkStaleSocket(socketPath: string): Promise<void> {
  // Probe: if we can connect to the socket, some other peer owns
  // it — refuse to overwrite. If the connect fails (ENOENT or
  // timeout), the socket is stale — unlink and proceed.
  const live = await new Promise<boolean>((resolve) => {
    const conn = net.createConnection({ path: socketPath });
    let done = false;
    const finish = (live: boolean): void => {
      if (done) return;
      done = true;
      try { conn.end(); } catch { /* ignore */ }
      try { conn.destroy(); } catch { /* ignore */ }
      resolve(live);
    };
    conn.setTimeout(250);
    conn.on("connect", () => finish(true));
    conn.on("timeout", () => finish(false));
    conn.on("error", () => finish(false));
  });
  if (live) {
    throw new Error(`socket ${socketPath} already in use`);
  }
  try { fs.unlinkSync(socketPath); } catch { /* ENOENT */ }
}