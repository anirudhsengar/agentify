// Config-utility subcommands for the agentify CLI: `login`, `logout`,
// and `models`. These commands operate only on
// `~/.agentify/{config,auth}.json` and never invoke the audit runtime.
// Amended 2026-07-09 to permit the config-utility subcommands.

import * as path from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
  AGENTIFY_PROVIDERS,
  getProviderEnvValue,
  hasProviderEnvironmentAuth,
  isAgentifyProvider,
} from "./provider-auth.ts";
import {
  authPath,
  configPath,
  loadAgentifyConfig,
  saveAgentifyConfig,
} from "./agentify-config.ts";
import { selectModelForRole } from "./models/resolver.ts";
import {
  discoverExistingStateDir,
} from "./state-dir.ts";
import { recoverInterruptedStateTransactions } from "./state-transaction.ts";
import { revertLastRun } from "./revert.ts";
import type { AgentifyProvider, AgentifyUi, ModelRole } from "./types.ts";
import { engageCommand } from "./engagement/cli.ts";
import { evalCommand } from "./evals/cli.ts";

/** Names of the public config-utility subcommands this module dispatches. */
export const SUBCOMMAND_NAMES = ["login", "logout", "models", "revert", "engage", "eval"] as const;
export type SubcommandName = (typeof SUBCOMMAND_NAMES)[number];

export interface SubcommandContext {
  cwd: string;
  configDir: string;
  ui: AgentifyUi;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** Override `process.stdin.isTTY` (used by tests to simulate non-interactive). */
  stdinIsTTY?: boolean;
}

interface ParsedFlags {
  flags: Record<string, string | true>;
  positional: ReadonlyArray<string>;
  errors: ReadonlyArray<string>;
}

/**
 * Minimal hand-rolled argv parser. Accepts both `--key x` and `--key=x`
 * for parity with the existing `--mode` style in `src/cli.ts`. Returns
 * any unrecognised flag or missing-value errors so callers can surface
 * them concisely.
 */
function parseFlags(
  argv: ReadonlyArray<string>,
  spec: { flags: Set<string>; takesValue: Set<string> },
): ParsedFlags {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  const errors: string[] = [];
  const knownFlags = spec.flags;
  const takesValue = spec.takesValue;

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const eqIdx = tok.indexOf("=");
      let name: string;
      let value: string | true;
      if (eqIdx >= 0) {
        name = tok.slice(2, eqIdx);
        value = tok.slice(eqIdx + 1);
      } else {
        name = tok.slice(2);
        value = true;
      }
      if (!knownFlags.has(name)) {
        errors.push(`unknown flag --${name}`);
        i += 1;
        continue;
      }
      if (takesValue.has(name)) {
        if (typeof value === "string") {
          flags[name] = value;
        } else {
          const next = argv[i + 1];
          if (next === undefined) {
            errors.push(`--${name} requires a value`);
            i += 1;
            continue;
          }
          flags[name] = next;
          i += 2;
          continue;
        }
      } else {
        flags[name] = true;
      }
      i += 1;
      continue;
    }
    positional.push(tok);
    i += 1;
  }
  return { flags, positional, errors };
}

function providerLabel(value: AgentifyProvider): string {
  return AGENTIFY_PROVIDERS.find((p) => p.value === value)?.label ?? value;
}

/**
 * Returns true if the provider is OAuth-only — i.e., no env var carries
 * a usable key, and the provider relies on a Pi-side OAuth flow. Today
 * that is just `openai-codex`.
 */
function isOAuthOnlyProvider(provider: AgentifyProvider): boolean {
  const entry = AGENTIFY_PROVIDERS.find((p) => p.value === provider);
  return entry !== undefined && entry.env.length === 0;
}

function printOAuthInstructions(
  out: NodeJS.WritableStream,
  provider: AgentifyProvider,
): void {
  out.write(`${providerLabel(provider)} uses OAuth and cannot be configured via the agentify CLI.\n`);
  out.write(`Run \`pi auth login ${provider}\` to complete the OAuth flow; agentify will pick up the saved credentials.\n`);
}

function credentialPrompt(label: string, env: readonly string[]): string {
  if (env.length === 0) return `${label} credential`;
  return `${label} API key (${env.join(" or ")})`;
}

function buildAuthStorage(configDir: string): AuthStorage {
  return AuthStorage.create(authPath(configDir));
}

function buildModelRegistry(authStorage: AuthStorage, configDir: string): ModelRegistry {
  const modelsJsonPath = path.join(configDir, "models.json");
  return ModelRegistry.create(authStorage, modelsJsonPath);
}

// ===========================================================================
// `agentify login`
// ===========================================================================

const LOGIN_FLAGS = new Set(["provider", "key"]);
const LOGIN_TAKES_VALUE = new Set(["provider", "key"]);

export async function loginCommand(
  argv: ReadonlyArray<string>,
  ctx: SubcommandContext,
): Promise<number> {
  const parsed = parseFlags(argv, {
    flags: LOGIN_FLAGS,
    takesValue: LOGIN_TAKES_VALUE,
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) ctx.err.write(`agentify: login: ${err}\n`);
    return 1;
  }
  if (parsed.positional.length > 0) {
    ctx.err.write(`agentify: login: unexpected argument: ${parsed.positional[0]}\n`);
    return 1;
  }

  let providerValue: string | undefined =
    typeof parsed.flags.provider === "string" ? parsed.flags.provider : undefined;
  if (providerValue !== undefined && !isAgentifyProvider(providerValue)) {
    ctx.err.write(`agentify: login: unknown provider '${providerValue}'\n`);
    return 1;
  }

  if (providerValue === undefined) {
    providerValue = await ctx.ui.promptSelect(
      "Choose an LLM provider for agentify:",
      AGENTIFY_PROVIDERS.map((p) => ({ label: p.label, value: p.value })),
    );
    if (!isAgentifyProvider(providerValue)) {
      ctx.err.write(`agentify: login: unsupported provider: ${providerValue}\n`);
      return 1;
    }
  }

  const provider = providerValue;
  const entry = AGENTIFY_PROVIDERS.find((p) => p.value === provider);
  if (!entry) {
    ctx.err.write(`agentify: login: unknown provider '${provider}'\n`);
    return 1;
  }

  if (isOAuthOnlyProvider(provider)) {
    printOAuthInstructions(ctx.out, provider);
    return 0;
  }

  if (hasProviderEnvironmentAuth(provider)) {
    const envKey = getProviderEnvValue(provider);
    ctx.out.write(
      `${providerLabel(provider)} is configured via environment (${envKey === undefined ? entry.env.join(",") : entry.env.find((e) => process.env[e]) ?? entry.env[0]}); ` +
        "agentify will use that value at runtime. To replace it with a stored key, unset the env var and run `agentify login` again, or use `agentify logout --provider " +
        provider +
        "` to clear any persisted credential.\n",
    );
    // Still update the config provider pointer so `models show` reflects
    // the user's intent.
    const existing = loadAgentifyConfig(ctx.configDir);
    saveAgentifyConfig(ctx.configDir, {
      ...existing,
      provider,
      thinkingLevel: existing.thinkingLevel ?? "high",
    });
    return 0;
  }

  let key: string | undefined =
    typeof parsed.flags.key === "string" ? parsed.flags.key : undefined;
  if (key === undefined) {
    key = await ctx.ui.promptSecret(credentialPrompt(entry.label, entry.env));
  }
  if (!key.trim()) {
    ctx.err.write(`agentify: login: no API key provided\n`);
    return 1;
  }

  const authStorage = buildAuthStorage(ctx.configDir);
  authStorage.set(provider, { type: "api_key", key: key.trim() });

  const existing = loadAgentifyConfig(ctx.configDir);
  saveAgentifyConfig(ctx.configDir, {
    ...existing,
    provider,
    thinkingLevel: existing.thinkingLevel ?? "high",
  });

  ctx.out.write(`logged in ${provider}; config written to ${configPath(ctx.configDir)}\n`);
  return 0;
}

// ===========================================================================
// `agentify logout`
// ===========================================================================

const LOGOUT_FLAGS = new Set(["provider", "all", "yes"]);
const LOGOUT_TAKES_VALUE = new Set(["provider"]);

export async function logoutCommand(
  argv: ReadonlyArray<string>,
  ctx: SubcommandContext,
): Promise<number> {
  const parsed = parseFlags(argv, {
    flags: LOGOUT_FLAGS,
    takesValue: LOGOUT_TAKES_VALUE,
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) ctx.err.write(`agentify: logout: ${err}\n`);
    return 1;
  }
  if (parsed.positional.length > 0) {
    ctx.err.write(`agentify: logout: unexpected argument: ${parsed.positional[0]}\n`);
    return 1;
  }

  const providerRaw =
    typeof parsed.flags.provider === "string" ? parsed.flags.provider : undefined;
  const all = parsed.flags.all === true;
  const yes = parsed.flags.yes === true;

  if (providerRaw === undefined && !all) {
    ctx.err.write("agentify: logout: pass --provider <name> or --all\n");
    return 1;
  }
  if (providerRaw !== undefined && all) {
    ctx.err.write("agentify: logout: --provider and --all are mutually exclusive\n");
    return 1;
  }

  if (providerRaw !== undefined) {
    if (!isAgentifyProvider(providerRaw)) {
      ctx.err.write(`agentify: logout: unknown provider '${providerRaw}'\n`);
      return 1;
    }
    const provider = providerRaw;
    const authStorage = buildAuthStorage(ctx.configDir);
    if (authStorage.has(provider)) {
      authStorage.remove(provider);
    } else {
      ctx.out.write(`no stored credentials for ${provider}; nothing to remove from auth.json\n`);
    }
    const existing = loadAgentifyConfig(ctx.configDir);
    // Clear legacy fields if they pointed at the logged-out provider.
    let updated = existing;
    if (existing.provider === provider) {
      updated = { ...updated, provider: undefined, model: undefined };
    }
    // Phase 2: also clear any slot whose provider matches.
    if (existing.modelsByRole) {
      const slots = { ...existing.modelsByRole };
      let changed = false;
      for (const role of ["primary", "explorer", "lite"] as const) {
        const slot = slots[role];
        if (slot && slot.provider === provider) {
          slots[role] = undefined;
          changed = true;
        }
      }
      if (changed) {
        const filtered: typeof updated.modelsByRole = {
          primary: slots.primary,
          explorer: slots.explorer,
          lite: slots.lite,
        };
        const allUnset = !filtered.primary && !filtered.explorer && !filtered.lite;
        updated = {
          ...updated,
          modelsByRole: allUnset ? undefined : filtered,
        };
      }
    }
    if (updated !== existing) {
      saveAgentifyConfig(ctx.configDir, updated);
    }
    ctx.out.write(`logged out ${provider}\n`);
    return 0;
  }

  // `--all`
  const isTTY = ctx.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY && !yes) {
    ctx.err.write("agentify: logout: --all in a non-interactive shell requires --yes\n");
    return 1;
  }
  if (!yes) {
    const choice = await ctx.ui.promptSelect(
      "Remove ALL stored credentials from auth.json and reset provider/model in config.json?",
      [
        { label: "No, cancel", value: "no" },
        { label: "Yes, wipe everything", value: "yes" },
      ],
    );
    if (choice !== "yes") {
      ctx.out.write("cancelled\n");
      return 0;
    }
  }

  const authStorage = buildAuthStorage(ctx.configDir);
  for (const provider of [...authStorage.list()]) {
    authStorage.remove(provider);
  }
  const existing = loadAgentifyConfig(ctx.configDir);
  saveAgentifyConfig(ctx.configDir, {
    ...existing,
    provider: undefined,
    model: undefined,
    modelsByRole: undefined,
  });
  ctx.out.write("logged out all providers; provider, model, and slots cleared from config\n");
  return 0;
}

// ===========================================================================
// `agentify models ...`
// ==============================================================================

const MODELS_LIST_FLAGS = new Set(["provider"]);
const MODELS_SET_FLAGS = new Set<string>(); // none
const MODELS_TAKES_VALUE = new Set(["provider"]);

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const k = count / 1_000;
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return count.toString();
}

function formatModelsTable(models: ReadonlyArray<Model<Api>>, out: NodeJS.WritableStream): void {
  const rows = models.map((m) => ({
    provider: m.provider,
    model: m.id,
    context: formatTokenCount(m.contextWindow),
    maxOut: formatTokenCount(m.maxTokens),
    thinking: m.reasoning ? "yes" : "no",
    images: m.input.includes("image") ? "yes" : "no",
  }));
  const headers = {
    provider: "provider",
    model: "model",
    context: "context",
    maxOut: "max-out",
    thinking: "thinking",
    images: "images",
  };
  const widths = {
    provider: Math.max(headers.provider.length, ...rows.map((r) => r.provider.length)),
    model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
    context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
    maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
    thinking: Math.max(headers.thinking.length, ...rows.map((r) => r.thinking.length)),
    images: Math.max(headers.images.length, ...rows.map((r) => r.images.length)),
  };
  const fmtRow = (r: typeof rows[number]): string => [
    r.provider.padEnd(widths.provider),
    r.model.padEnd(widths.model),
    r.context.padEnd(widths.context),
    r.maxOut.padEnd(widths.maxOut),
    r.thinking.padEnd(widths.thinking),
    r.images.padEnd(widths.images),
  ].join("  ");
  out.write(`${fmtRow(headers)}\n`);
  for (const row of rows) out.write(`${fmtRow(row)}\n`);
}

function modelsList(ctx: SubcommandContext, providerFilter: string | undefined): Promise<number> {
  const authStorage = buildAuthStorage(ctx.configDir);
  const registry = buildModelRegistry(authStorage, ctx.configDir);
  const available = registry.getAvailable();
  let models = available;
  if (providerFilter !== undefined) {
    models = available.filter((m) => m.provider === providerFilter);
  }
  if (models.length === 0) {
    if (available.length === 0) {
      ctx.out.write("no auth configured — run `agentify login` first.\n");
    } else if (providerFilter !== undefined) {
      ctx.out.write(`no available models for provider '${providerFilter}'\n`);
    } else {
      ctx.out.write("no models available\n");
    }
    return Promise.resolve(0);
  }
  models = [...models].sort((a, b) => {
    const cmp = a.provider.localeCompare(b.provider);
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
  });
  formatModelsTable(models, ctx.out);
  return Promise.resolve(0);
}

function modelsShow(ctx: SubcommandContext, resolved: boolean): Promise<number> {
  const config = loadAgentifyConfig(ctx.configDir);
  // Three pinned lines — test `modelsShowPrintsCurrentConfigAndAvailableCount`
  // asserts these exact substrings, so the format and order must not change.
  ctx.out.write(`provider:    ${config.provider ?? "(unset)"}\n`);
  ctx.out.write(`model:       ${config.model ?? "(unset)"}\n`);
  ctx.out.write(`thinking:    ${config.thinkingLevel ?? "(unset)"}\n`);

  const authStorage = buildAuthStorage(ctx.configDir);
  const registry = buildModelRegistry(authStorage, ctx.configDir);

  if (resolved) {
    // Final resolved model per role.
    const roles: ReadonlyArray<ModelRole> = ["primary", "explorer", "lite"];
    const sources = new Map<ModelRole, string>();
    for (const role of roles) {
      try {
        const r = selectModelForRole(registry, config, role);
        if (r) {
          ctx.out.write(`${role.padEnd(11)} ${r.model.provider}/${r.model.id}`);
          if (r.source === "inherited-primary") sources.set(role, "(inherits primary)");
          else if (r.source === "legacy-fields") sources.set(role, "(from legacy fields)");
          else if (r.source === "registry-default") sources.set(role, "(registry default)");
          else sources.set(role, "");
          ctx.out.write(`${sources.get(role) ? "  " + sources.get(role) : ""}\n`);
        } else {
          ctx.out.write(`${role.padEnd(11)} (no models available)\n`);
        }
      } catch (err) {
        ctx.err.write(`agentify: models show: ${(err as Error).message}\n`);
        return Promise.resolve(1);
      }
    }
    return Promise.resolve(0);
  }

  // Default: append a `slots:` block under the pinned three lines.
  ctx.out.write(`available models: ${registry.getAvailable().length}\n\n`);
  ctx.out.write("slots:\n");
  const slots: ReadonlyArray<ModelRole> = ["primary", "explorer", "lite"];
  for (const role of slots) {
    const slot = config.modelsByRole?.[role];
    if (slot) {
      ctx.out.write(`  ${role.padEnd(9)} ${slot.provider}/${slot.model}\n`);
    } else {
      ctx.out.write(`  ${role.padEnd(9)} (unset — uses primary)\n`);
    }
  }
  return Promise.resolve(0);
}

function modelsSet(
  ctx: SubcommandContext,
  positional: ReadonlyArray<string>,
): Promise<number> {
  if (positional.length === 0) {
    ctx.err.write(
      "agentify: models set: usage: agentify models set <provider>/<model>\n" +
        "                              agentify models set <slot> <provider>/<model>   " +
        "(slot: primary|explorer|lite)\n",
    );
    return Promise.resolve(1);
  }

  // Slot path: 2 positionals, first is a valid ModelRole.
  if (positional.length === 2) {
    const maybeSlot = positional[0];
    if (isModelRole(maybeSlot)) {
      const slot = maybeSlot as ModelRole;
      const target = positional[1];
      const parsed = parseProviderSlashModel(target, ctx.err);
      if (!parsed) return Promise.resolve(1);
      const { provider, modelId } = parsed;
      const authStorage = buildAuthStorage(ctx.configDir);
      const registry = buildModelRegistry(authStorage, ctx.configDir);
      const found = registry.find(provider, modelId);
      if (!found) {
        ctx.err.write(
          `agentify: models set: model '${modelId}' not found for provider '${provider}'. ` +
            `Run \`agentify models list --provider ${provider}\` to see available models.\n`,
        );
        return Promise.resolve(1);
      }
      const available = registry.getAvailable();
      if (!available.some((m) => m.id === modelId && m.provider === provider)) {
        ctx.err.write(
          `agentify: models set: model '${modelId}' is known to ${providerLabel(provider)} ` +
            "but unavailable with your current credentials — run `agentify login`.\n",
        );
        return Promise.resolve(1);
      }
      const existing = loadAgentifyConfig(ctx.configDir);

      // Slot inheritance: when setting a secondary slot without primary
      // set, auto-populate primary from legacy fields (Phase 2).
      let primarySlot = existing.modelsByRole?.primary;
      if (!primarySlot && slot !== "primary") {
        if (existing.provider && existing.model) {
          primarySlot = { provider: existing.provider, model: existing.model };
        } else {
          ctx.err.write(
            `agentify: models set ${slot}: requires a primary model. ` +
              `Run \`agentify models set primary <provider>/<model>\` first, ` +
              "or use the legacy `agentify models set <provider>/<model>` to set the default.\n",
          );
          return Promise.resolve(1);
        }
      }

      const updatedModelsByRole: Record<ModelRole, { provider: AgentifyProvider; model: string } | undefined> = {
        primary: slot === "primary" ? { provider, model: modelId } : primarySlot,
        explorer: slot === "explorer" ? { provider, model: modelId } : existing.modelsByRole?.explorer,
        lite: slot === "lite" ? { provider, model: modelId } : existing.modelsByRole?.lite,
      };
      saveAgentifyConfig(ctx.configDir, {
        ...existing,
        modelsByRole: updatedModelsByRole,
      });
      ctx.out.write(`set ${slot} slot to ${provider}/${modelId}\n`);
      return Promise.resolve(0);
    }
    // First arg looks like a slot but isn't valid.
    ctx.err.write(
      `agentify: models set: '${maybeSlot}' is not a valid slot. Valid slots: primary, explorer, lite.\n`,
    );
    return Promise.resolve(1);
  }

  if (positional.length > 2) {
    ctx.err.write(`agentify: models set: unexpected argument: ${positional[2]}\n`);
    return Promise.resolve(1);
  }

  // Legacy path: 1 positional `provider/model`.
  const target = positional[0];
  const parsed = parseProviderSlashModel(target, ctx.err);
  if (!parsed) return Promise.resolve(1);
  const { provider, modelId } = parsed;

  const authStorage = buildAuthStorage(ctx.configDir);
  const registry = buildModelRegistry(authStorage, ctx.configDir);

  const found = registry.find(provider, modelId);
  if (!found) {
    ctx.err.write(
      `agentify: models set: model '${modelId}' not found for provider '${provider}'. ` +
        `Run \`agentify models list --provider ${provider}\` to see available models.\n`,
    );
    return Promise.resolve(1);
  }
  const available = registry.getAvailable();
  if (!available.some((m) => m.id === modelId && m.provider === provider)) {
    ctx.err.write(
      `agentify: models set: model '${modelId}' is known to ${providerLabel(provider)} ` +
        "but unavailable with your current credentials — run `agentify login`.\n",
    );
    return Promise.resolve(1);
  }
  const existing = loadAgentifyConfig(ctx.configDir);
  saveAgentifyConfig(ctx.configDir, {
    ...existing,
    provider,
    model: modelId,
  });
  ctx.out.write(`set model to ${provider}/${modelId}\n`);
  return Promise.resolve(0);
}

function isModelRole(value: string): value is ModelRole {
  return value === "primary" || value === "explorer" || value === "lite";
}

interface ParsedProviderModel {
  provider: AgentifyProvider;
  modelId: string;
}

function parseProviderSlashModel(
  target: string,
  err: NodeJS.WritableStream,
): ParsedProviderModel | null {
  const slashIdx = target.indexOf("/");
  if (slashIdx < 0) {
    err.write(`agentify: models set: '${target}' must be in <provider>/<model> form\n`);
    return null;
  }
  const providerStr = target.slice(0, slashIdx);
  const modelId = target.slice(slashIdx + 1);
  if (modelId.length === 0 || providerStr.length === 0) {
    err.write(`agentify: models set: '${target}' must be in <provider>/<model> form\n`);
    return null;
  }
  if (modelId.includes("/")) {
    err.write(`agentify: models set: '${target}' must contain exactly one '/'\n`);
    return null;
  }
  if (!isAgentifyProvider(providerStr)) {
    err.write(`agentify: models set: unknown provider '${providerStr}'\n`);
    return null;
  }
  return { provider: providerStr as AgentifyProvider, modelId };
}

function modelsUnset(ctx: SubcommandContext, positional: ReadonlyArray<string>): Promise<number> {
  const existing = loadAgentifyConfig(ctx.configDir);

  if (positional.length === 0) {
    // Legacy path: clear provider + model.
    saveAgentifyConfig(ctx.configDir, {
      ...existing,
      provider: undefined,
      model: undefined,
    });
    ctx.out.write("cleared provider and model from config\n");
    return Promise.resolve(0);
  }
  if (positional.length > 1) {
    ctx.err.write(`agentify: models unset: unexpected argument: ${positional[1]}\n`);
    return Promise.resolve(1);
  }
  const slotName = positional[0];
  if (!isModelRole(slotName)) {
    ctx.err.write(
      `agentify: models unset: '${slotName}' is not a valid slot. Valid slots: primary, explorer, lite.\n`,
    );
    return Promise.resolve(1);
  }
  const slot = slotName as ModelRole;
  if (!existing.modelsByRole?.[slot]) {
    ctx.out.write(`slot '${slot}' is already unset\n`);
    return Promise.resolve(0);
  }
  const updatedModelsByRole: Record<ModelRole, { provider: AgentifyProvider; model: string } | undefined> = {
    primary: slot === "primary" ? undefined : existing.modelsByRole.primary,
    explorer: slot === "explorer" ? undefined : existing.modelsByRole.explorer,
    lite: slot === "lite" ? undefined : existing.modelsByRole.lite,
  };
  saveAgentifyConfig(ctx.configDir, {
    ...existing,
    modelsByRole: updatedModelsByRole,
  });
  ctx.out.write(`unset ${slot} slot\n`);
  return Promise.resolve(0);
}

const REVERT_FLAGS = new Set(["to", "keep-alongside"]);
const REVERT_TAKES_VALUE = new Set(["to"]);

/**
 * `agentify revert` — undo the last agentify run. Reads the
 * manifest, deletes the alongside `*.agentify.*` files, restores
 * the user's pre-existing files from the snapshot, and removes
 * any files agentify created from scratch. Single-shot, not a
 * stack — a second `revert` on the same manifest is a no-op.
 */
export async function revertCommand(
  argv: ReadonlyArray<string>,
  ctx: SubcommandContext,
): Promise<number> {
  const parsed = parseFlags(argv, {
    flags: REVERT_FLAGS,
    takesValue: REVERT_TAKES_VALUE,
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) ctx.err.write(`agentify: revert: ${err}\n`);
    return 1;
  }
  for (const pos of parsed.positional) {
    ctx.err.write(`agentify: revert: unexpected positional argument '${pos}'\n`);
    return 1;
  }
  recoverInterruptedStateTransactions(ctx.cwd);
  const discoveredState = discoverExistingStateDir(ctx.cwd);
  if (!discoveredState) {
    ctx.err.write("agentify: revert: no managed state directory was found; no files were changed\n");
    return 1;
  }
  const stateDir = discoveredState.relativeDir;
  const includeAlongside = parsed.flags["keep-alongside"] !== true;
  const runId = typeof parsed.flags.to === "string" ? parsed.flags.to : undefined;
  const result = await revertLastRun({
    cwd: ctx.cwd,
    stateDir,
    runId,
    includeAlongside,
    ui: ctx.ui,
  });
  ctx.out.write(`agentify: revert complete\n`);
  ctx.out.write(
    `  alongside removed: ${result.alongsideRemoved.length}\n`,
  );
  ctx.out.write(`  user files restored: ${result.userRestored.length}\n`);
  ctx.out.write(
    `  agentify-created files removed: ${result.createdRemoved.length}\n`,
  );
  if (result.kept.length > 0) {
    ctx.out.write(
      `  alongside files kept (--keep-alongside): ${result.kept.length}\n`,
    );
  }
  if (result.errors.length > 0) {
    ctx.out.write(`  errors: ${result.errors.length}\n`);
    for (const err of result.errors.slice(0, 8)) {
      ctx.out.write(`    ${err}\n`);
    }
  }
  return result.errors.length > 0 ? 1 : 0;
}

export async function modelsCommand(
  argv: ReadonlyArray<string>,
  ctx: SubcommandContext,
): Promise<number> {
  if (argv.length === 0) {
    ctx.err.write(
      "agentify: models: missing sub-action. Usage: agentify models <list|show|set|unset>\n",
    );
    return 1;
  }
  const action = argv[0];
  const rest = argv.slice(1);

  if (action === "list") {
    const parsed = parseFlags(rest, {
      flags: MODELS_LIST_FLAGS,
      takesValue: MODELS_TAKES_VALUE,
    });
    if (parsed.errors.length > 0) {
      for (const err of parsed.errors) ctx.err.write(`agentify: models list: ${err}\n`);
      return 1;
    }
    if (parsed.positional.length > 0) {
      ctx.err.write(`agentify: models list: unexpected argument: ${parsed.positional[0]}\n`);
      return 1;
    }
    const provider =
      typeof parsed.flags.provider === "string" ? parsed.flags.provider : undefined;
    return modelsList(ctx, provider);
  }

  if (action === "show") {
    const parsed = parseFlags(rest, {
      flags: new Set(["resolved"]),
      takesValue: new Set<string>(),
    });
    if (parsed.errors.length > 0) {
      for (const err of parsed.errors) ctx.err.write(`agentify: models show: ${err}\n`);
      return 1;
    }
    if (parsed.positional.length > 0) {
      ctx.err.write(`agentify: models show: unexpected argument: ${parsed.positional[0]}\n`);
      return 1;
    }
    return modelsShow(ctx, parsed.flags.resolved === true);
  }

  if (action === "set") {
    const parsed = parseFlags(rest, {
      flags: MODELS_SET_FLAGS,
      takesValue: new Set<string>(),
    });
    if (parsed.errors.length > 0) {
      for (const err of parsed.errors) ctx.err.write(`agentify: models set: ${err}\n`);
      return 1;
    }
    return modelsSet(ctx, parsed.positional);
  }

  if (action === "unset") {
    const parsed = parseFlags(rest, {
      flags: new Set<string>(),
      takesValue: new Set<string>(),
    });
    if (parsed.errors.length > 0) {
      for (const err of parsed.errors) ctx.err.write(`agentify: models unset: ${err}\n`);
      return 1;
    }
    return modelsUnset(ctx, parsed.positional);
  }

  ctx.err.write(
    `agentify: models: unknown sub-action '${action}'. Valid: list, show, set, unset\n`,
  );
  return 1;
}

// ===========================================================================
// Dispatch + help
// ===========================================================================

export async function dispatchSubcommand(
  argv: ReadonlyArray<string>,
  ctx: SubcommandContext,
): Promise<boolean> {
  if (argv.length === 0) return false;
  const head = argv[0];
  if (head === "login") {
    const code = await loginCommand(argv.slice(1), ctx);
    process.exitCode = code;
    return true;
  }
  if (head === "logout") {
    const code = await logoutCommand(argv.slice(1), ctx);
    process.exitCode = code;
    return true;
  }
  if (head === "models") {
    const code = await modelsCommand(argv.slice(1), ctx);
    process.exitCode = code;
    return true;
  }
  if (head === "revert") {
    const code = await revertCommand(argv.slice(1), ctx);
    process.exitCode = code;
    return true;
  }
  if (head === "engage") {
    const code = await engageCommand(argv.slice(1), ctx);
    process.exitCode = code;
    return true;
  }
  if (head === "eval") {
    const code = await evalCommand(argv.slice(1), ctx);
    process.exitCode = code;
    return true;
  }
  return false;
}

export function runUnknownSubcommand(name: string, ctx: SubcommandContext): number {
  ctx.err.write(
    `agentify: unknown subcommand '${name}'. Known subcommands: ${SUBCOMMAND_NAMES.join(", ")}. Run \`agentify --help\` for usage.\n`,
  );
  return 1;
}

/**
 * Single source of truth for the subcommand help block. Reused by both
 * `printHelp()` in `src/cli.ts` and any in-process subcommand help.
 */
export function printSubcommandHelp(out: NodeJS.WritableStream): void {
  out.write(`\nConfig subcommands (manage ~/.agentify/{config,auth}.json):\n`);
  out.write(`  agentify login [--provider <name>] [--key <key>]\n`);
  out.write(`    Store or replace an API key. Prompts interactively when\n`);
  out.write(`    no flags are supplied. Prints setup instructions for\n`);
  out.write(`    OAuth-only providers (e.g., openai-codex).\n`);
  out.write(`  agentify logout [--provider <name> | --all] [--yes]\n`);
  out.write(`    Remove one provider's credentials, or wipe all stored\n`);
  out.write(`    auth with --all (interactive confirmation; --yes skips\n`);
  out.write(`    the prompt in non-interactive shells).\n`);
  out.write(`  agentify models list [--provider <name>]\n`);
  out.write(`    Print available models from the Pi model registry,\n`);
  out.write(`    filtered by configured auth.\n`);
  out.write(`  agentify models show\n`);
  out.write(`    Print the configured provider, model, and thinking level.\n`);
  out.write(`  agentify models set <provider>/<model>\n`);
  out.write(`    Set the model in config.json, validating against the\n`);
  out.write(`    registry and current auth.\n`);
  out.write(`  agentify models unset\n`);
  out.write(`    Clear provider and model from config.json (preserves\n`);
  out.write(`    thinkingLevel).\n`);
  out.write(`\nOperational subcommands (mutate the repo):\n`);
  out.write(`  agentify revert [--to <run-id>] [--keep-alongside]\n`);
  out.write(`    Undo the most recent agentify run. Removes *.agentify.*\n`);
  out.write(`    alongside files, restores user files from the snapshot,\n`);
  out.write(`    and deletes files agentify created from scratch. Single-\n`);
  out.write(`    shot, not a history. --keep-alongside preserves the\n`);
  out.write(`    alongside files.\n`);
  out.write(`\nEngagement record and analysis subcommands:\n`);
  out.write(`  agentify engage <init|status|validate|report|promotion> [options]\n`);
  out.write(`    Create, inspect, validate, or deterministically report an\n`);
  out.write(`    FDE engagement record. No LLM or implementation is invoked.\n`);
  out.write(`\nFDE evaluation subcommands:\n`);
  out.write(`  agentify eval <run|report|validate> [options]\n`);
  out.write(`    Validate suites, grade imported structured trial evidence, and\n`);
  out.write(`    generate deterministic release-eligibility reports.\n`);
}
