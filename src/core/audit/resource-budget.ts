import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface AuditBudgetOverrides {
  maxTotalDurationMs?: number;
  maxSessionDurationMs?: number;
  maxScoutDurationMs?: number;
  maxTracerDurationMs?: number;
  maxExplorerDurationMs?: number;
  maxModelCalls?: number;
  maxTurns?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalCostUsd?: number;
  maxCoverageRecoveryPasses?: number;
  maxSemanticRepairPasses?: number;
  maxRepeatedFingerprintStates?: number;
  maxExplorerSpawns?: number;
}

interface RuntimeResultShape {
  turns: number;
  costUsd: number | null;
  diagnostics?: { provider_requests: number };
}

export interface ResolvedAuditBudgets {
  maxTotalDurationMs: number;
  maxSessionDurationMs: number;
  maxScoutDurationMs: number;
  maxTracerDurationMs: number;
  maxExplorerDurationMs: number;
  maxModelCalls: number;
  maxTurns: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalCostUsd: number;
  maxCoverageRecoveryPasses: number;
  maxSemanticRepairPasses: number;
  maxRepeatedFingerprintStates: number;
  maxExplorerSpawns: number;
}

export const DEFAULT_AUDIT_BUDGETS: Readonly<ResolvedAuditBudgets> = Object.freeze({
  maxTotalDurationMs: 30 * 60 * 1000,
  maxSessionDurationMs: 12 * 60 * 1000,
  maxScoutDurationMs: 3 * 60 * 1000,
  maxTracerDurationMs: 3 * 60 * 1000,
  maxExplorerDurationMs: 2 * 60 * 1000,
  maxModelCalls: 96,
  maxTurns: 96,
  maxInputTokens: 2_000_000,
  maxOutputTokens: 200_000,
  maxTotalCostUsd: 20,
  maxCoverageRecoveryPasses: 1,
  maxSemanticRepairPasses: 3,
  maxRepeatedFingerprintStates: 2,
  maxExplorerSpawns: 16,
});

const AUDIT_BUDGET_MAXIMUMS: Readonly<ResolvedAuditBudgets> = Object.freeze({
  maxTotalDurationMs: 24 * 60 * 60 * 1000,
  maxSessionDurationMs: 24 * 60 * 60 * 1000,
  maxScoutDurationMs: 24 * 60 * 60 * 1000,
  maxTracerDurationMs: 24 * 60 * 60 * 1000,
  maxExplorerDurationMs: 24 * 60 * 60 * 1000,
  maxModelCalls: 1_024,
  maxTurns: 1_024,
  maxInputTokens: 50_000_000,
  maxOutputTokens: 5_000_000,
  maxTotalCostUsd: 1_000,
  maxCoverageRecoveryPasses: 20,
  maxSemanticRepairPasses: 20,
  maxRepeatedFingerprintStates: 10,
  maxExplorerSpawns: 256,
});

export function resolveAuditBudgets(
  overrides: AuditBudgetOverrides | undefined,
): ResolvedAuditBudgets {
  const resolved = { ...DEFAULT_AUDIT_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(resolved) as Array<[
    keyof ResolvedAuditBudgets,
    number,
  ]>) {
    const minimum = name === "maxTotalCostUsd" ? 0.01 : 1;
    if (!Number.isFinite(value) || value < minimum || value > AUDIT_BUDGET_MAXIMUMS[name]) {
      throw new Error(`auditBudgets.${name} must be between ${minimum} and ${AUDIT_BUDGET_MAXIMUMS[name]}`);
    }
    if (name !== "maxTotalCostUsd" && !Number.isSafeInteger(value)) {
      throw new Error(`auditBudgets.${name} must be a safe integer`);
    }
  }
  for (const name of [
    "maxSessionDurationMs",
    "maxScoutDurationMs",
    "maxTracerDurationMs",
    "maxExplorerDurationMs",
  ] as const) {
    if (resolved[name] > resolved.maxTotalDurationMs) {
      throw new Error(`auditBudgets.${name} cannot exceed maxTotalDurationMs`);
    }
  }
  return resolved;
}

interface UsageShape {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number } | number;
}

interface SessionObservation {
  calls: number;
  turns: number;
  costUsd: number;
  startedAt: number;
  maxDurationMs: number;
}

function recordUsageValue(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageCost(usage: UsageShape | undefined): number {
  const value = usage?.cost;
  const cost = typeof value === "number" ? value : value?.total;
  return typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : 0;
}

export class AuditBudgetExceededError extends Error {
  constructor(message: string) {
    super(`repository audit resource budget exhausted: ${message}`);
    this.name = "AuditBudgetExceededError";
  }
}

export class AuditResourceBudget {
  readonly limits: ResolvedAuditBudgets;
  readonly #startedAt: number;
  #modelCalls = 0;
  #turns = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #costUsd = 0;
  #explorerSpawns = 0;
  #failure: string | null = null;

  constructor(overrides?: AuditBudgetOverrides, startedAt = Date.now()) {
    this.limits = resolveAuditBudgets(overrides);
    this.#startedAt = startedAt;
  }

  remainingDurationMs(sessionLimitMs = this.limits.maxSessionDurationMs): number {
    this.assertWithinBudget();
    const remaining = this.limits.maxTotalDurationMs - (Date.now() - this.#startedAt);
    if (remaining <= 0) this.fail(`elapsed time reached ${this.limits.maxTotalDurationMs}ms`);
    return Math.max(1, Math.min(sessionLimitMs, remaining));
  }

  remainingOutputTokens(perRequestLimit: number): number {
    this.assertWithinBudget();
    const remaining = this.limits.maxOutputTokens - this.#outputTokens;
    if (remaining <= 0) this.fail(`output tokens reached ${this.limits.maxOutputTokens}`);
    return Math.max(1, Math.min(perRequestLimit, remaining));
  }

  remainingModelCalls(perExplorerLimit: number): number {
    this.assertWithinBudget();
    const remaining = this.limits.maxModelCalls - this.#modelCalls;
    if (remaining <= 0) this.fail(`model calls reached ${this.limits.maxModelCalls}`);
    return Math.max(1, Math.min(perExplorerLimit, remaining));
  }

  beginSession(maxDurationMs = this.limits.maxSessionDurationMs): SessionObservation {
    this.assertWithinBudget();
    if (this.#modelCalls >= this.limits.maxModelCalls) {
      this.fail(`model calls reached ${this.limits.maxModelCalls}`);
    }
    return { calls: 0, turns: 0, costUsd: 0, startedAt: Date.now(), maxDurationMs };
  }

  expireSession(session: SessionObservation): void {
    if (Date.now() - session.startedAt >= session.maxDurationMs) {
      this.exhaustSession(session);
    }
  }

  exhaustSession(session: SessionObservation): never {
    this.fail(`session elapsed time reached ${session.maxDurationMs}ms`);
  }

  observeParentEvent(event: AgentSessionEvent, session: SessionObservation): void {
    this.expireSession(session);
    const value = event as {
      type?: string;
      message?: { role?: string; stopReason?: string; usage?: UsageShape };
    };
    if (value.type !== "message_end" || value.message?.role !== "assistant") return;
    const usage = value.message?.usage;
    session.calls += 1;
    session.turns += 1;
    const cost = usageCost(usage);
    session.costUsd += cost;
    this.#modelCalls += 1;
    this.#turns += 1;
    this.#inputTokens += recordUsageValue(usage?.input)
      + recordUsageValue(usage?.cacheRead)
      + recordUsageValue(usage?.cacheWrite);
    this.#outputTokens += recordUsageValue(usage?.output);
    this.#costUsd += cost;
    this.checkCounters();
    if (
      this.#modelCalls >= this.limits.maxModelCalls
      && value.message?.role === "assistant"
      && value.message.stopReason === "toolUse"
    ) {
      this.fail(`model calls reached ${this.limits.maxModelCalls} while requesting continuation`);
    }
    if (
      this.#turns >= this.limits.maxTurns
      && value.message?.role === "assistant"
      && value.message.stopReason === "toolUse"
    ) {
      this.fail(`turns reached ${this.limits.maxTurns} while requesting continuation`);
    }
  }

  finishParentSession(session: SessionObservation, result: RuntimeResultShape): void {
    this.assertWithinBudget();
    this.expireSession(session);
    const reportedCalls = result.diagnostics?.provider_requests ?? result.turns;
    const additionalCalls = Math.max(0, reportedCalls - session.calls);
    const additionalTurns = Math.max(0, result.turns - session.turns);
    const reportedCost = result.costUsd ?? 0;
    const additionalCost = Math.max(0, reportedCost - session.costUsd);
    this.#modelCalls += additionalCalls;
    this.#turns += additionalTurns;
    this.#costUsd += additionalCost;
    this.checkCounters();
  }

  reserveExplorer(mode: string): number {
    this.assertWithinBudget();
    if (this.#modelCalls >= this.limits.maxModelCalls) {
      this.fail(`model calls reached ${this.limits.maxModelCalls}`);
    }
    if (this.#explorerSpawns >= this.limits.maxExplorerSpawns) {
      this.fail(`explorer spawns reached ${this.limits.maxExplorerSpawns}`);
    }
    this.#explorerSpawns += 1;
    const modeLimit = mode === "concern_scout"
      ? this.limits.maxScoutDurationMs
      : mode === "concern_tracer"
      ? this.limits.maxTracerDurationMs
      : this.limits.maxExplorerDurationMs;
    return this.remainingDurationMs(modeLimit);
  }

  recordExplorerMessages(messages: ReadonlyArray<unknown>): void {
    for (const message of messages) {
      if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
      const value = message as { role?: string; usage?: UsageShape };
      if (value.role !== "assistant" || value.usage === undefined) continue;
      this.#modelCalls += 1;
      this.#turns += 1;
      this.#inputTokens += recordUsageValue(value.usage.input)
        + recordUsageValue(value.usage.cacheRead)
        + recordUsageValue(value.usage.cacheWrite);
      this.#outputTokens += recordUsageValue(value.usage.output);
      this.#costUsd += usageCost(value.usage);
    }
    this.checkCounters();
  }

  assertWithinBudget(): void {
    if (this.#failure !== null) throw new AuditBudgetExceededError(this.#failure);
    if (Date.now() - this.#startedAt > this.limits.maxTotalDurationMs) {
      this.fail(`elapsed time exceeded ${this.limits.maxTotalDurationMs}ms`);
    }
    this.checkCounters();
  }

  snapshot(): Record<string, number> {
    return {
      elapsed_ms: Date.now() - this.#startedAt,
      model_calls: this.#modelCalls,
      turns: this.#turns,
      input_tokens: this.#inputTokens,
      output_tokens: this.#outputTokens,
      cost_usd: Number(this.#costUsd.toFixed(12)),
      explorer_spawns: this.#explorerSpawns,
    };
  }

  private checkCounters(): void {
    if (this.#modelCalls > this.limits.maxModelCalls) {
      this.fail(`model calls exceeded ${this.limits.maxModelCalls}`);
    }
    if (this.#turns > this.limits.maxTurns) this.fail(`turns exceeded ${this.limits.maxTurns}`);
    if (this.#inputTokens > this.limits.maxInputTokens) {
      this.fail(`input tokens exceeded ${this.limits.maxInputTokens}`);
    }
    if (this.#outputTokens > this.limits.maxOutputTokens) {
      this.fail(`output tokens exceeded ${this.limits.maxOutputTokens}`);
    }
    if (this.#costUsd > this.limits.maxTotalCostUsd) {
      this.fail(`provider-reported cost exceeded $${this.limits.maxTotalCostUsd.toFixed(2)}`);
    }
  }

  private fail(message: string): never {
    this.#failure ??= message;
    throw new AuditBudgetExceededError(this.#failure);
  }
}

export function unresolvedObligationFingerprint(value: unknown): string {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (typeof candidate !== "object" || candidate === null) return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}
