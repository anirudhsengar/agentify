import type { AgentifyConfig, AgentRuntime, AgentRuntimeResult } from "../types.ts";
import { NoAuthForProviderError, SlotModelMissingError } from "../models/resolver.ts";
import { createReadOnlyExecutionPolicy } from "../security/execution-policy.ts";

export interface ProviderProbeResult {
  ok: boolean;
  /** Provider slug the failure is attributable to, when known. */
  provider: string | null;
}

function probeFailureProvider(diagnostics: AgentRuntimeResult["diagnostics"]): string | null {
  if (!diagnostics || !diagnostics.assistant_stop_reasons.includes("error")) return null;
  return diagnostics.provider ?? diagnostics.provider_api ?? null;
}

/**
 * Cheap, tool-free reachability check for the currently configured model.
 * Sends a single trivial prompt with no tool access and a tight inactivity
 * timeout, so a missing/invalid/expired credential is caught before the
 * real audit's banner, spinner, gap-map bootstrap, and log files start —
 * instead of discovering it after a full (if fast-failing) audit attempt.
 */
export async function probeProviderReachable(
  runtime: AgentRuntime,
  cwd: string,
  configDir: string,
  config: AgentifyConfig,
): Promise<ProviderProbeResult> {
  try {
    const result = await runtime.runSession({
      cwd,
      configDir,
      config,
      systemPrompt: "You are a connectivity check. Reply with exactly one word.",
      userPrompt: "Reply with the single word OK.",
      tools: [],
      executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: [] }),
      inactivityTimeoutMs: 20_000,
      maxOutputTokens: 8,
    });
    const failedProvider = probeFailureProvider(result.diagnostics);
    if (failedProvider) return { ok: false, provider: failedProvider };
    return { ok: true, provider: result.diagnostics?.provider ?? result.diagnostics?.provider_api ?? null };
  } catch (error) {
    if (error instanceof NoAuthForProviderError) return { ok: false, provider: error.provider };
    if (error instanceof SlotModelMissingError) return { ok: false, provider: error.slot.provider };
    throw error;
  }
}
