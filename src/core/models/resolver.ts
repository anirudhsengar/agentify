// Slot-aware model resolver. Explicit assignments fail closed instead of
// silently selecting a different model.

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentifyConfig, ModelRole, ModelSlot } from "../types.ts";

/**
 * Which tier of the resolver chain satisfied the request. Useful for
 * debug logs and `models show --resolved`.
 */
export type ResolutionSource =
  | "explicit-slot"
  | "inherited-primary"
  | "provider-default"
  | "registry-default";

export interface ResolvedModel {
  model: Model<Api>;
  source: ResolutionSource;
}

/**
 * Thrown when an explicit slot references a model the registry does not
 * know about. Distinct from auth-missing so the caller can give the user
 * a clear remediation ("run `agentify models set <slot> <provider>/<model>`
 * with a valid model id").
 */
export class SlotModelMissingError extends Error {
  readonly role: ModelRole;
  readonly slot: ModelSlot;
  constructor(role: ModelRole, slot: ModelSlot) {
    super(
      `agentify: slot '${role}' references model '${slot.provider}/${slot.model}' which is not in the model registry. ` +
        `Run \`agentify models set ${role} <provider>/<model>\` with a valid id from \`agentify models list\`.`,
    );
    this.name = "SlotModelMissingError";
    this.role = role;
    this.slot = slot;
  }
}

/**
 * Thrown when an explicit slot references a model whose provider has no
 * usable auth. Distinct from "model unknown" so the caller can tell the
 * user to run `agentify login --provider <name>` first.
 */
export class NoAuthForProviderError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(
      `agentify: no authentication for provider '${provider}'. ` +
        `Run \`agentify login --provider ${provider}\` (or set the env var) before using this slot.`,
    );
    this.name = "NoAuthForProviderError";
    this.provider = provider;
  }
}

/**
 * Resolve a model for a role. Explicit assignments throw when unavailable;
 * secondary roles inherit the configured primary model.
 */
export function selectModelForRole(
  registry: ModelRegistry,
  config: AgentifyConfig,
  role: ModelRole,
): ResolvedModel | undefined {
  const configuredModels = config.models ?? {};
  const explicit = configuredModels[role];
  if (explicit) {
    return resolveExplicit(registry, role, explicit);
  }

  if (role !== "primary") {
    const primarySlot = configuredModels.primary;
    if (primarySlot) {
      const inherited = tryResolve(registry, primarySlot);
      if (inherited) {
        return { model: inherited, source: "inherited-primary" };
      }
    }
  }

  if (config.provider) {
    const providerFirst = registry.getAvailable().find((model) => model.provider === config.provider);
    if (providerFirst) return { model: providerFirst, source: "provider-default" };
  }

  const fallback = registry.getAvailable()[0];
  if (fallback) return { model: fallback, source: "registry-default" };
  return undefined;
}

/**
 * Strict resolver for an explicit role. Throws on miss so users
 * get a clear "you configured this, but it doesn't work" error rather
 * than a silent fallback to a weaker model.
 */
function resolveExplicit(
  registry: ModelRegistry,
  role: ModelRole,
  slot: ModelSlot,
): ResolvedModel {
  const found = registry.find(slot.provider, slot.model);
  if (!found) {
    throw new SlotModelMissingError(role, slot);
  }
  // Even if `find` succeeds, ensure the user has auth for this provider.
  // (This catches the "auth.json doesn't have this provider" case where
  // `find` would otherwise return a model that can't actually be called.)
  const available = registry.getAvailable();
  if (!available.some((m) => m.provider === found.provider && m.id === found.id)) {
    throw new NoAuthForProviderError(slot.provider);
  }
  return { model: found, source: "explicit-slot" };
}

/**
 * Non-throwing resolver used for primary-role inheritance.
 */
function tryResolve(registry: ModelRegistry, slot: ModelSlot): Model<Api> | undefined {
  const found = registry.find(slot.provider, slot.model);
  if (!found) return undefined;
  const available = registry.getAvailable();
  if (!available.some((m) => m.provider === found.provider && m.id === found.id)) {
    return undefined;
  }
  return found;
}

/**
 * Convenience for callers that don't care about the source — just want
 * the resolved `Model<Api>` or `undefined`. Throws on tier-1 errors.
 */
export function resolveModelOrThrow(
  registry: ModelRegistry,
  config: AgentifyConfig,
  role: ModelRole,
): Model<Api> | undefined {
  return selectModelForRole(registry, config, role)?.model;
}
