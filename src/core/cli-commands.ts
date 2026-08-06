// Config-utility subcommands for the Agentify CLI. These commands operate only
// on `~/.agentify/{config,auth}.json` and never invoke the audit runtime.

import * as path from "node:path";
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
  printPublicCommandHelp,
  printPublicSubcommandHelp,
} from "./public-cli-contract.ts";
import type { AgentifyProvider, AgentifyUi, ModelRole } from "./types.ts";
import {
  AgentifyCredentialStore,
  createAgentifyModelRuntime,
} from "./pi-credential-store.ts";

/** Names of the public config-utility subcommands this module dispatches. */
export const SUBCOMMAND_NAMES = ["login", "logout", "models"] as const;
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
 * Minimal hand-rolled argv parser. Returns unrecognized flag and missing-value
 * errors so callers can surface them concisely.
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

function buildAuthStorage(configDir: string): AgentifyCredentialStore {
  return new AgentifyCredentialStore(authPath(configDir));
}

async function buildModelRegistry(configDir: string) {
  return (await createAgentifyModelRuntime({
    authFile: authPath(configDir),
    modelsFile: path.join(configDir, "models.json"),
  })).modelRegistry;
}

// ===========================================================================
// `agentify login`
// ===========================================================================

const LOGIN_FLAGS = new Set(["provider"]);
const LOGIN_TAKES_VALUE = new Set(["provider"]);

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

  const interactive = ctx.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!interactive) {
    ctx.err.write(
      `agentify: login: no credential found for ${provider}; set ${entry.env.join(" or ")} or run this command in an interactive terminal\n`,
    );
    return 1;
  }
  const key = await ctx.ui.promptSecret(credentialPrompt(entry.label, entry.env));
  if (!key.trim()) {
    ctx.err.write(`agentify: login: no API key provided\n`);
    return 1;
  }

  const authStorage = buildAuthStorage(ctx.configDir);
  await authStorage.set(provider, { type: "api_key", key: key.trim() });

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
    if (await authStorage.has(provider)) {
      await authStorage.delete(provider);
    } else {
      ctx.out.write(`no stored credentials for ${provider}; nothing to remove from auth.json\n`);
    }
    const existing = loadAgentifyConfig(ctx.configDir);
    let updated = existing;
    if (existing.provider === provider) {
      updated = { ...updated, provider: undefined };
    }
    const models = { ...existing.models };
    let changed = false;
    for (const role of ["primary", "explorer", "lite"] as const) {
      if (models[role]?.provider === provider) {
        delete models[role];
        changed = true;
      }
    }
    if (changed) updated = { ...updated, models };
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
    "Remove all stored credentials and model assignments?",
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
  for (const credential of await authStorage.list()) {
    await authStorage.delete(credential.providerId);
  }
  const existing = loadAgentifyConfig(ctx.configDir);
  saveAgentifyConfig(ctx.configDir, {
    ...existing,
    provider: undefined,
    models: {},
  });
  ctx.out.write("logged out all providers; model assignments cleared\n");
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

async function modelsList(ctx: SubcommandContext, providerFilter: string | undefined): Promise<number> {
  const registry = await buildModelRegistry(ctx.configDir);
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

async function modelsShow(ctx: SubcommandContext, resolved: boolean): Promise<number> {
  const config = loadAgentifyConfig(ctx.configDir);
  ctx.out.write(`provider:    ${config.provider ?? "(unset)"}\n`);
  ctx.out.write(`thinking:    ${config.thinkingLevel}\n`);

  const registry = await buildModelRegistry(ctx.configDir);

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
          else if (r.source === "provider-default") sources.set(role, "(provider default)");
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

  ctx.out.write(`available models: ${registry.getAvailable().length}\n\n`);
  ctx.out.write("roles:\n");
  const slots: ReadonlyArray<ModelRole> = ["primary", "explorer", "lite"];
  for (const role of slots) {
    const slot = config.models[role];
    if (slot) {
      ctx.out.write(`  ${role.padEnd(9)} ${slot.provider}/${slot.model}\n`);
    } else {
      ctx.out.write(`  ${role.padEnd(9)} (unset${role === "primary" ? "" : " — inherits primary"})\n`);
    }
  }
  return Promise.resolve(0);
}

async function modelsSet(
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
      const registry = await buildModelRegistry(ctx.configDir);
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

      const primarySlot = existing.models.primary;
      if (!primarySlot && slot !== "primary") {
        ctx.err.write(
          `agentify: models set ${slot}: requires a primary model. ` +
            `Run \`agentify models set primary <provider>/<model>\` first.\n`,
        );
        return Promise.resolve(1);
      }

      const models = { ...existing.models, [slot]: { provider, model: modelId } };
      saveAgentifyConfig(ctx.configDir, {
        ...existing,
        provider: slot === "primary" ? provider : existing.provider,
        models,
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

  // One positional sets the primary role.
  const target = positional[0];
  const parsed = parseProviderSlashModel(target, ctx.err);
  if (!parsed) return Promise.resolve(1);
  const { provider, modelId } = parsed;

  const registry = await buildModelRegistry(ctx.configDir);

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
    models: { ...existing.models, primary: { provider, model: modelId } },
  });
  ctx.out.write(`set primary model to ${provider}/${modelId}\n`);
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
    const models = { ...existing.models };
    delete models.primary;
    saveAgentifyConfig(ctx.configDir, {
      ...existing,
      models,
    });
    ctx.out.write("unset primary model\n");
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
  if (!existing.models[slot]) {
    ctx.out.write(`slot '${slot}' is already unset\n`);
    return Promise.resolve(0);
  }
  const models = { ...existing.models };
  delete models[slot];
  saveAgentifyConfig(ctx.configDir, {
    ...existing,
    models,
  });
  ctx.out.write(`unset ${slot} slot\n`);
  return Promise.resolve(0);
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
    if (argv.slice(1).some((value) => value === "--help" || value === "-h")) {
      printPublicCommandHelp(head, ctx.out);
      process.exitCode = 0;
      return true;
    }
    const code = await loginCommand(argv.slice(1), ctx);
    process.exitCode = code;
    return true;
  }
  if (head === "logout") {
    if (argv.slice(1).some((value) => value === "--help" || value === "-h")) {
      printPublicCommandHelp(head, ctx.out);
      process.exitCode = 0;
      return true;
    }
    const code = await logoutCommand(argv.slice(1), ctx);
    process.exitCode = code;
    return true;
  }
  if (head === "models") {
    if (argv.slice(1).some((value) => value === "--help" || value === "-h")) {
      printPublicCommandHelp(head, ctx.out);
      process.exitCode = 0;
      return true;
    }
    const code = await modelsCommand(argv.slice(1), ctx);
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
  printPublicSubcommandHelp(out);
}
