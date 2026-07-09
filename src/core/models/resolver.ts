// Slot-aware model resolver. Replaces the inline `selectModel` helper
// that previously lived in `pi-sdk-runtime.ts`. See ADR 0017 for the
// design rationale and the "max quality is the floor" invariant.

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentifyConfig, ModelRole, ModelSlot } from "../types.ts";

/**
 * Which tier of the resolver chain satisfied the request. Useful for
 * debug logs and `models show --resolved`.
 */
export type ResolutionSource =
  | "explicit-slot" // tier 1: config.modelsByRole[role]
  | "inherited-primary" // tier 2: explorer/scoring inheriting primary
  | "legacy-fields" // tier 3: config.provider + config.model
  | "registry-default"; // tier 4: registry.getAvailable()[0]

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
 * Resolve a `Model<Api>` for the given slot role. The four-tier
 * precedence is documented in ADR 0017. Tier-1 misses (slot set but
 * model unknown to the registry, or auth missing) throw — we never
 * silently downgrade when the user made an explicit choice.
 *
 * Returns `undefined` only when no tier produces a model (i.e., empty
 * registry AND no legacy fields), which is the terminal fallback path.
 */
export function selectModelForRole(
  registry: ModelRegistry,
  config: AgentifyConfig,
  role: ModelRole,
): ResolvedModel | undefined {
  const explicit = config.modelsByRole?.[role];
  if (explicit) {
    return resolveExplicit(registry, role, explicit);
  }

  if (role !== "primary") {
    // Tier 2a: explicit primary slot wins as the inheritance source.
    const primarySlot = config.modelsByRole?.primary;
    if (primarySlot) {
      const inherited = tryResolve(registry, primarySlot);
      if (inherited) {
        return { model: inherited, source: "inherited-primary" };
      }
      // Primary slot is set but unresolvable — advisory only, fall through.
    }
    // Tier 2b: legacy `provider`+`model` are also "the user's primary"
    // (by definition — that's the slot's job). Treat legacy fields as
    // an implicit primary for inheritance purposes. This makes
    // `models show --resolved` show "(inherits primary)" for explorer/
    // scoring even when the user hasn't migrated to slot syntax yet.
    if (config.provider && config.model) {
      const inherited = tryResolve(registry, {
        provider: config.provider,
        model: config.model,
      });
      if (inherited) {
        return { model: inherited, source: "inherited-primary" };
      }
    }
  }

  if (config.provider && config.model) {
    const fromLegacy = registry.find(config.provider, config.model);
    if (fromLegacy) {
      const available = registry.getAvailable();
      if (available.some((m) => m.provider === fromLegacy.provider && m.id === fromLegacy.id)) {
        return { model: fromLegacy, source: "legacy-fields" };
      }
    }
    // Provider-only fallback (matches Phase 1 behavior): if user has
    // provider but no specific model, take the first available for that
    // provider.
    if (config.provider) {
      const providerFirst = registry
        .getAvailable()
        .find((m) => m.provider === config.provider);
      if (providerFirst) return { model: providerFirst, source: "legacy-fields" };
    }
  }

  const fallback = registry.getAvailable()[0];
  if (fallback) return { model: fallback, source: "registry-default" };
  return undefined;
}

/**
 * Strict resolver for tier 1 (explicit slot). Throws on miss so users
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
 * Non-throwing resolver used for tier-2 inheritance. If the primary
 * slot is set but broken, fall through to tier 3 with a one-time
 * advisory warn (the warning is emitted by the call site if it cares;
 * this helper is silent to keep it pure).
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