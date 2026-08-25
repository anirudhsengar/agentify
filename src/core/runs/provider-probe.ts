import type { AgentifyConfig, AgentRuntime, AgentRuntimeResult } from "../types.ts";
import { NoAuthForProviderError, SlotModelMissingError } from "../models/resolver.ts";
import { createReadOnlyExecutionPolicy } from "../security/execution-policy.ts";

export interface ProviderProbeResult {
  ok: boolean;
  /** Provider slug the failure is attributable to, when known. */
  provider: string | null;
  /**
   * First provider error message observed during the probe, when any. The
   * session surface only reports stop-reason counts, so without this the
   * actual cause (e.g. a rejected request parameter) never reaches the user.
   */
  detail: string | null;
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
  let detail: string | null = null;
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
      onEvent: (event) => {
        if (detail) return;
        const message = (event as { type?: unknown; message?: unknown }).message;
        if ((event as { type?: unknown }).type !== "message_end" || typeof message !== "object" || message === null) return;
        const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
        if (typeof errorMessage === "string" && errorMessage.trim().length > 0) {
          detail = errorMessage.replaceAll(/\s+/g, " ").trim().slice(0, 300);
        }
      },
    });
    const failedProvider = probeFailureProvider(result.diagnostics);
    if (failedProvider) return { ok: false, provider: failedProvider, detail };
    return { ok: true, provider: result.diagnostics?.provider ?? result.diagnostics?.provider_api ?? null, detail };
  } catch (error) {
    if (error instanceof NoAuthForProviderError) return { ok: false, provider: error.provider, detail };
    if (error instanceof SlotModelMissingError) return { ok: false, provider: error.slot.provider, detail };
    throw error;
  }
}
