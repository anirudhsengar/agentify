import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENTIFY_PROVIDERS,
  getProviderEnvValue,
  hasProviderEnvironmentAuth,
  isAgentifyProvider,
} from "./provider-auth.ts";
import type { AgentifyConfig, AgentifyProvider, AgentifyUi } from "./types.ts";

export function defaultConfigDir(): string {
  return path.join(os.homedir(), ".agentify");
}

export function configPath(configDir: string): string {
  return path.join(configDir, "config.json");
}

export function authPath(configDir: string): string {
  return path.join(configDir, "auth.json");
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

export function loadAgentifyConfig(configDir: string): AgentifyConfig {
  const raw = readJsonObject(configPath(configDir));
  const provider = typeof raw.provider === "string" && isAgentifyProvider(raw.provider)
    ? raw.provider
    : undefined;
  return {
    provider,
    model: typeof raw.model === "string" ? raw.model : undefined,
    thinkingLevel: typeof raw.thinkingLevel === "string"
      ? raw.thinkingLevel as AgentifyConfig["thinkingLevel"]
      : undefined,
  };
}

function writeJson0600(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems without chmod semantics.
  }
}

export function saveAgentifyConfig(configDir: string, config: AgentifyConfig): void {
  writeJson0600(configPath(configDir), config);
}

function hasEnvAuth(provider: AgentifyProvider): boolean {
  return hasProviderEnvironmentAuth(provider);
}

function hasAuthFileProvider(configDir: string, provider: AgentifyProvider): boolean {
  const raw = readJsonObject(authPath(configDir));
  const entry = raw[provider];
  return !!entry && typeof entry === "object" && "key" in entry;
}

function hasAnyUsableAuth(configDir: string, config: AgentifyConfig): boolean {
  if (config.provider) {
    return hasEnvAuth(config.provider) || hasAuthFileProvider(configDir, config.provider);
  }
  return AGENTIFY_PROVIDERS.some((provider) => (
    hasEnvAuth(provider.value) || hasAuthFileProvider(configDir, provider.value)
  ));
}

function firstEnvProvider(): AgentifyProvider | undefined {
  return AGENTIFY_PROVIDERS.find((provider) => hasEnvAuth(provider.value))?.value;
}

function credentialPrompt(label: string, env: readonly string[]): string {
  if (env.length === 0) return `${label} credential`;
  return `${label} API key (${env.join(" or ")})`;
}

export async function ensureAgentifyConfig(
  configDir: string,
  ui: AgentifyUi,
): Promise<AgentifyConfig> {
  let config = loadAgentifyConfig(configDir);
  if (hasAnyUsableAuth(configDir, config)) {
    if (!config.provider) {
      config = { ...config, provider: firstEnvProvider() };
      saveAgentifyConfig(configDir, config);
    }
    return config;
  }

  const providerValue = await ui.promptSelect(
    "Choose an LLM provider for agentify:",
    AGENTIFY_PROVIDERS.map((provider) => ({ label: provider.label, value: provider.value })),
  );
  if (!isAgentifyProvider(providerValue)) {
    throw new Error(`Unsupported provider: ${providerValue}`);
  }

  const selected = AGENTIFY_PROVIDERS.find((provider) => provider.value === providerValue)!;
  const envKey = getProviderEnvValue(selected.value);
  let auth = readJsonObject(authPath(configDir));
  if (!envKey) {
    if (selected.env.length === 0) {
      throw new Error(
        `${selected.label} uses OAuth in Pi. agentify can use existing credentials, ` +
          "but cannot start that login flow yet.",
      );
    }
    const key = await ui.promptSecret(credentialPrompt(selected.label, selected.env));
    if (!key.trim()) throw new Error("No API key provided.");
    auth = {
      ...auth,
      [selected.value]: { type: "api_key", key: key.trim() },
    };
    writeJson0600(authPath(configDir), auth);
  }

  config = {
    ...config,
    provider: selected.value,
    thinkingLevel: config.thinkingLevel ?? "high",
  };
  saveAgentifyConfig(configDir, config);
  return config;
}
