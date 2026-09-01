import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ModelCost } from "@earendil-works/pi-ai";

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

export interface AuditResourceUsage {
  elapsed_ms: number;
  model_calls: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  explorer_spawns: number;
  coverage_recovery_passes: number;
  semantic_repair_passes: number;
  unreported_calls?: number;
  unreserved_calls?: number;
  reserved_input_tokens?: number;
  reserved_output_tokens?: number;
  reserved_cost_usd?: number;
}

export interface ProviderRequestReservation {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Provider metadata bounds, not an invoice or invented measured usage. */
export function providerRequestReservation(model: {
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
}, maxOutputTokens = model.maxTokens): ProviderRequestReservation {
  const inputTokens = model.contextWindow;
  const outputTokens = Math.min(model.maxTokens, maxOutputTokens);
  const tiers = model.cost.tiers ?? [];
  const rates = [model.cost, ...tiers.filter(tier => tier.inputTokensAbove < inputTokens)];
  const inputPrice = Math.max(...rates.flatMap(rate => [rate.input, rate.cacheRead, rate.cacheWrite]));
  const outputPrice = Math.max(...rates.map(rate => rate.output));
  const costUsd = (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
  if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value > 0)
    || !tiers.every(tier => Number.isSafeInteger(tier.inputTokensAbove) && tier.inputTokensAbove >= 0)
    || ![model.cost, ...tiers].flatMap(rate => [rate.input, rate.output, rate.cacheRead, rate.cacheWrite])
      .every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error("selected model lacks finite token and price metadata for request reservation");
  }
  return { inputTokens, outputTokens, costUsd };
}

export const DEFAULT_AUDIT_BUDGETS: Readonly<ResolvedAuditBudgets> = Object.freeze({
  maxTotalDurationMs: 30 * 60 * 1000,
  maxSessionDurationMs: 12 * 60 * 1000,
  maxScoutDurationMs: 3 * 60 * 1000,
  maxTracerDurationMs: 3 * 60 * 1000,
  maxExplorerDurationMs: 2 * 60 * 1000,
  maxModelCalls: 240,
  maxTurns: 240,
  maxInputTokens: 8_000_000,
  // Includes unanswered calls and the next request's full, possibly uncappable, maximum.
  maxOutputTokens: 640_000,
  maxTotalCostUsd: 20,
  maxCoverageRecoveryPasses: 1,
  maxSemanticRepairPasses: 3,
  maxRepeatedFingerprintStates: 2,
  // Helpers and retraces share this envelope; actual requests still consume the
  // aggregate call, time, token and cost limits before dispatch.
  maxExplorerSpawns: 240,
});

const TERMINAL_CLEANUP_RESERVE_MS = 1_000;

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
  requests: number;
  admissionsObserved: boolean;
  turns: number;
  costUsd: number;
  startedAt: number;
  maxDurationMs: number;
  reservations: Array<ProviderRequestReservation | undefined>;
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
  readonly #priorElapsedMs: number;
  #modelCalls = 0;
  #turns = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #costUsd = 0;
  #unreportedCalls = 0;
  #unreservedCalls = 0;
  #reservedInputTokens = 0;
  #reservedOutputTokens = 0;
  #reservedCostUsd = 0;
  #explorerSpawns = 0;
  #coverageRecoveryPasses = 0;
  #semanticRepairPasses = 0;
  readonly #unresolvedFingerprints: string[];
  #failure: string | null = null;

  // Request-capacity refusals must not set #failure: they spend nothing, and
  // sibling responses may release reservations. Actual overruns remain fatal.

  constructor(
    overrides?: AuditBudgetOverrides,
    startedAt = Date.now(),
    initialUsage?: Readonly<AuditResourceUsage>,
    initialUnresolvedFingerprints: ReadonlyArray<string> = [],
  ) {
    this.limits = resolveAuditBudgets(overrides);
    this.#startedAt = startedAt;
    const usage = initialUsage ?? {
      elapsed_ms: 0,
      model_calls: 0,
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      explorer_spawns: 0,
      coverage_recovery_passes: 0,
      semantic_repair_passes: 0,
    };
    for (const [name, value] of Object.entries(usage)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`initial audit resource usage ${name} must be finite and non-negative`);
      }
    }
    this.#priorElapsedMs = Math.floor(usage.elapsed_ms);
    this.#modelCalls = Math.floor(usage.model_calls);
    this.#turns = Math.floor(usage.turns);
    this.#inputTokens = Math.floor(usage.input_tokens);
    this.#outputTokens = Math.floor(usage.output_tokens);
    this.#costUsd = usage.cost_usd;
    this.#unreportedCalls = usage.unreported_calls ?? Math.max(0, usage.model_calls - usage.turns);
    this.#unreservedCalls = usage.unreserved_calls ?? this.#unreportedCalls;
    this.#reservedInputTokens = usage.reserved_input_tokens ?? 0;
    this.#reservedOutputTokens = usage.reserved_output_tokens ?? 0;
    this.#reservedCostUsd = usage.reserved_cost_usd ?? 0;
    this.#explorerSpawns = Math.floor(usage.explorer_spawns);
    this.#coverageRecoveryPasses = Math.floor(usage.coverage_recovery_passes);
    this.#semanticRepairPasses = Math.floor(usage.semantic_repair_passes);
    this.#unresolvedFingerprints = [...initialUnresolvedFingerprints];
  }

  remainingDurationMs(sessionLimitMs = this.limits.maxSessionDurationMs): number {
    this.assertWithinBudget();
    const remaining = this.limits.maxTotalDurationMs
      - this.#priorElapsedMs
      - (Date.now() - this.#startedAt);
    if (remaining <= TERMINAL_CLEANUP_RESERVE_MS) {
      this.fail(
        `elapsed time reached the ${this.limits.maxTotalDurationMs}ms limit's `
        + `${TERMINAL_CLEANUP_RESERVE_MS}ms terminal cleanup reserve`,
      );
    }
    return Math.max(1, Math.min(sessionLimitMs, remaining - TERMINAL_CLEANUP_RESERVE_MS));
  }

  remainingOutputTokens(perRequestLimit: number): number {
    this.assertWithinBudget();
    const remaining = this.limits.maxOutputTokens - this.#outputTokens - this.#reservedOutputTokens;
    if (remaining <= 0) throw new AuditBudgetExceededError(`output tokens reached ${this.limits.maxOutputTokens}`);
    return Math.max(1, Math.min(perRequestLimit, remaining));
  }

  remainingModelCalls(perExplorerLimit: number): number {
    this.assertWithinBudget();
    const remainingAfterParentReservation = this.limits.maxModelCalls - this.#modelCalls - 1;
    if (remainingAfterParentReservation <= 0) {
      this.fail(
        `model-call capacity cannot reserve one parent continuation within ${this.limits.maxModelCalls} calls`,
      );
    }
    return Math.max(1, Math.min(perExplorerLimit, remainingAfterParentReservation));
  }

  /**
   * Refuse a provider request before dispatch when its serialized byte length
   * cannot fit in the remaining aggregate input-token budget. Provider token
   * usage is reported only after a response; UTF-8 bytes are therefore used as
   * a conservative application-owned upper bound for the tokenized request.
   */
  assertProviderInputCapacity(payload: unknown): number {
    this.assertWithinBudget();
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      this.fail("provider request cannot be serialized for input-budget admission");
    }
    if (serialized === undefined) {
      this.fail("provider request cannot be serialized for input-budget admission");
    }
    const requestBound = Buffer.byteLength(serialized, "utf8");
    const remainingInput = this.limits.maxInputTokens - this.#inputTokens - this.#reservedInputTokens;
    if (remainingInput < requestBound) {
      throw new AuditBudgetExceededError(
        `input token reserve ${remainingInput} is below the serialized provider request bound of ${requestBound}`,
      );
    }
    return requestBound;
  }

  /**
   * Pi does not expose its initial prompt through every provider-request hook.
   * Reserve the selected model's full context window before creating a fresh
   * session so even that first unobservable request cannot cross the aggregate
   * input limit.
   */
  assertProviderSessionCapacity(contextWindow: number): void {
    this.assertWithinBudget();
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) {
      this.fail("selected model has no finite positive context window for input-budget admission");
    }
    const remainingInput = this.limits.maxInputTokens - this.#inputTokens - this.#reservedInputTokens;
    if (remainingInput < contextWindow) {
      throw new AuditBudgetExceededError(
        `input token reserve ${remainingInput} is below the selected model context window of ${contextWindow}`,
      );
    }
  }

  beginSession(maxDurationMs = this.limits.maxSessionDurationMs): SessionObservation {
    this.assertWithinBudget();
    if (this.#modelCalls >= this.limits.maxModelCalls) {
      this.fail(`model calls reached ${this.limits.maxModelCalls}`);
    }
    if (this.#turns >= this.limits.maxTurns) this.fail(`turns reached ${this.limits.maxTurns}`);
    if (this.#inputTokens >= this.limits.maxInputTokens) {
      this.fail(`input tokens reached ${this.limits.maxInputTokens}`);
    }
    if (this.#outputTokens >= this.limits.maxOutputTokens) {
      this.fail(`output tokens reached ${this.limits.maxOutputTokens}`);
    }
    if (this.#costUsd >= this.limits.maxTotalCostUsd) {
      this.fail(`provider-reported cost reached $${this.limits.maxTotalCostUsd.toFixed(2)}`);
    }
    return { calls: 0, requests: 0, admissionsObserved: false, turns: 0, costUsd: 0, startedAt: Date.now(), maxDurationMs, reservations: [] };
  }

  recordProviderRequest(session: SessionObservation, reservation?: ProviderRequestReservation): void {
    this.expireSession(session);
    this.assertWithinBudget();
    if (this.#modelCalls >= this.limits.maxModelCalls) {
      this.fail(`model calls reached ${this.limits.maxModelCalls}`);
    }
    if (reservation) {
      if (this.#unreservedCalls > 0) {
        this.fail("prior unanswered requests lack resource reservations; a fresh repository evidence lineage is required");
      }
      if (![reservation.inputTokens, reservation.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)
        || !Number.isFinite(reservation.costUsd) || reservation.costUsd < 0) {
        this.fail("invalid provider request reservation");
      }
      if (this.#inputTokens + this.#reservedInputTokens + reservation.inputTokens > this.limits.maxInputTokens) {
        throw new AuditBudgetExceededError("input token reservation exceeds the aggregate budget");
      }
      if (this.#outputTokens + this.#reservedOutputTokens + reservation.outputTokens > this.limits.maxOutputTokens) {
        throw new AuditBudgetExceededError("output token reservation exceeds the aggregate budget");
      }
      if (this.#costUsd + this.#reservedCostUsd + reservation.costUsd > this.limits.maxTotalCostUsd) {
        throw new AuditBudgetExceededError("cost reservation exceeds the aggregate budget");
      }
      this.#reservedInputTokens += reservation.inputTokens;
      this.#reservedOutputTokens += reservation.outputTokens;
      this.#reservedCostUsd += reservation.costUsd;
    } else {
      this.#unreservedCalls += 1;
    }
    session.reservations.push(reservation);
    this.#unreportedCalls += 1;
    session.admissionsObserved = true;
    session.requests += 1;
    this.#modelCalls += 1;
  }

  expireSession(session: SessionObservation): void {
    if (Date.now() - session.startedAt >= session.maxDurationMs) {
      this.exhaustSession(session);
    }
  }

  exhaustSession(session: SessionObservation): never {
    // The session is over, but the existing bounded recovery pass may still
    // use the aggregate allowance. Never reopen this expired session.
    throw new AuditBudgetExceededError(`session elapsed time reached ${session.maxDurationMs}ms`);
  }

  observeParentEvent(event: AgentSessionEvent, session: SessionObservation): void {
    const value = event as {
      type?: string;
      message?: { role?: string; stopReason?: string; usage?: UsageShape };
    };
    if (value.type !== "message_end" || value.message?.role !== "assistant") {
      this.expireSession(session);
      return;
    }
    const usage = value.message?.usage;
    const admitted = session.reservations.length > 0;
    const reservation = session.reservations.shift();
    // SDK abort/error messages may contain synthetic zero usage. Keep the
    // admitted upper bound indefinitely; cancellation is not a free response.
    const completed = usage !== undefined && value.message.stopReason !== "aborted"
      && value.message.stopReason !== "error"
      && (!reservation || (Number.isFinite(usage.input) && Number.isFinite(usage.output)
        && recordUsageValue(usage.input) + recordUsageValue(usage.cacheRead) + recordUsageValue(usage.cacheWrite) > 0
        && Number.isFinite(typeof usage.cost === "number" ? usage.cost : usage.cost?.total)));
    if (admitted && completed) {
      this.#unreportedCalls -= 1;
      if (reservation) {
        this.#reservedInputTokens -= reservation.inputTokens;
        this.#reservedOutputTokens -= reservation.outputTokens;
        this.#reservedCostUsd = Math.max(0, this.#reservedCostUsd - reservation.costUsd);
      } else {
        this.#unreservedCalls -= 1;
      }
    }
    session.calls += 1;
    session.turns += 1;
    const cost = usageCost(usage);
    session.costUsd += cost;
    // Legacy/test runtimes may only emit responses. Real runtimes charge at
    // admission, so an aborted request remains counted without a response.
    if (session.calls > session.requests) {
      this.#modelCalls += session.calls - session.requests;
      session.requests = session.calls;
    }
    this.#turns += 1;
    this.#inputTokens += recordUsageValue(usage?.input)
      + recordUsageValue(usage?.cacheRead)
      + recordUsageValue(usage?.cacheWrite);
    this.#outputTokens += recordUsageValue(usage?.output);
    this.#costUsd += cost;
    // A deadline denies further work; it cannot erase usage already incurred.
    this.expireSession(session);
    this.checkCounters();
    const observedInput = recordUsageValue(usage?.input)
      + recordUsageValue(usage?.cacheRead)
      + recordUsageValue(usage?.cacheWrite);
    const remainingInput = this.limits.maxInputTokens - this.#inputTokens;
    if (
      value.message.stopReason === "toolUse"
      && observedInput > 0
      && remainingInput < observedInput
    ) {
      this.fail(
        `input token reserve ${remainingInput} is below the estimated next provider request of ${observedInput}`,
      );
    }
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
    const reportedCalls = result.diagnostics?.provider_requests ?? result.turns;
    const additionalCalls = Math.max(0, reportedCalls - session.requests);
    // Legacy runtimes count tool-result deliveries as turns. With admission
    // hooks, keep responses separate so unanswered requests remain visible.
    const additionalTurns = session.admissionsObserved ? 0 : Math.max(0, reportedCalls - session.turns);
    const reportedCost = result.costUsd ?? 0;
    const additionalCost = Math.max(0, reportedCost - session.costUsd);
    this.#modelCalls += additionalCalls;
    this.#turns += additionalTurns;
    this.#costUsd += additionalCost;
    this.assertWithinBudget();
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

  reserveCoverageRecoveryPass(): void {
    this.assertWithinBudget();
    if (this.#coverageRecoveryPasses >= this.limits.maxCoverageRecoveryPasses) {
      this.fail(`coverage recovery passes reached ${this.limits.maxCoverageRecoveryPasses}`);
    }
    this.#coverageRecoveryPasses += 1;
  }

  reserveSemanticRepairPass(): void {
    this.assertWithinBudget();
    if (this.#semanticRepairPasses >= this.limits.maxSemanticRepairPasses) {
      this.fail(`semantic repair passes reached ${this.limits.maxSemanticRepairPasses}`);
    }
    this.#semanticRepairPasses += 1;
  }

  recordUnresolvedFingerprint(fingerprint: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error("unresolved-obligation fingerprint must be a lowercase SHA-256 digest");
    }
    this.#unresolvedFingerprints.push(fingerprint);
    const count = this.#unresolvedFingerprints.filter((value) => value === fingerprint).length;
    return count <= this.limits.maxRepeatedFingerprintStates;
  }

  unresolvedFingerprints(): string[] {
    return [...this.#unresolvedFingerprints];
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
    if (this.#priorElapsedMs + Date.now() - this.#startedAt > this.limits.maxTotalDurationMs) {
      this.fail(`elapsed time exceeded ${this.limits.maxTotalDurationMs}ms`);
    }
    this.checkCounters();
  }

  snapshot(): AuditResourceUsage & Record<string, number> {
    return {
      elapsed_ms: this.#priorElapsedMs + (Date.now() - this.#startedAt),
      model_calls: this.#modelCalls,
      turns: this.#turns,
      input_tokens: this.#inputTokens,
      output_tokens: this.#outputTokens,
      cost_usd: Number(this.#costUsd.toFixed(12)),
      explorer_spawns: this.#explorerSpawns,
      coverage_recovery_passes: this.#coverageRecoveryPasses,
      semantic_repair_passes: this.#semanticRepairPasses,
      unreported_calls: this.#unreportedCalls,
      unreserved_calls: this.#unreservedCalls,
      reserved_input_tokens: this.#reservedInputTokens,
      reserved_output_tokens: this.#reservedOutputTokens,
      reserved_cost_usd: Number(this.#reservedCostUsd.toFixed(12)),
    };
  }

  private checkCounters(): void {
    if (this.#modelCalls > this.limits.maxModelCalls) {
      this.fail(`model calls exceeded ${this.limits.maxModelCalls}`);
    }
    if (this.#turns > this.limits.maxTurns) this.fail(`turns exceeded ${this.limits.maxTurns}`);
    if (this.#inputTokens + this.#reservedInputTokens > this.limits.maxInputTokens) {
      this.fail(`input tokens exceeded ${this.limits.maxInputTokens}`);
    }
    if (this.#outputTokens + this.#reservedOutputTokens > this.limits.maxOutputTokens) {
      this.fail(`output tokens exceeded ${this.limits.maxOutputTokens}`);
    }
    if (this.#costUsd + this.#reservedCostUsd > this.limits.maxTotalCostUsd) {
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
