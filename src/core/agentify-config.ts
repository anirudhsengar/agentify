import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentifyCredentialStore,
  createAgentifyModelRuntime,
} from "./pi-credential-store.ts";
import {
  AGENTIFY_PROVIDERS,
  getProviderEnvValue,
  hasProviderEnvironmentAuth,
  isAgentifyProvider,
  type AgentifyProviderDefinition,
} from "./provider-auth.ts";
import type {
  AgentifyConfig,
  AgentifyProvider,
  AgentifyUi,
  ModelRole,
  ModelSlot,
  ThinkingLevel,
} from "./types.ts";

const MODEL_ROLES = ["primary", "explorer", "lite"] as const satisfies readonly ModelRole[];
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function defaultConfigDir(): string {
  return path.join(os.homedir(), ".agentify");
}

export function configPath(configDir: string): string {
  return path.join(configDir, "config.json");
}

export function authPath(configDir: string): string {
  return path.join(configDir, "auth.json");
}

function defaultConfig(): AgentifyConfig {
  return { schemaVersion: 1, thinkingLevel: "high", models: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${context} contains unknown field(s): ${unknown.sort().join(", ")}`);
  }
}

function parseModelSlot(value: unknown, context: string): ModelSlot {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  assertExactKeys(value, new Set(["provider", "model"]), context);
  if (typeof value.provider !== "string" || !isAgentifyProvider(value.provider)) {
    throw new Error(`${context}.provider is not supported`);
  }
  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    throw new Error(`${context}.model must be a non-empty string`);
  }
  return { provider: value.provider, model: value.model.trim() };
}

function parseAgentifyConfig(value: unknown, filePath: string): AgentifyConfig {
  if (!isRecord(value)) throw new Error(`Agentify config at ${filePath} must be an object`);
  assertExactKeys(
    value,
    new Set(["schemaVersion", "provider", "thinkingLevel", "models"]),
    `Agentify config at ${filePath}`,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`Agentify config at ${filePath} must use schemaVersion 1`);
  }
  if (typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.has(value.thinkingLevel as ThinkingLevel)) {
    throw new Error(`Agentify config at ${filePath} has an invalid thinkingLevel`);
  }
  if (value.provider !== undefined && (
    typeof value.provider !== "string" || !isAgentifyProvider(value.provider)
  )) {
    throw new Error(`Agentify config at ${filePath} has an unsupported provider`);
  }
  if (!isRecord(value.models)) {
    throw new Error(`Agentify config at ${filePath}.models must be an object`);
  }
  assertExactKeys(value.models, new Set(MODEL_ROLES), `Agentify config at ${filePath}.models`);
  const models: Partial<Record<ModelRole, ModelSlot>> = {};
  for (const role of MODEL_ROLES) {
    const slot = value.models[role];
    if (slot !== undefined) models[role] = parseModelSlot(slot, `models.${role}`);
  }
  return {
    schemaVersion: 1,
    thinkingLevel: value.thinkingLevel as ThinkingLevel,
    models,
    ...(typeof value.provider === "string" ? { provider: value.provider as AgentifyProvider } : {}),
  };
}

function parseLegacyAgentifyConfig(
  value: unknown,
  filePath: string,
): AgentifyConfig | undefined {
  if (!isRecord(value) || value.schemaVersion !== undefined) return undefined;
  const hasLegacyField = ["model", "modelsByRole", "targets"].some((key) => key in value);
  if (!hasLegacyField) return undefined;
  assertExactKeys(
    value,
    new Set(["provider", "model", "thinkingLevel", "modelsByRole", "targets"]),
    `Legacy Agentify config at ${filePath}`,
  );
  const thinkingLevel = value.thinkingLevel ?? "high";
  if (typeof thinkingLevel !== "string" || !THINKING_LEVELS.has(thinkingLevel as ThinkingLevel)) {
    throw new Error(`Legacy Agentify config at ${filePath} has an invalid thinkingLevel`);
  }
  if (value.provider !== undefined && (
    typeof value.provider !== "string" || !isAgentifyProvider(value.provider)
  )) {
    throw new Error(`Legacy Agentify config at ${filePath} has an unsupported provider`);
  }
  if (value.model !== undefined && (
    typeof value.model !== "string" || value.model.trim().length === 0
  )) {
    throw new Error(`Legacy Agentify config at ${filePath}.model must be a non-empty string`);
  }
  if (value.targets !== undefined && !Array.isArray(value.targets)) {
    throw new Error(`Legacy Agentify config at ${filePath}.targets must be an array`);
  }

  const models: Partial<Record<ModelRole, ModelSlot>> = {};
  if (value.modelsByRole !== undefined) {
    if (!isRecord(value.modelsByRole)) {
      throw new Error(`Legacy Agentify config at ${filePath}.modelsByRole must be an object`);
    }
    assertExactKeys(
      value.modelsByRole,
      new Set([...MODEL_ROLES, "scoring"]),
      `Legacy Agentify config at ${filePath}.modelsByRole`,
    );
    for (const role of MODEL_ROLES) {
      const slot = value.modelsByRole[role];
      if (slot !== undefined) models[role] = parseModelSlot(slot, `modelsByRole.${role}`);
    }
    if (models.lite === undefined && value.modelsByRole.scoring !== undefined) {
      models.lite = parseModelSlot(value.modelsByRole.scoring, "modelsByRole.scoring");
    }
  }
  if (
    models.primary === undefined
    && typeof value.provider === "string"
    && typeof value.model === "string"
  ) {
    models.primary = { provider: value.provider as AgentifyProvider, model: value.model.trim() };
  }
  return {
    schemaVersion: 1,
    thinkingLevel: thinkingLevel as ThinkingLevel,
    models,
    ...(typeof value.provider === "string" ? { provider: value.provider as AgentifyProvider } : {}),
  };
}

export function loadAgentifyConfig(configDir: string): AgentifyConfig {
  const filePath = configPath(configDir);
  if (!fs.existsSync(filePath)) return defaultConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot read Agentify config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const migrated = parseLegacyAgentifyConfig(parsed, filePath);
  if (migrated) {
    writeJson0600(filePath, migrated);
    return migrated;
  }
  return parseAgentifyConfig(parsed, filePath);
}

function writeJson0600(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows and some mounted filesystems do not expose POSIX modes.
  }
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows and some mounted filesystems do not expose POSIX modes.
  }
}

export function saveAgentifyConfig(configDir: string, config: AgentifyConfig): void {
  const filePath = configPath(configDir);
  writeJson0600(filePath, parseAgentifyConfig(config, filePath));
}

function readAuthObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hasStoredAuth(configDir: string, provider: AgentifyProvider): boolean {
  const entry = readAuthObject(authPath(configDir))[provider];
  return isRecord(entry) && "key" in entry;
}

function hasAnyUsableAuth(configDir: string, config: AgentifyConfig): boolean {
  if (config.provider) {
    return hasProviderEnvironmentAuth(config.provider) || hasStoredAuth(configDir, config.provider);
  }
  return AGENTIFY_PROVIDERS.some(({ value }) => (
    hasProviderEnvironmentAuth(value) || hasStoredAuth(configDir, value)
  ));
}

function firstConfiguredProvider(configDir: string): AgentifyProvider | undefined {
  return AGENTIFY_PROVIDERS.find(({ value }) => (
    hasProviderEnvironmentAuth(value) || hasStoredAuth(configDir, value)
  ))?.value;
}

function credentialPrompt(label: string, env: readonly string[]): string {
  return env.length === 0 ? `${label} credential` : `${label} API key (${env.join(" or ")})`;
}

export function isModelRole(value: string): value is ModelRole {
  return MODEL_ROLES.some((role) => role === value);
}

function parseSlotChoice(choice: string): ModelSlot | undefined {
  const slashIndex = choice.indexOf("/");
  if (slashIndex <= 0) return undefined;
  const provider = choice.slice(0, slashIndex);
  const model = choice.slice(slashIndex + 1);
  return isAgentifyProvider(provider) && model.length > 0 ? { provider, model } : undefined;
}

export function pickTierPreset(
  providerModels: ReadonlyArray<{
    provider: AgentifyProvider;
    id: string;
    reasoning?: boolean;
    contextWindow: number;
  }>,
  preset: "max-quality" | "balanced" | "cost-optimized",
): AgentifyConfig["models"] {
  if (providerModels.length === 0) return {};
  const sorted = [...providerModels].sort((left, right) => {
    const reasoningDifference = Number(right.reasoning) - Number(left.reasoning);
    return reasoningDifference || right.contextWindow - left.contextWindow;
  });
  const strongest = sorted[0]!;
  const medium = sorted[Math.min(1, sorted.length - 1)]!;
  const fast = sorted[Math.min(2, sorted.length - 1)]!;
  if (preset === "max-quality") {
    const slot = { provider: strongest.provider, model: strongest.id };
    return { primary: slot, explorer: slot, lite: slot };
  }
  if (preset === "balanced") {
    return {
      primary: { provider: strongest.provider, model: strongest.id },
      explorer: { provider: medium.provider, model: medium.id },
      lite: { provider: medium.provider, model: medium.id },
    };
  }
  return {
    primary: { provider: medium.provider, model: medium.id },
    explorer: { provider: fast.provider, model: fast.id },
    lite: { provider: fast.provider, model: fast.id },
  };
}

async function promptModelAssignments(
  ui: AgentifyUi,
  provider: AgentifyProvider,
  configDir: string,
): Promise<AgentifyConfig["models"]> {
  const { modelRegistry: registry } = await createAgentifyModelRuntime({
    authFile: authPath(configDir),
    modelsFile: path.join(configDir, "models.json"),
  });
  const providerModels = registry.getAvailable().filter((model) => model.provider === provider);
  const choices = providerModels.map((model) => ({
    label: `${model.id} (${model.reasoning ? "thinking" : "standard"}, ${Math.round(model.contextWindow / 1000)}K ctx)`,
    value: `${model.provider}/${model.id}`,
  }));
  if (choices.length === 0) return {};
  const strategy = await ui.promptSelect("How would you like to assign models in Agentify?", [
    { label: "Max quality", value: "max-quality" },
    { label: "Balanced", value: "balanced" },
    { label: "Cost optimized", value: "cost-optimized" },
    { label: "Customize each role", value: "custom" },
  ]);
  if (strategy === "max-quality" || strategy === "balanced" || strategy === "cost-optimized") {
    return pickTierPreset(providerModels.map((model) => ({
      provider: model.provider as AgentifyProvider,
      id: model.id,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
    })), strategy);
  }
  const primary = parseSlotChoice(await ui.promptSelect("Primary model:", choices));
  if (!primary) throw new Error("A primary model is required.");
  const models: AgentifyConfig["models"] = { primary };
  for (const role of ["explorer", "lite"] as const) {
    const action = await ui.promptSelect(`Configure a separate ${role} model?`, [
      { label: "Use primary", value: "inherit" },
      { label: "Choose a model", value: "choose" },
    ]);
    if (action === "choose") {
      const slot = parseSlotChoice(await ui.promptSelect(`${role} model:`, choices));
      if (slot) models[role] = slot;
    }
  }
  return models;
}

/**
 * Prompt for a fresh API key for `provider` and persist it, overwriting
 * whatever (possibly invalid) credential is already stored. Also mirrors
 * the key into `runtimeKeyEnv` for the current process so a same-process
 * retry picks it up immediately, without waiting on a re-read of
 * `auth.json` racing a stale environment variable.
 */
export async function promptAndStoreProviderCredential(
  configDir: string,
  ui: AgentifyUi,
  provider: AgentifyProvider,
): Promise<void> {
  const selected: AgentifyProviderDefinition | undefined = AGENTIFY_PROVIDERS.find(({ value }) => value === provider);
  if (!selected) throw new Error(`unknown Agentify provider: ${provider}`);
  if (selected.env.length === 0) {
    throw new Error(
      `${selected.label} uses OAuth. Run \`agentify login --provider ${selected.value}\` for setup instructions.`,
    );
  }
  const key = (await ui.promptSecret(credentialPrompt(selected.label, selected.env))).trim();
  if (!key) throw new Error("No API key provided.");
  await new AgentifyCredentialStore(authPath(configDir)).set(selected.value, {
    type: "api_key",
    key,
  });
  const runtimeEnvVar = selected.runtimeKeyEnv?.[0];
  if (runtimeEnvVar) process.env[runtimeEnvVar] = key;
}

/**
 * Full provider onboarding: pick a provider from the entire supported list,
 * collect a credential for it, then pick models for it. Used both for a
 * brand-new install (no auth anywhere) and for re-entering setup when the
 * previously configured provider stops working — in both cases the user
 * gets the complete picker, not just a re-prompt for the same provider's key.
 */
export async function runFullProviderSetup(
  configDir: string,
  ui: AgentifyUi,
  config: AgentifyConfig,
): Promise<AgentifyConfig> {
  const providerValue = await ui.promptSelect(
    "Choose an LLM provider for Agentify:",
    AGENTIFY_PROVIDERS.map(({ label, value }) => ({ label, value })),
  );
  if (!isAgentifyProvider(providerValue)) throw new Error(`Unsupported provider: ${providerValue}`);
  const selected = AGENTIFY_PROVIDERS.find(({ value }) => value === providerValue)!;
  if (!getProviderEnvValue(selected.value)) {
    await promptAndStoreProviderCredential(configDir, ui, selected.value);
  }
  const models = await promptModelAssignments(ui, selected.value, configDir);
  const updated = { ...config, provider: selected.value, models };
  saveAgentifyConfig(configDir, updated);
  return updated;
}

export async function ensureAgentifyConfig(
  configDir: string,
  ui: AgentifyUi,
): Promise<AgentifyConfig> {
  let config = loadAgentifyConfig(configDir);
  if (hasAnyUsableAuth(configDir, config)) {
    if (!config.provider) {
      config = { ...config, provider: firstConfiguredProvider(configDir) };
      saveAgentifyConfig(configDir, config);
    }
    return config;
  }
  return runFullProviderSetup(configDir, ui, config);
}
