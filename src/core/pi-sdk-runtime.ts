import * as path from "node:path";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
  AgentifyConfig,
} from "./types.ts";
import { authPath } from "./agentify-config.ts";
import { getProviderEnvValue } from "./provider-auth.ts";
import { makeDefenseHook } from "./audit/defense-hook.ts";
import { createWriteGreenfieldArtifactsTool } from "./greenfield-artifacts.ts";
import { createSpawnExplorerTool } from "./audit/spawn-explorer-tool.ts";
import { resolveModelOrThrow, selectModelForRole } from "./models/resolver.ts";
import { shippedSkillsSourceDir } from "./shipped-paths.ts";
import { resolvePackageRoot } from "./package-root.ts";
import {
  assertRequestedToolsAllowed,
  createRepositoryWriteExecutionPolicy,
} from "./security/execution-policy.ts";

const PACKAGE_ROOT = resolvePackageRoot();
const SHIPPED_SKILLS_DIR = shippedSkillsSourceDir(PACKAGE_ROOT);

type UsageLike = {
  cost?: { total?: number };
};

type MessageEndEventLike = {
  type?: string;
  message?: { usage?: UsageLike };
};

export class PiSdkRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    const authStorage = AuthStorage.create(authPath(options.configDir));
    if (options.config.provider) {
      const envKey = getProviderEnvValue(options.config.provider);
      if (envKey) authStorage.setRuntimeApiKey(options.config.provider, envKey);
    }
    const modelRegistry = ModelRegistry.create(authStorage, path.join(options.configDir, "models.json"));
    const selectedModel = resolveModelOrThrow(
      modelRegistry,
      options.config,
      options.modelRole ?? "primary",
    );

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
          modelRegistry,
        }),
      );
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
      noSkills: !options.additionalSkillPaths?.length,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: options.additionalSkillPaths ?? [],
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: [],
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", makeDefenseHook({
            executionPolicy: options.executionPolicy,
            agentDomain: options.agentDomain ?? null,
            repoJail: options.repoJail ?? false,
            protectedPaths: options.protectedPaths,
          }));
        },
      ],
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd: options.cwd,
      agentDir: options.configDir,
      authStorage,
      modelRegistry,
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
    let sawRequiredRecoveryTool = false;
    let resolveAbort: (() => void) | undefined;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const abortSession = (): void => {
      if (aborted) return;
      aborted = true;
      // AgentSession.abort stops the active stream, but leaves queued follow-up
      // turns intact. A provider can queue its next tool continuation before
      // the closure callback runs, which otherwise restarts the audit after a
      // successful map has already been persisted.
      session.clearQueue();
      // abort() waits for the provider to become idle. A provider can fail to
      // settle forever, so dispose immediately after signalling cancellation;
      // this severs SDK listeners and releases the session without waiting on
      // that untrusted remote state.
      session.dispose();
      resolveAbort?.();
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
      const eventLike = event as MessageEndEventLike;
      if (eventLike.type === "message_end") {
        turns += 1;
        const cost = eventLike.message?.usage?.cost?.total;
        if (typeof cost === "number") {
          costUsd += cost;
          sawCost = true;
        }
      }
      const recovery = options.recoveryPromptIfToolNotCalled;
      const toolName = (event as { toolName?: string; tool_name?: string }).toolName
        ?? (event as { tool_name?: string }).tool_name;
      if (recovery && toolName === recovery.requiredToolName) {
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
      const recovery = options.recoveryPromptIfToolNotCalled;
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
      return { turns, costUsd: sawCost ? costUsd : null, aborted };
    } finally {
      if (timer) clearTimeout(timer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      unsubscribe();
      session.dispose();
    }
  }

  async runGreenfield(options: {
    cwd: string;
    configDir: string;
    config: AgentifyConfig;
    stateDir: string;
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
  }): Promise<AgentRuntimeResult> {
    const systemPrompt = [
      "You are agentify running in standalone greenfield mode.",
      "Interview the user in the terminal and drive a local-first, checkpointed pipeline.",
      "Initial formation stays in this terminal: drill-me/domain-modeling -> GOALS.md, then stop at a clear next-action checkpoint.",
      "Do not auto-drill every Goal or Sub-goal. Work on one selected unit at a time, recording progress in GOALS.md or docs/goals/*.md.",
      "For a selected unit, continue only as far as the user approves: drill-me -> docs/prds -> docs/plans -> docs/issues -> specs -> implement/review/fix.",
      "After GOALS.md, after each split, and after each PRD/plan/issues/spec/implementation milestone, present the next valid actions and let the user choose whether to continue, switch units, or stop.",
      "GitHub issues labeled `agent:drill-me` are the post-launch async intake only; do not require them for first-stage greenfield formation.",
      "Use the shipped agentify skills as your workflow source of truth.",
      "For planning artifacts, do not write CONTEXT.md, GOALS.md, docs/prds, docs/plans, docs/issues, or specs directly.",
      "Instead call the `write_greenfield_artifacts` tool with the structured formation payload; agentify renders those files deterministically after the session.",
      "The `stop_at` field is a hard gate: use `stop_at: \"goals\"` for first formation unless the user explicitly approves continuing to PRD, plan, issue_slices, or spec in this same session.",
      "Never include PRDs, plans, issues, or specs beyond the declared `stop_at`; agentify will reject the payload and the repo will remain partial.",
      "Write local implementation code only after the user explicitly approves implementation. Commit only after successful validation and review; never push.",
    ].join("\n");
    const tools = ["read", "grep", "find", "ls", "bash", "write", "edit"];
    return this.runSession({
      cwd: options.cwd,
      configDir: options.configDir,
      config: options.config,
      systemPrompt,
      userPrompt: "This is a greenfield repository. Start by asking what we are building, then run the full local-first agentify loop.",
      tools,
      executionPolicy: createRepositoryWriteExecutionPolicy({
        cwd: options.cwd,
        tools,
        allowDevelopmentCommands: true,
      }),
      signal: options.signal,
      onEvent: options.onEvent,
      customTools: [createWriteGreenfieldArtifactsTool({ stateDir: options.stateDir })],
      additionalSkillPaths: [SHIPPED_SKILLS_DIR],
    });
  }
}

export function packageRoot(): string {
  return PACKAGE_ROOT;
}

export function shippedSkillsDir(): string {
  return SHIPPED_SKILLS_DIR;
}
