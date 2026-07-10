import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  AGENTIFY_PROVIDERS,
  getProviderEnvValue,
  hasProviderEnvironmentAuth,
  isAgentifyProvider,
} from "./provider-auth.ts";
import type {
  AgentifyConfig,
  AgentifyProvider,
  AgentifyTarget,
  AgentifyUi,
  ModelRole,
  ModelSlot,
} from "./types.ts";

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

/**
 * Pure read of one slot entry. Returns `undefined` for any malformed
 * shape (non-string provider, unknown provider, non-string model, or
 * empty model). The whole `modelsByRole` object becomes `undefined`
 * when every slot is missing.
 */
function readSlot(rawSlot: unknown): ModelSlot | undefined {
  if (!rawSlot || typeof rawSlot !== "object" || Array.isArray(rawSlot)) return undefined;
  const slot = rawSlot as Record<string, unknown>;
  if (typeof slot.provider !== "string" || !isAgentifyProvider(slot.provider)) return undefined;
  if (typeof slot.model !== "string" || slot.model.length === 0) return undefined;
  return { provider: slot.provider, model: slot.model };
}

function readModelsByRole(
  raw: Record<string, unknown>,
): AgentifyConfig["modelsByRole"] {
  const slotRaw = raw.modelsByRole;
  if (!slotRaw || typeof slotRaw !== "object" || Array.isArray(slotRaw)) return undefined;
  const obj = slotRaw as Record<string, unknown>;
  const primary = readSlot(obj.primary);
  const explorer = readSlot(obj.explorer);
  const lite = readSlot(obj.lite);
  if (!primary && !explorer && !lite) return undefined;
  return { primary, explorer, lite };
}

/**
 * Pure read of the optional `targets` field — only the three premium
 * harness IDs are valid (`codex` / `claude` / `pi`). Unknown entries are
 * silently dropped (forward-compat: if a hand-written config has stale
 * values, we ignore them rather than crash). Empty arrays are preserved
 * as `undefined` to match the type's optional semantics.
 */
function readTargets(raw: unknown): ReadonlyArray<AgentifyTarget> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const valid: AgentifyTarget[] = [];
  for (const entry of raw) {
    if (entry === "codex" || entry === "claude" || entry === "pi") {
      valid.push(entry);
    }
  }
  if (valid.length === 0) return undefined;
  return valid;
}

export function loadAgentifyConfig(configDir: string): AgentifyConfig {
  const raw = readJsonObject(configPath(configDir));
  // One-shot migration: pre-rename configs may have a `scoring` slot
  // key. Rename it to `lite` and persist so subsequent reads see only
  // the new key. Must happen BEFORE we build the in-memory config,
  // otherwise `built.modelsByRole?.lite` would be undefined on the
  // first read. Idempotent — when both are present, prefer `lite`
  // and drop `scoring`. When neither is present, no-op.
  const migrated = migrateScoringSlot(raw);
  const provider = typeof raw.provider === "string" && isAgentifyProvider(raw.provider)
    ? raw.provider
    : undefined;
  const built: AgentifyConfig = {
    provider,
    model: typeof raw.model === "string" ? raw.model : undefined,
    thinkingLevel: typeof raw.thinkingLevel === "string"
      ? raw.thinkingLevel as AgentifyConfig["thinkingLevel"]
      : undefined,
    modelsByRole: readModelsByRole(raw),
    targets: readTargets(raw.targets),
  };
  if (migrated) {
    saveAgentifyConfig(configDir, built);
  }
  return built;
}

/**
 * Inspect `raw.modelsByRole` for the legacy `scoring` key. If found,
 * rename it to `lite` in-place (the in-memory object is fresh from
 * `readJsonObject`). Returns true iff a rewrite happened, so the
 * caller can persist.
 */
function migrateScoringSlot(raw: Record<string, unknown>): boolean {
  const slotRaw = raw.modelsByRole;
  if (!slotRaw || typeof slotRaw !== "object" || Array.isArray(slotRaw)) {
    return false;
  }
  const obj = slotRaw as Record<string, unknown>;
  if (obj.scoring === undefined) return false;
  if (obj.lite === undefined) {
    obj.lite = obj.scoring;
  }
  // Either way, the legacy key must not survive a migration pass.
  delete obj.scoring;
  return true;
}

function writeJson0600(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  // The agentify config dir holds credentials; create it private (0700)
  // so auth.json/config.json are never exposed via a world-readable
  // parent, then best-effort tighten in case it pre-existed with a
  // looser umask.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems without chmod semantics.
  }
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

const SLOT_NAMES: ReadonlySet<ModelRole> = new Set(["primary", "explorer", "lite"]);

/** True iff `value` is a valid `ModelRole` literal. */
export function isModelRole(value: string): value is ModelRole {
  return SLOT_NAMES.has(value as ModelRole);
}

/**
 * First-run interactive picker: prompt the user to assign models to
 * the `primary` slot (and optionally the secondary slots). Returns
 * the synthesized `AgentifyConfig.modelsByRole` block — `undefined`
 * when the user declined or the registry has nothing to offer.
 */
async function promptModelStrategy(
  ui: AgentifyUi,
  providerValue: AgentifyProvider,
  configDir: string,
): Promise<AgentifyConfig["modelsByRole"] | undefined> {
  const authStorage = AuthStorage.create(authPath(configDir));
  const registry = ModelRegistry.create(authStorage, path.join(configDir, "models.json"));
  const providerModels = registry
    .getAvailable()
    .filter((m) => m.provider === providerValue);

  const modelChoices = providerModels.map((m) => ({
    label:
      `${m.id} (${m.reasoning ? "thinking" : "no-thinking"}, ` +
      `${Math.round(m.contextWindow / 1000)}K ctx)`,
    value: `${m.provider}/${m.id}`,
  }));

  // Empty registry edge case: still let the user proceed; the resolver
  // will surface a clear error on the next command.
  const choices =
    modelChoices.length > 0
      ? modelChoices
      : [{ label: "(no models available — proceed anyway)", value: "" }];

  // Phase 3: three tier presets + "Customize" advanced path.
  const strategy = await ui.promptSelect(
    "How would you like to assign models in agentify?",
    [
      { label: "Max quality — strongest model for every slot", value: "max-quality" },
      { label: "Balanced — strongest for primary, medium for the secondary slots", value: "balanced" },
      { label: "Cost optimized — medium primary, fast for the secondary slots", value: "cost-optimized" },
      { label: "Customize each slot (advanced)", value: "split" },
    ],
  );

  if (strategy === "max-quality" || strategy === "balanced" || strategy === "cost-optimized") {
    const tierModels = providerModels.map((m) => ({
      provider: m.provider as AgentifyProvider,
      id: m.id,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
    }));
    return pickTierPreset(tierModels, strategy);
  }

  if (strategy === "single") {
    // Legacy "single" — kept for callers that pass modelStrategy.
    const primaryChoice = await ui.promptSelect("Choose your primary model:", choices);
    const primary = parseSlotChoice(primaryChoice);
    return primary ? { primary } : undefined;
  }

  // Split / Customize path: prompt primary (required), then optionally explorer + lite.
  const primaryChoice = await ui.promptSelect("Primary model (required):", choices);
  const primary = parseSlotChoice(primaryChoice);
  if (!primary) return undefined;

  let explorer: ModelSlot | undefined;
  const wantExplorer = await ui.promptSelect("Configure a separate explorer model?", [
    { label: "Skip — use primary", value: "skip" },
    { label: "Pick a model", value: "pick" },
  ]);
  if (wantExplorer === "pick") {
    const choice = await ui.promptSelect("Explorer model:", choices);
    explorer = parseSlotChoice(choice);
  }

  let lite: ModelSlot | undefined;
  const wantLite = await ui.promptSelect("Configure a separate lite model?", [
    { label: "Skip — use primary", value: "skip" },
    { label: "Pick a model", value: "pick" },
  ]);
  if (wantLite === "pick") {
    const choice = await ui.promptSelect("Lite model:", choices);
    lite = parseSlotChoice(choice);
  }

  return {
    primary,
    explorer,
    lite,
  };
}

/**
 * Resolve a tier preset into a `modelsByRole` block.
 *
 * Models are ranked by `reasoning ? 1 : 0` then `contextWindow`
 * descending, then bucketed by index:
 *   tier 0 (strongest) — primary slot in max-quality/balanced;
 *                       secondary slots in cost-optimized
 *   tier 1 (medium)    — primary in cost-optimized;
 *                       secondary slots in balanced
 *   tier 2 (fast)      — secondary slots in cost-optimized
 *
 * Edge cases:
 *   - One model only → all slots get that model.
 *   - No reasoning models → fall back to contextWindow sort.
 *   - Empty list → returns undefined; the caller falls through to
 *     the legacy `modelsByRole = undefined` path.
 */
export function pickTierPreset(
  providerModels: ReadonlyArray<{ provider: AgentifyProvider; id: string; reasoning?: boolean; contextWindow: number }>,
  preset: "max-quality" | "balanced" | "cost-optimized",
): AgentifyConfig["modelsByRole"] {
  if (providerModels.length === 0) return undefined;
  const sorted = [...providerModels].sort((a, b) => {
    const ar = a.reasoning ? 1 : 0;
    const br = b.reasoning ? 1 : 0;
    if (ar !== br) return br - ar;
    return b.contextWindow - a.contextWindow;
  });
  const strongest = sorted[0];
  const medium = sorted[Math.min(1, sorted.length - 1)];
  const fast = sorted[Math.min(2, sorted.length - 1)];
  // Max quality: same model in all slots.
  if (preset === "max-quality") {
    return {
      primary: { provider: strongest.provider, model: strongest.id },
      explorer: { provider: strongest.provider, model: strongest.id },
      lite: { provider: strongest.provider, model: strongest.id },
    };
  }
  // Balanced: strongest primary, medium secondary slots.
  if (preset === "balanced") {
    return {
      primary: { provider: strongest.provider, model: strongest.id },
      explorer: { provider: medium.provider, model: medium.id },
      lite: { provider: medium.provider, model: medium.id },
    };
  }
  // Cost optimized: medium primary, fast secondary slots.
  return {
    primary: { provider: medium.provider, model: medium.id },
    explorer: { provider: fast.provider, model: fast.id },
    lite: { provider: fast.provider, model: fast.id },
  };
}

function parseSlotChoice(choice: string): ModelSlot | undefined {
  if (!choice) return undefined;
  const slashIdx = choice.indexOf("/");
  if (slashIdx < 0) return undefined;
  const provider = choice.slice(0, slashIdx);
  const model = choice.slice(slashIdx + 1);
  if (!isAgentifyProvider(provider) || model.length === 0) return undefined;
  return { provider, model };
}

export interface EnsureAgentifyConfigOptions {
  /**
   * Override the model-strategy picker. When provided, the function
   * skips the interactive "use one model vs. assign per role" prompt
   * and uses this strategy directly. Useful for tests and CI.
   *
   * Values:
   * - `"prompt"` (default): ask the user via `ui.promptSelect`
   * - `"single"`: set primary only, no per-role branching
   * - `"skip"`: don't prompt at all; leave `modelsByRole` unset
   */
  modelStrategy?: "prompt" | "single" | "skip";
  /**
   * When `modelStrategy === "prompt"`, the picker pulls the next
   * `promptSelect`/`promptSecret` answers from this queue. The first
   * call is the strategy choice; the rest are model choices.
   */
  strategyAnswers?: string[];
}

export async function ensureAgentifyConfig(
  configDir: string,
  ui: AgentifyUi,
  options: EnsureAgentifyConfigOptions = {},
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
  if (!envKey) {
    if (selected.env.length === 0) {
      throw new Error(
        `${selected.label} uses OAuth in Pi. agentify can use existing credentials, ` +
          "but cannot start that login flow yet. Use `agentify login --provider " +
          selected.value +
          "` to see setup instructions.",
      );
    }
    const key = await ui.promptSecret(credentialPrompt(selected.label, selected.env));
    if (!key.trim()) throw new Error("No API key provided.");
    // Route through AuthStorage so the file is written under a lock with
    // 0600 semantics — same surface the login/logout subcommands use.
    AuthStorage.create(authPath(configDir)).set(selected.value, {
      type: "api_key",
      key: key.trim(),
    });
  }

  // First-run model strategy picker (Phase 2). Only fires when
  // nothing is configured: no slot config, no legacy fields.
  const hasSlotConfig =
    !!config.modelsByRole &&
    (!!config.modelsByRole.primary ||
      !!config.modelsByRole.explorer ||
      !!config.modelsByRole.lite);
  const hasLegacyConfig = !!config.provider && !!config.model;

  let modelsByRole: AgentifyConfig["modelsByRole"];
  if (!hasSlotConfig && !hasLegacyConfig) {
    if (options.modelStrategy === "single") {
      // Caller (test or CI) wants only primary; pick a sensible default
      // from the registry if available.
      const authStorage = AuthStorage.create(authPath(configDir));
      const registry = ModelRegistry.create(
        authStorage,
        path.join(configDir, "models.json"),
      );
      const providerModels = registry
        .getAvailable()
        .filter((m) => m.provider === selected.value);
      const primary = providerModels[0];
      if (primary && isAgentifyProvider(primary.provider)) {
        modelsByRole = {
          primary: { provider: primary.provider, model: primary.id },
        };
      } else {
        modelsByRole = undefined;
      }
    } else if (options.modelStrategy === "skip") {
      modelsByRole = undefined;
    } else {
      modelsByRole = await promptModelStrategy(ui, selected.value, configDir);
    }
  } else {
    modelsByRole = config.modelsByRole;
  }

  config = {
    ...config,
    provider: selected.value,
    thinkingLevel: config.thinkingLevel ?? "high",
    ...(modelsByRole ? { modelsByRole } : {}),
  };
  saveAgentifyConfig(configDir, config);
  return config;
}
