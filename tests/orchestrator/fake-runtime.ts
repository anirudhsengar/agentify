// fake-runtime.ts — a deterministic in-memory AgentRuntime for tests.
//
// Implements the `AgentRuntime` interface (src/core/types.ts) and
// records every call. Tests inject this in place of `PiSdkRuntime`
// so orchestrator tests run without a real Pi session.
//
// Usage:
//   const runtime = new FakeRuntime();
//   runtime.enqueue({ resultText: "ok", costUsd: 0.01, turns: 3 });
//   const result = await runtime.runSession({ ... });
//   // result.turns === 3, result.costUsd === 0.01
//
// Each scripted session emits a small event stream (message_start,
// text_delta, message_end, agent_end). The runtime is synchronous
// from the caller's POV (runSession returns once agent_end fires);
// tests that need async control should set `delayMs`.

import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
} from "../../src/core/types.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type FakeEvent =
  | { type: "message_start"; message: { role: "assistant" } }
  | { type: "text_delta"; delta: string }
  | { type: "message_end"; message: { role: "assistant"; usage?: { cost?: { total?: number }; input?: number; output?: number } } }
  | { type: "agent_end"; willRetry?: boolean; usage?: { cost?: { total?: number } }; turns?: number };

export interface ScriptedSession {
  /** The exact text the agent returns as its final reply. */
  resultText: string;
  /** Cost emitted on the final message_end. Default: 0.01. */
  costUsd?: number;
  /** Number of turns emitted. Default: 1. */
  turns?: number;
  /** Optional per-step delay (ms) before agent_end; default 0. */
  delayMs?: number;
  /** Abort this session immediately (used by interrupt tests). */
  abortImmediately?: boolean;
}

export interface RecordedCall {
  systemPrompt: string;
  userPrompt: string;
  tools: string[];
  customTools: number;
  cwd: string;
  agentDomain?: string[] | null;
}

interface Slot {
  script: ScriptedSession;
  resolveDone: () => void;
  done: Promise<void>;
  aborted: boolean;
  finished: boolean;
}

export class FakeRuntime implements AgentRuntime {
  public readonly calls: RecordedCall[] = [];
  private readonly queue: Slot[] = [];
  private nextSessionId = 0;

  /**
   * Queue a scripted session for the next `runSession` call.
   */
  enqueue(script: ScriptedSession): void {
    const slot: Slot = {
      script,
      resolveDone: () => {},
      done: Promise.resolve(),
      aborted: false,
      finished: false,
    };
    slot.done = new Promise<void>((resolve) => {
      slot.resolveDone = resolve;
    });
    this.queue.push(slot);
  }

  /** Internal: build a slot on the fly when none is queued. */
  private makeDefaultSlot(): Slot {
    const slot: Slot = {
      script: { resultText: "default response", costUsd: 0.0, turns: 1, delayMs: 0 },
      resolveDone: () => {},
      done: Promise.resolve(),
      aborted: false,
      finished: false,
    };
    slot.done = new Promise<void>((resolve) => {
      slot.resolveDone = resolve;
    });
    return slot;
  }

  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    const slot = this.queue.shift() ?? this.makeDefaultSlot();
    this.nextSessionId += 1;

    this.calls.push({
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      tools: [...options.tools],
      customTools: options.customTools?.length ?? 0,
      cwd: options.cwd,
      agentDomain: options.agentDomain ?? null,
    });

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        slot.aborted = true;
      }, { once: true });
    }

    return this.replayScript(slot, options).then(() => ({
      turns: slot.script.turns ?? 1,
      costUsd: slot.script.costUsd ?? 0,
      aborted: slot.aborted,
    }));
  }

  async runGreenfield(_options: {
    cwd: string;
    configDir: string;
    config: import("../../src/core/types.ts").AgentifyConfig;
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
  }): Promise<AgentRuntimeResult> {
    return { turns: 0, costUsd: 0, aborted: false };
  }

  /**
   * Replay the scripted events for a session and invoke the
   * onEvent callback for each. Resolves when the session ends.
   */
  private async replayScript(slot: Slot, options: AgentRuntimeSessionOptions): Promise<void> {
    const onEvent = options.onEvent;
    const script = slot.script;
    const signal = options.signal;

    // Emit message_start
    const startEvent: FakeEvent = { type: "message_start", message: { role: "assistant" } };
    onEvent?.(startEvent as unknown as AgentSessionEvent);

    // Emit text_delta with the result text
    const deltaEvent: FakeEvent = { type: "text_delta", delta: script.resultText };
    onEvent?.(deltaEvent as unknown as AgentSessionEvent);

    // Emit message_end with usage
    const messageEnd: FakeEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        usage: {
          cost: { total: script.costUsd ?? 0 },
          input: 100,
          output: 50,
        },
      },
    };
    onEvent?.(messageEnd as unknown as AgentSessionEvent);

    // Optional delay (for race tests).
    if (script.delayMs) {
      await new Promise((r) => setTimeout(r, script.delayMs));
    }

    // If the signal fired during the delay, emit an aborted agent_end.
    if (signal?.aborted) {
      slot.aborted = true;
      const agentEnd: FakeEvent = {
        type: "agent_end",
        willRetry: false,
        usage: { cost: { total: script.costUsd ?? 0 } },
        turns: script.turns ?? 1,
      };
      onEvent?.(agentEnd as unknown as AgentSessionEvent);
      slot.finished = true;
      slot.resolveDone();
      return;
    }

    // Emit agent_end
    const agentEnd: FakeEvent = {
      type: "agent_end",
      willRetry: false,
      usage: { cost: { total: script.costUsd ?? 0 } },
      turns: script.turns ?? 1,
    };
    onEvent?.(agentEnd as unknown as AgentSessionEvent);

    slot.finished = true;
    slot.resolveDone();
  }
}