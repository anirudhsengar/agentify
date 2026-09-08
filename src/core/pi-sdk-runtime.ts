import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
} from "./types.ts";
import { authPath } from "./agentify-config.ts";
import { getProviderEnvValue } from "./provider-auth.ts";
import { makeDefenseHook } from "./audit/defense-hook.ts";
import { createSpawnExplorerTool } from "./audit/spawn-explorer-tool.ts";
import { resolveModelOrThrow, selectModelForRole } from "./models/resolver.ts";
import { resolvePackageRoot } from "./package-root.ts";
import {
  assertRequestedToolsAllowed,
} from "./security/execution-policy.ts";
import { createAgentifyModelRuntime } from "./pi-credential-store.ts";
import { providerRequestReservation } from "./audit/resource-budget.ts";
import { AuditCheckpointCadence } from "./audit/checkpoint-cadence.ts";
import { withInitialScoutCheckpoint } from "./audit/initial-scout-checkpoint.ts";
import { bindStructuredToolErrors } from "./structured-tool-errors.ts";

type UsageLike = {
  cost?: { total?: number };
};

type MessageEndEventLike = {
  type?: string;
  message?: { usage?: UsageLike };
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply a provider-native required-tool directive to the final request body.
 * Unknown APIs retain their existing prompt/recovery behavior instead of
 * receiving a guessed wire shape.
 */
export function forceProviderToolChoice(payload: unknown, api: string, toolName: string | readonly string[], provider?: string, modelId?: string): unknown {
  if (!record(payload)) return payload;
  if (api === "anthropic-messages" && (provider === "minimax" || provider === "minimax-cn")) {
    // The verified international M3 endpoint accepts named/any selection with
    // thinking enabled. Preserve auto for older models and unverified backends;
    // the model identity comes from trusted registry metadata, not payload text.
    const nativeM3 = provider === "minimax" && modelId === "MiniMax-M3";
    const allowedNames = typeof toolName === "string" ? [toolName] : toolName;
    if (allowedNames.length === 0) return payload;
    return {
      ...payload,
      ...(Array.isArray(payload.tools) ? { tools: payload.tools.filter((tool) => record(tool) && typeof tool.name === "string" && allowedNames.includes(tool.name)) } : {}),
      tool_choice: nativeM3
        ? allowedNames.length === 1 ? { type: "tool", name: allowedNames[0] } : { type: "any" }
        : { type: "auto" },
    };
  }
  // Alternative terminal sets use only the verified MiniMax branch above.
  // Never guess forcing shapes for other APIs.
  if (typeof toolName !== "string") return payload;
  if (api === "anthropic-messages") {
    const next = { ...payload };
    delete next.output_config;
    if ("thinking" in next) next.thinking = { type: "disabled" };
    next.tool_choice = { type: "tool", name: toolName, disable_parallel_tool_use: true };
    return next;
  }
  if (api === "openai-completions") {
    return {
      ...payload,
      tool_choice: { type: "function", function: { name: toolName } },
      parallel_tool_calls: false,
    };
  }
  if (api === "openai-responses" || api === "openai-codex-responses") {
    return {
      ...payload,
      tool_choice: { type: "function", name: toolName },
      parallel_tool_calls: false,
    };
  }
  if (api === "google-generative-ai" || api === "google-vertex") {
    const config = record(payload.config) ? payload.config : {};
    return {
      ...payload,
      config: {
        ...config,
        toolConfig: {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolName] },
        },
      },
    };
  }
  if (api === "bedrock-converse-stream") {
    const toolConfig = record(payload.toolConfig) ? payload.toolConfig : {};
    return { ...payload, toolConfig: { ...toolConfig, toolChoice: { tool: { name: toolName } } } };
  }
  if (api === "mistral-conversations") {
    return { ...payload, toolChoice: { type: "function", function: { name: toolName } } };
  }
  if (api === "pi-messages") {
    const options = record(payload.options) ? payload.options : {};
    return {
      ...payload,
      options: { ...options, toolChoice: { type: "function", function: { name: toolName } } },
    };
  }
  return payload;
}

function boundedTokenValue(current: unknown, maximum: number): number {
  return typeof current === "number" && Number.isFinite(current) && current > 0
    ? Math.min(current, maximum)
    : maximum;
}

const THINKING_ANSWER_RESERVE_TOKENS = 1_024;
const MIN_ENABLED_THINKING_TOKENS = 1_024;

/** M3 documents adaptive/disabled thinking, not Claude's enabled token budget. */
export function normalizeMiniMaxThinking(payload: unknown, api: string, provider?: string, modelId?: string): unknown {
  if (api !== "anthropic-messages" || provider !== "minimax" || modelId !== "MiniMax-M3"
    || !record(payload) || !record(payload.thinking) || payload.thinking.type !== "enabled") return payload;
  // Apply after output-cap validation. Total output and cost reservations are
  // unchanged; an unsupported reasoning allowance is not a provider bound.
  // https://platform.minimax.io/docs/api-reference/text-anthropic-api
  return { ...payload, thinking: { type: "adaptive" } };
}

/** Apply an application-owned per-request output ceiling to known wire shapes. */
export function capProviderOutputTokens(payload: unknown, api: string, maximum: number): unknown {
  if (!record(payload) || !Number.isInteger(maximum) || maximum < 1) return payload;
  if (api === "anthropic-messages") {
    const maxTokens = boundedTokenValue(payload.max_tokens, maximum);
    const thinking = payload.thinking;
    if (record(thinking) && thinking.type === "enabled"
      && typeof thinking.budget_tokens === "number" && Number.isFinite(thinking.budget_tokens)
      && thinking.budget_tokens > 0) {
      // The SDK fits thinking before our final output cap is applied. Reapply
      // its answer reserve inside the stricter envelope, never above it.
      const available = maxTokens - THINKING_ANSWER_RESERVE_TOKENS;
      if (available < MIN_ENABLED_THINKING_TOKENS) {
        throw new Error("output ceiling cannot fit enabled thinking and the 1024-token answer reserve");
      }
      return { ...payload, max_tokens: maxTokens,
        thinking: { ...thinking, budget_tokens: Math.min(thinking.budget_tokens, available) } };
    }
    return { ...payload, max_tokens: maxTokens };
  }
  if (api === "openai-completions") {
    if ("max_completion_tokens" in payload) {
      return {
        ...payload,
        max_completion_tokens: boundedTokenValue(payload.max_completion_tokens, maximum),
      };
    }
    return { ...payload, max_tokens: boundedTokenValue(payload.max_tokens, maximum) };
  }
  if (api === "openai-codex-responses") {
    // The ChatGPT Codex backend rejects `max_output_tokens` outright
    // ("Codex error: Unsupported parameter: max_output_tokens") — pi-ai's own
    // codex API never sends it. Injecting it here fails every request.
    return payload;
  }
  if (api === "openai-responses") {
    return { ...payload, max_output_tokens: boundedTokenValue(payload.max_output_tokens, maximum) };
  }
  if (api === "google-generative-ai" || api === "google-vertex") {
    const config = record(payload.config) ? payload.config : {};
    return {
      ...payload,
      config: { ...config, maxOutputTokens: boundedTokenValue(config.maxOutputTokens, maximum) },
    };
  }
  if (api === "bedrock-converse-stream") {
    const inferenceConfig = record(payload.inferenceConfig) ? payload.inferenceConfig : {};
    return {
      ...payload,
      inferenceConfig: {
        ...inferenceConfig,
        maxTokens: boundedTokenValue(inferenceConfig.maxTokens, maximum),
      },
    };
  }
  if (api === "mistral-conversations") {
    return { ...payload, maxTokens: boundedTokenValue(payload.maxTokens, maximum) };
  }
  if (api === "pi-messages") {
    const providerOptions = record(payload.options) ? payload.options : {};
    return {
      ...payload,
      options: {
        ...providerOptions,
        maxTokens: boundedTokenValue(providerOptions.maxTokens, maximum),
      },
    };
  }
  return payload;
}

/** Keep provider diagnostics bounded and redact credential-shaped or known secret values. */
export function providerFailureSummary(value: unknown, secrets: ReadonlyArray<string | undefined> = []): string {
  let text = typeof value === "string" && value.trim()
    ? value
    : "provider returned an error without diagnostic details";
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    for (const encoded of [secret, JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString("base64")]) {
      text = text.split(encoded).join("[REDACTED]");
    }
  }
  text = text
    .replace(/(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/Authorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;]+/gi, "Authorization: [REDACTED]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return text.length <= 2_000 ? text : `${text.slice(0, 1_980)}[TRUNCATED]`;
}

export class PiSdkRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    const envKey = options.config.provider
      ? getProviderEnvValue(options.config.provider)
      : undefined;
    const { modelRuntime, modelRegistry } = await createAgentifyModelRuntime({
      authFile: authPath(options.configDir),
      modelsFile: path.join(options.configDir, "models.json"),
      ...(options.config.provider && envKey
        ? { runtimeApiKey: { provider: options.config.provider, key: envKey } }
        : {}),
    });
    const selectedModel = resolveModelOrThrow(
      modelRegistry,
      options.config,
      options.modelRole ?? "primary",
    );
    options.auditResourceBudget?.assertProviderSessionCapacity(selectedModel?.contextWindow ?? 0);
    let sawRequiredRecoveryTool = false;
    let providerRequests = 0;
    let admissionFailure: { error: unknown } | undefined;
    let lastAssistantError: string | undefined;
    let forcedToolChoiceRequests = 0;
    let cappedOutputRequests = 0;
    const eventCounts = new Map<string, number>();
    const toolExecutionCounts = new Map<string, { started: number; ended: number; errors: number }>();
    const assistantStopReasons = new Set<string>();

    let explorerModelForSpawn: typeof selectedModel = selectedModel;
    if (options.spawnExplorerAgentDir) {
      const explorerResolved = selectModelForRole(
        modelRegistry,
        options.config,
        "explorer",
      );
      if (explorerResolved) explorerModelForSpawn = explorerResolved.model;
    }

    const customTools = [...(options.customTools ?? [])];
    if (options.spawnExplorerAgentDir && explorerModelForSpawn) {
      if (!options.spawnExplorerStateDir) {
        throw new Error("spawnExplorerStateDir is required when spawnExplorerAgentDir is configured");
      }
      customTools.push(
        createSpawnExplorerTool({
          agentDir: options.spawnExplorerAgentDir,
          stateDir: options.spawnExplorerStateDir,
          purpose: options.spawnExplorerPurpose,
          explorerModel: explorerModelForSpawn,
          resourceBudget: options.auditResourceBudget,
          maxTotalSpawns: options.auditResourceBudget?.limits.maxExplorerSpawns,
          maxTotalCostUsd: options.auditResourceBudget?.limits.maxTotalCostUsd,
          maxSubagentDurationMs: options.auditResourceBudget
            ? Math.max(
              options.auditResourceBudget.limits.maxScoutDurationMs,
              options.auditResourceBudget.limits.maxTracerDurationMs,
              options.auditResourceBudget.limits.maxExplorerDurationMs,
            )
            : undefined,
        }),
      );
    }
    const recovery = options.recoveryPromptIfToolNotCalled;
    if (recovery && !customTools.some((tool) => tool.name === recovery.requiredToolName)) {
      throw new Error(`required recovery tool is not registered: ${recovery.requiredToolName}`);
    }

    assertRequestedToolsAllowed(
      options.tools,
      options.executionPolicy,
      customTools.map((tool) => tool.name),
    );

    // Only the parent map audit schedules periodic checkpoints. Explicit
    // terminal-tool protocols and other roles retain their existing behavior.
    const checkpointCadence = options.auditResourceBudget
      && options.spawnExplorerPurpose !== "specialist-repair"
      && options.executionPolicy.mode === "audit-readonly"
      && options.tools.includes("spawn_explorer")
      && options.tools.includes("write_map_delta")
      && options.forceRequiredToolChoice !== true
      && options.forceRequiredToolChoiceAfterTurns === undefined
      ? new AuditCheckpointCadence()
      : undefined;
    if (checkpointCadence) {
      const index = customTools.findIndex((tool) => tool.name === "write_map_delta");
      const tool = customTools[index];
      if (tool) customTools[index] = {
        ...tool,
        description: `${tool.description} After four successful direct file-inspection calls since the last validated map write, the runtime may restrict the next request to this tool until a checkpoint succeeds. Persist only facts already observed; leave unsupported coverage as gaps and never invent evidence to satisfy the checkpoint.`,
      };
    }

    const initialScout = customTools.find(tool => tool.name === "spawn_explorer");
    if (checkpointCadence && options.spawnExplorerPurpose !== "coverage-recovery"
      && options.spawnExplorerStateDir && options.spawnExplorerAgentDir
      && options.onEvent && initialScout) {
      customTools.splice(0, customTools.length, ...withInitialScoutCheckpoint(customTools, {
        stateDir: options.spawnExplorerStateDir,
        scout: initialScout,
        onEvent: options.onEvent,
      }));
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.configDir,
      noContextFiles: true,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [],
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: [],
      extensionFactories: [
        (pi) => {
          const defenseHook = makeDefenseHook({ executionPolicy: options.executionPolicy });
          pi.on("tool_call", async event => {
            const denied = await defenseHook(event);
            if (denied) return denied;
            const reason = checkpointCadence?.inspectionBlockReason(event.toolName);
            return reason === undefined ? undefined : { block: true, reason };
          });
          const admitProviderRequest = (payload: unknown): unknown => {
            let requestPayload = payload;
            try {
              if (aborted || options.signal?.aborted) throw new Error("provider request cancelled");
              if (options.maxOutputTokens !== undefined) {
                requestPayload = capProviderOutputTokens(requestPayload, selectedModel?.api ?? "", options.maxOutputTokens);
                cappedOutputRequests += 1;
              }
              requestPayload = normalizeMiniMaxThinking(requestPayload, selectedModel?.api ?? "",
                selectedModel?.provider, selectedModel?.id);
              if (checkpointCadence?.due) {
                const before = requestPayload;
                requestPayload = forceProviderToolChoice(requestPayload, selectedModel?.api ?? "", "write_map_delta", selectedModel?.provider, selectedModel?.id);
                if (requestPayload !== before) forcedToolChoiceRequests += 1;
              }
              const inputTokenBound = options.auditResourceBudget?.assertProviderInputCapacity(requestPayload);
              options.onProviderRequest?.(selectedModel
                ? providerRequestReservation(selectedModel,
                  options.maxOutputTokens !== undefined
                    && capProviderOutputTokens(requestPayload, selectedModel.api, options.maxOutputTokens) !== requestPayload
                    ? options.maxOutputTokens : undefined,
                  inputTokenBound)
                : undefined);
            } catch (error) {
              // SDK extension errors are logged and swallowed. Cancel the
              // transport before its runner can dispatch the original payload.
              admissionFailure = { error };
              abortSession();
              throw error;
            }
            providerRequests += 1;
            return requestPayload;
          };
          if (recovery && options.forceRequiredToolChoice === true) {
            pi.on("before_provider_request", (event) => {
              const api = selectedModel?.api ?? "";
              if (sawRequiredRecoveryTool || recovery.shouldRecover?.() === false) {
                return admitProviderRequest(event.payload);
              }
              forcedToolChoiceRequests += 1;
              return admitProviderRequest(
                forceProviderToolChoice(event.payload, api, recovery.requiredToolName, selectedModel?.provider, selectedModel?.id),
              );
            });
          } else if (recovery && options.forceRequiredToolChoiceAfterTurns !== undefined) {
            const turnBudget = options.forceRequiredToolChoiceAfterTurns;
            pi.on("before_provider_request", (event) => {
              const api = selectedModel?.api ?? "";
              if (sawRequiredRecoveryTool || recovery.shouldRecover?.() === false) {
                return admitProviderRequest(event.payload);
              }
              if (providerRequests + 1 < turnBudget) return admitProviderRequest(event.payload);
              forcedToolChoiceRequests += 1;
              return admitProviderRequest(
                forceProviderToolChoice(event.payload, api, recovery.requiredToolName, selectedModel?.provider, selectedModel?.id),
              );
            });
          } else {
            pi.on("before_provider_request", (event) => {
              return admitProviderRequest(event.payload);
            });
          }
        },
      ],
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd: options.cwd,
      agentDir: options.configDir,
      modelRuntime,
      model: selectedModel,
      thinkingLevel: options.config.thinkingLevel,
      resourceLoader,
      tools: options.tools,
      customTools,
      sessionManager: SessionManager.inMemory(options.cwd),
    });
    const session = created.session;
    bindStructuredToolErrors(session.agent);
    let turns = 0;
    let costUsd = 0;
    let sawCost = false;
    let aborted = false;
    let resolveAbort: (() => void) | undefined;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const abortSession = (): void => {
      if (aborted) return;
      aborted = true;
      // Always release the caller first. SDK cleanup reaches provider-owned
      // abort hooks and must not be allowed to keep a repository transaction
      // open if one of those hooks stalls or throws.
      resolveAbort?.();
      // AgentSession.abort stops the active stream, but leaves queued follow-up
      // turns intact. A provider can queue its next tool continuation before
      // the closure callback runs, which otherwise restarts the audit after a
      // successful map has already been persisted.
      try {
        session.clearQueue();
        // abort() waits for the provider to become idle. A provider can fail
        // to settle forever, so dispose immediately after signalling
        // cancellation; this severs SDK listeners without waiting on that
        // untrusted remote state.
        session.dispose();
      } catch {
        // Cancellation has already released the caller. Cleanup is best-effort
        // because provider hooks are outside Agentify's trust boundary.
      }
    };
    const promptUntilAbort = async (userPrompt: string): Promise<void> => {
      await Promise.race([session.prompt(userPrompt), abortPromise]);
      if (admissionFailure) {
        const error = admissionFailure.error;
        // A provider failure can trigger an SDK retry that our existing cap
        // refuses. Keep the typed admission failure, but do not hide the
        // original bounded/redacted provider diagnostic behind that cap.
        if (error instanceof Error && lastAssistantError !== undefined) {
          error.message += `; preceding provider failure (${selectedModel?.provider ?? "unknown"}): ${lastAssistantError}`;
        }
        throw error;
      }
      // Pi resolves prompt() after its own retry/compaction loop, including on
      // a final provider error. Structured-output recovery must not start a
      // fresh series of requests against that failed transport.
      if (!aborted && lastAssistantError !== undefined) {
        throw new Error(`provider session failed (${selectedModel?.provider ?? "unknown"}): ${lastAssistantError}`);
      }
    };
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const resetInactivityTimer = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (options.inactivityTimeoutMs && options.inactivityTimeoutMs > 0) {
        inactivityTimer = setTimeout(() => {
          abortSession();
        }, options.inactivityTimeoutMs);
      }
    };
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      resetInactivityTimer();
      checkpointCadence?.observe(event);
      if (event.type === "message_end" && event.message.role === "assistant") {
        // A later successful SDK retry supersedes the earlier failure. User
        // messages and tool results cannot erase a failed assistant response.
        lastAssistantError = event.message.stopReason === "error"
          ? providerFailureSummary(event.message.errorMessage, [envKey])
          : undefined;
      }
      options.onEvent?.(event);
      const structuralEvent = event as { type?: unknown; message?: { stopReason?: unknown } };
      if (typeof structuralEvent.type === "string" && /^[a-z0-9_-]{1,64}$/u.test(structuralEvent.type)) {
        eventCounts.set(structuralEvent.type, (eventCounts.get(structuralEvent.type) ?? 0) + 1);
      }
      if (structuralEvent.type === "message_end" && typeof structuralEvent.message?.stopReason === "string") {
        assistantStopReasons.add(structuralEvent.message.stopReason.slice(0, 64));
      }
      const structuralTool = event as { type?: unknown; toolName?: unknown; isError?: unknown };
      if (
        (structuralTool.type === "tool_execution_start" || structuralTool.type === "tool_execution_end")
        && typeof structuralTool.toolName === "string"
        && /^[a-z0-9_-]{1,64}$/u.test(structuralTool.toolName)
      ) {
        const counts = toolExecutionCounts.get(structuralTool.toolName) ?? { started: 0, ended: 0, errors: 0 };
        if (structuralTool.type === "tool_execution_start") counts.started += 1;
        else {
          counts.ended += 1;
          if (structuralTool.isError === true) counts.errors += 1;
        }
        toolExecutionCounts.set(structuralTool.toolName, counts);
      }
      const eventLike = event as MessageEndEventLike;
      if (eventLike.type === "message_end") {
        turns += 1;
        const cost = eventLike.message?.usage?.cost?.total;
        if (typeof cost === "number") {
          costUsd += cost;
          sawCost = true;
        }
      }
      const requiredToolEvent = event as { type?: unknown; toolName?: unknown; isError?: unknown };
      if (
        recovery
        && requiredToolEvent.type === "tool_execution_end"
        && requiredToolEvent.toolName === recovery.requiredToolName
        && requiredToolEvent.isError === false
      ) {
        sawRequiredRecoveryTool = true;
      }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.signal) {
        if (options.signal.aborted) {
          abortSession();
        } else {
          options.signal.addEventListener(
            "abort",
            () => {
              abortSession();
            },
            { once: true },
          );
        }
      }
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          abortSession();
        }, options.timeoutMs);
      }
      resetInactivityTimer();
      await promptUntilAbort(options.userPrompt);
      const recoveryNeeded = (): boolean =>
        !sawRequiredRecoveryTool || recovery?.shouldRecover?.() === true;
      for (
        let attempt = 0;
        !aborted && recovery && recoveryNeeded() && attempt < recovery.maxAttempts;
        attempt += 1
      ) {
        const userPrompt = attempt === 0
          ? recovery.userPrompt
          : [
            `Do not send another prose response. Call ${recovery.requiredToolName} now as your only next action.`,
            "Use the evidence already in this session and submit the missing structured payload.",
          ].join(" ");
        await promptUntilAbort(userPrompt);
      }
      return {
        turns,
        costUsd: sawCost ? costUsd : null,
        aborted,
        diagnostics: {
          provider: selectedModel?.provider ?? null,
          provider_api: selectedModel?.api ?? null,
          provider_requests: providerRequests,
          forced_tool_choice_requests: forcedToolChoiceRequests,
          capped_output_requests: cappedOutputRequests,
          configured_output_cap: options.maxOutputTokens ?? null,
          event_counts: Object.fromEntries([...eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
          tool_execution_counts: Object.fromEntries([...toolExecutionCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
          assistant_stop_reasons: [...assistantStopReasons].sort(),
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      unsubscribe();
      session.dispose();
    }
  }

}

export function packageRoot(): string {
  return resolvePackageRoot();
}
