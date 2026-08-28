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
export function forceProviderToolChoice(payload: unknown, api: string, toolName: string): unknown {
  if (!record(payload)) return payload;
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

/** Apply an application-owned per-request output ceiling to known wire shapes. */
export function capProviderOutputTokens(payload: unknown, api: string, maximum: number): unknown {
  if (!record(payload) || !Number.isInteger(maximum) || maximum < 1) return payload;
  if (api === "anthropic-messages") {
    return { ...payload, max_tokens: boundedTokenValue(payload.max_tokens, maximum) };
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
    let sawRequiredRecoveryTool = false;
    let providerRequests = 0;
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
          pi.on("tool_call", makeDefenseHook({ executionPolicy: options.executionPolicy }));
          if (recovery && options.forceRequiredToolChoice === true) {
            pi.on("before_provider_request", (event) => {
              providerRequests += 1;
              const api = selectedModel?.api ?? "";
              const boundedPayload = options.maxOutputTokens === undefined
                ? event.payload
                : capProviderOutputTokens(event.payload, api, options.maxOutputTokens);
              if (options.maxOutputTokens !== undefined) cappedOutputRequests += 1;
              if (sawRequiredRecoveryTool || recovery.shouldRecover?.() === false) return boundedPayload;
              forcedToolChoiceRequests += 1;
              return forceProviderToolChoice(boundedPayload, api, recovery.requiredToolName);
            });
          } else if (recovery && options.forceRequiredToolChoiceAfterTurns !== undefined) {
            const turnBudget = options.forceRequiredToolChoiceAfterTurns;
            pi.on("before_provider_request", (event) => {
              providerRequests += 1;
              const api = selectedModel?.api ?? "";
              const boundedPayload = options.maxOutputTokens === undefined
                ? event.payload
                : capProviderOutputTokens(event.payload, api, options.maxOutputTokens);
              if (options.maxOutputTokens !== undefined) cappedOutputRequests += 1;
              if (sawRequiredRecoveryTool || recovery.shouldRecover?.() === false) return boundedPayload;
              if (providerRequests < turnBudget) return boundedPayload;
              forcedToolChoiceRequests += 1;
              return forceProviderToolChoice(boundedPayload, api, recovery.requiredToolName);
            });
          } else if (options.maxOutputTokens !== undefined) {
            pi.on("before_provider_request", (event) => {
              providerRequests += 1;
              cappedOutputRequests += 1;
              return capProviderOutputTokens(event.payload, selectedModel?.api ?? "", options.maxOutputTokens ?? 1);
            });
          } else {
            pi.on("before_provider_request", (event) => {
              providerRequests += 1;
              return event.payload;
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
