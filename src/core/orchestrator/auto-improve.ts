// auto-improve.ts — the orchestrator-side LEARN loop.
//
// Implements the "auto" half of ACT -> LEARN -> REUSE for
// orchestrator-spawned sub-agents. See `principles/09-agent-experts.md`.
//
// On every `agent_end` event the OrchestratorHost calls
// `scheduler.onAgentEnd(agentId)`. The scheduler:
//
//   1. Reads the agent's state.json. If `expertise_path` is null,
//      no-op (this is the G1 wiring: the field was reserved on
//      AgentState but never auto-updated — see G3 § 10 deferred).
//   2. Reads the agent's events.jsonl to extract every
//      `tool_execution_start` event with a `path` field. These
//      are the files the agent touched.
//   3. Builds an ExpertRegistry from `<cwd>/.pi/prompts/experts/`
//      and calls `expertsTouchedBy(registry, touchedPaths)` to
//      find every expert whose `primary_paths` overlap.
//   4. For each matched expert, acquires a per-domain file lock
//      (no two LEARN runs touch the same `expertise.yaml`
//      concurrently) and runs `runSelfImprove`.
//   5. Releases the lock.
//
// Concurrency: a single AutoImproveScheduler instance owns a
// per-domain promise chain (in-memory serialization). The file
// lock is the cross-process guard for multi-host fleets
// (Class 4 G3).
//
// Source of truth:
//   - principles/09-agent-experts.md
//   - principles/15-anti-patterns.md § "Agent Expert Anti-Patterns"
//     ("self-improve invents facts", "self-improve never runs",
//     "YAML longer than 1000 lines")

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ExpertRegistry,
  expertsTouchedBy,
  parseExpertiseYaml,
  runSelfImprove,
  type ExpertDomain,
  type SelfImproveSyncer,
} from "../agent-expert.ts";
import type { Model, Api } from "@earendil-works/pi-ai";
// Model is used as the type for liteModel in AutoImproveSchedulerOptions.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ModelRef = Model<Api>;
import {
  agentPaths,
  appendOrchestratorExecutionLog,
  orchestratorPaths,
  readAgentState,
  readAgentEvents,
} from "./paths.ts";
import type { AgentState } from "./state.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutoImproveSchedulerOptions {
  configDir: string;
  cwd: string;
  /** Override the self-improve syncer (used in tests). */
  syncer?: SelfImproveSyncer;
  /** ISO date string used as `last_updated`. Default: now. */
  todayIso?: string;
  /**
   * Override the ExpertRegistry (used in tests). Default: built
   * from `<cwd>/.pi/prompts/experts/`.
   */
  expertRegistry?: ExpertRegistry;
  /** Override the orchestrator's execution log writer (used in tests). */
  log?: (msg: string) => void;
  /**
   * Optional pre-resolved lite slot model. When set, the LEARN
   * flow uses this model for its `pi -p` invocation (via the
   * `AGENTIFY_LEARN_MODEL` env var). Default: the syncer falls back
   * to `pi -p`'s default model.
   */
  liteModel?: Model<Api>;
}

export interface AutoImproveResult {
  /** The agent id that triggered the LEARN cycle. */
  agent_id: string;
  /** The experts whose `expertise.yaml` was updated. */
  matchedExperts: string[];
  /** True if any expert was updated. */
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Path extraction from events.jsonl
// ---------------------------------------------------------------------------

const WRITE_LIKE_TOOLS = new Set([
  "write",
  "edit",
  "write_file",
  "multi_edit",
  "create_file",
  "patch",
]);

/**
 * Read the agent's events.jsonl and extract every `path` written
 * to by a write-like tool. We accept the path under multiple keys
 * (path / filePath / filepath) to mirror the bash hook's tolerance.
 */
function extractTouchedPaths(eventsFilePath: string): string[] {
  if (!fs.existsSync(eventsFilePath)) return [];
  const raw = fs.readFileSync(eventsFilePath, "utf-8");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: { kind?: string; fields?: Record<string, unknown> };
    try {
      ev = JSON.parse(t) as { kind?: string; fields?: Record<string, unknown> };
    } catch {
      continue;
    }
    if (ev.kind !== "tool_execution_start") continue;
    const toolName = (ev.fields?.["tool_name"] as string | undefined) ?? "";
    if (!WRITE_LIKE_TOOLS.has(toolName)) continue;
    const pathField = (ev.fields?.["path"] ?? ev.fields?.["filePath"] ?? ev.fields?.["filepath"]) as string | undefined;
    if (typeof pathField === "string" && pathField.length > 0) {
      out.push(pathField);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-domain file lock
// ---------------------------------------------------------------------------

/**
 * Acquire a per-domain lock file at `<configDir>/orchestrator/
 * auto-improve/<domain>.lock`. The lock is acquired by creating
 * the file with O_EXCL; if creation fails because the file
 * already exists, the caller should wait for the holder to
 * release. Cross-process safety: a second process on the same
 * machine will fail to acquire the lock until the first releases.
 *
 * For testability, the lock is a simple Promise<() => void>
 * release function. Real callers should use `tryLock` with
 * retries; tests use the synchronous `lockSync`.
 */
async function acquireLock(lockPath: string, timeoutMs = 30_000): Promise<() => void> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  // Poll until we can create the lock file.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // O_EXCL: fail if exists. This is the cross-process mutex.
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`auto-improve: timed out waiting for lock ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class AutoImproveScheduler {
  private readonly opts: AutoImproveSchedulerOptions;
  /** Per-domain promise chain. Keys are expert domains. */
  private readonly chainByDomain = new Map<string, Promise<string | null>>();
  /** Global chain: for tests/observability of total pending work. */
  private tail: Promise<void> = Promise.resolve();

  constructor(opts: AutoImproveSchedulerOptions) {
    this.opts = opts;
  }

  /**
   * Triggered on `agent_end`. Reads the agent's state and events,
   * resolves matched experts, and runs `runSelfImprove` for each
   * (serialized per domain, parallel across domains).
   *
   * Returns the result (number of experts touched). Does NOT
   * throw on missing data; logs and returns a benign result.
   */
  async onAgentEnd(agentId: string): Promise<AutoImproveResult> {
    const paths = agentPaths(this.opts.configDir, agentId);
    const state = readAgentState(paths);
    if (!state) {
      this.log(`onAgentEnd: agent ${agentId} not found on disk; skipping`);
      return { agent_id: agentId, matchedExperts: [], changed: false };
    }
    if (!state.expertise_path) {
      // G1 wiring: this is the common case (most agents don't carry
      // an expertise_path yet). No-op.
      return { agent_id: agentId, matchedExperts: [], changed: false };
    }

    // The agent's own events.jsonl has the touched paths.
    const touchedPaths = extractTouchedPaths(paths.eventsFile);
    this.log(`onAgentEnd: ${agentId} touched ${touchedPaths.length} paths; expertise_path=${state.expertise_path}`);

    // Build the registry (cheap scan). Tests pass an override.
    const registry = this.opts.expertRegistry ?? ExpertRegistry.fromCwd(this.opts.cwd);
    const matched = expertsTouchedBy(registry, touchedPaths);

    // Filter to experts whose expertise.yaml still exists on disk
    // (might have been deleted between ACT and LEARN).
    const live: ExpertDomain[] = matched.filter((e) => fs.existsSync(e.expertisePath));
    if (live.length === 0) {
      this.log(`onAgentEnd: ${agentId} matched 0 experts (no overlap or no live expertise files)`);
      return { agent_id: agentId, matchedExperts: [], changed: false };
    }

    // For each matched expert, append a job to its domain's
    // serialized chain.
    const updates: Array<{ promise: Promise<string | null>; domain: string }> = live.map((expert) => {
      const prev = this.chainByDomain.get(expert.domain) ?? Promise.resolve();
      const promise = prev.then(() => this.runOne(state, expert)).catch((err) => {
        this.log(`onAgentEnd: self-improve failed for ${expert.domain}: ${(err as Error).message}`);
        return null as string | null;
      }) as Promise<string | null>;
      this.chainByDomain.set(expert.domain, promise);
      return { promise, domain: expert.domain };
    });

    // Wait for all updates (parallel across domains, serialized per
    // domain).
    const settled = await Promise.all(updates.map((u) => u.promise));
    const changedExperts = settled.filter((d): d is string => d !== null);
    // Update the global tail for drain().
    this.tail = this.tail.then(() => Promise.all(updates.map((u) => u.promise))).then(() => undefined);

    return {
      agent_id: agentId,
      matchedExperts: changedExperts,
      changed: changedExperts.length > 0,
    };
  }

  /**
   * Wait for any pending self-improve jobs to complete.
   */
  async drain(): Promise<void> {
    await this.tail;
  }

  // -------------------------------------------------------------------------
  // Internal: run one self-improve under the domain's lock
  // -------------------------------------------------------------------------

  private async runOne(state: AgentState, expert: ExpertDomain): Promise<string | null> {
    const lockPath = path.join(
      this.opts.configDir,
      "orchestrator",
      "auto-improve",
      `${sanitizeDomain(expert.domain)}.lock`,
    );
    const release = await acquireLock(lockPath);
    try {
      this.log(`self-improve (auto): ${expert.domain} (agent=${state.agent_id})`);
      const modelSlot = this.opts.liteModel
        ? { provider: this.opts.liteModel.provider, model: this.opts.liteModel.id }
        : undefined;
      const result = await runSelfImprove(expert, this.opts.cwd, {
        syncer: this.opts.syncer,
        todayIso: this.opts.todayIso,
        configDir: this.opts.configDir,
        modelSlot,
        log: (msg) => this.log(`  ${msg}`),
      });
      if (!result.valid) {
        this.log(`self-improve (auto): ${expert.domain} produced invalid YAML; not changing last_updated`);
        return null;
      }
      if (!result.changed) {
        this.log(`self-improve (auto): ${expert.domain} unchanged`);
        return null;
      }
      this.log(`self-improve (auto): ${expert.domain} updated (${result.linesBefore} -> ${result.linesAfter} lines)`);
      return expert.domain;
    } finally {
      release();
    }
  }

  private log(msg: string): void {
    if (this.opts.log) {
      this.opts.log(msg);
      return;
    }
    try {
      appendOrchestratorExecutionLog(
        orchestratorPaths(this.opts.configDir),
        msg,
      );
    } catch {
      // best-effort; ignore.
    }
  }
}

/**
 * Sanitize a domain name for use as a filename. Mirrors the
 * `agent_id` slugification in `state.ts`.
 */
function sanitizeDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "expert";
}