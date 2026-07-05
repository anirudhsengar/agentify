import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
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

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED_SKILLS_DIR = path.join(PACKAGE_ROOT, ".agents", "skills");

type UsageLike = {
  cost?: { total?: number };
};

type MessageEndEventLike = {
  type?: string;
  message?: { usage?: UsageLike };
};

function selectModel(
  registry: ModelRegistry,
  config: AgentifyConfig,
): Model<Api> | undefined {
  if (config.provider && config.model) {
    return registry.find(config.provider, config.model);
  }
  const available = registry.getAvailable();
  if (config.provider) {
    return available.find((model) => model.provider === config.provider);
  }
  return available[0];
}

export class PiSdkRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    const authStorage = AuthStorage.create(authPath(options.configDir));
    if (options.config.provider) {
      const envKey = getProviderEnvValue(options.config.provider);
      if (envKey) authStorage.setRuntimeApiKey(options.config.provider, envKey);
    }
    const modelRegistry = ModelRegistry.create(authStorage, path.join(options.configDir, "models.json"));
    const selectedModel = selectModel(modelRegistry, options.config);
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
      customTools: options.customTools,
      sessionManager: SessionManager.inMemory(options.cwd),
    });
    const session = created.session;
    let turns = 0;
    let costUsd = 0;
    let sawCost = false;
    let aborted = false;

    const done = new Promise<void>((resolve) => {
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        options.onEvent?.(event);
        const eventLike = event as MessageEndEventLike;
        if (eventLike.type === "message_end") {
          turns += 1;
          const cost = eventLike.message?.usage?.cost?.total;
          if (typeof cost === "number") {
            costUsd += cost;
            sawCost = true;
          }
        } else if ((event as { type?: string }).type === "agent_end") {
          const willRetry = (event as { willRetry?: boolean }).willRetry ?? false;
          if (!willRetry) {
            unsubscribe();
            resolve();
          }
        }
      });
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.signal) {
        if (options.signal.aborted) {
          aborted = true;
          await session.abort();
        } else {
          options.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              void session.abort();
            },
            { once: true },
          );
        }
      }
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          aborted = true;
          void session.abort();
        }, options.timeoutMs);
      }
      await session.prompt(options.userPrompt);
      await done;
      return { turns, costUsd: sawCost ? costUsd : null, aborted };
    } finally {
      if (timer) clearTimeout(timer);
      session.dispose();
    }
  }

  async runGreenfield(options: {
    cwd: string;
    configDir: string;
    config: AgentifyConfig;
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
      "Write local artifacts instead of requiring GitHub. Commit only after successful validation and review; never push.",
    ].join("\n");
    return this.runSession({
      cwd: options.cwd,
      configDir: options.configDir,
      config: options.config,
      systemPrompt,
      userPrompt: "This is a greenfield repository. Start by asking what we are building, then run the full local-first agentify loop.",
      tools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
      signal: options.signal,
      onEvent: options.onEvent,
      customTools: [],
      additionalSkillPaths: [SHIPPED_SKILLS_DIR],
      repoJail: true,
    });
  }
}

export function packageRoot(): string {
  return PACKAGE_ROOT;
}

export function shippedSkillsDir(): string {
  return SHIPPED_SKILLS_DIR;
}
