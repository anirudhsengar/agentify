# ADR 0017: Named model slots (primary / explorer / scoring)

Status: Accepted

## Context

agentify has at least seven distinct LLM invocation sites
(see `src/core/run-agentify.ts`, `src/core/orchestrator/host.ts`,
`src/core/orchestrator/agent-manager.ts`, `src/core/webhook/worker.ts`,
`src/core/aiw/runtime.ts`, `src/core/audit/spawn-explorer-tool.ts`).
Phase 1 (ADR 0008 amendment, 2026-07-09) added `agentify login`,
`agentify logout`, and `agentify models set/show/list/unset` to manage a
single `(provider, model)` pair in `~/.agentify/config.json`. That gave
users one model for everything — which is fine for a small project, but
doesn't address the common case of a builder session that wants a
strong model and a swarm of `spawn_explorer` sub-agents that should run
on a cheaper model to control cost.

Before this ADR, `spawn_explorer`'s `MODE_MODEL_DEFAULT` table
(`topography → haiku`, `gap_filler → opus`, etc.) was **advisory only**:
the table was written into the sub-agent's "Constraints" prompt
paragraph but never actually routed the call to a different `Model<Api>`.
The sub-agent ran on the parent's resolved model regardless. This was
a documentation lie: the table promised behavior that the code didn't
deliver.

The user explicitly asked for the ability to assign different models to
different parts of agentify — with the invariant that max quality must
be the floor. We never silently downgrade.

## Decision

### Schema: `AgentifyConfig.modelsByRole`

```ts
type ModelRole = "primary" | "explorer" | "scoring";

interface ModelSlot {
  provider: AgentifyProvider;
  model: string;
}

interface AgentifyConfig {
  provider?: AgentifyProvider;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  modelsByRole?: Partial<Record<ModelRole, ModelSlot>>;
}
```

Three named slots. `primary` is the default resolver role; every
existing `runSession` call site defaults to it. `explorer` is consumed
by `spawn_explorer` sub-agents. `scoring` is reserved for future
lightweight judgment-call surfaces (e.g., AIW KPI scoring,
expert-outcome scoring).

### Resolver: 4-tier precedence (with `max quality is the floor`)

`selectModelForRole(registry, config, role)` in
`src/core/models/resolver.ts`:

1. **Explicit slot** — `config.modelsByRole[role]`. `registry.find`
   must succeed AND `getAvailable()` must include it. **Hard fail** if
   either check fails (`SlotModelMissingError` / `NoAuthForProviderError`).
2. **Inherit primary** — `config.modelsByRole.primary` if set, else
   legacy `config.provider` + `config.model`. Source is tagged
   `"inherited-primary"` so `models show --resolved` can annotate.
3. **Legacy fields** — `config.provider` + `config.model`. (Reachable
   only when tier 2 also fails.)
4. **Registry default** — `registry.getAvailable()[0]`. **Terminal**
   fallback. Only reached when no user intent is recorded anywhere.

**Invariants**:
- Tier 1 throws — the user made an explicit choice and we never
  silently fall through to a weaker model.
- Tier 2 source is `"inherited-primary"` even when the inheritance
  source is the legacy fields, so the user always sees the
  "inherits primary" annotation. This makes the migration UX
  honest: even before the user adopts slot syntax, the resolver
  treats legacy fields as the implicit primary.
- Tier 4 only fires when the user has recorded no preference at all
  (no slots, no legacy fields). This is the "max quality is the floor"
  guarantee — the only path to a model the user didn't choose is the
  absolute last resort.

### First-run picker

`ensureAgentifyConfig` (in `src/core/agentify-config.ts`) now prompts
for a model strategy on first run, after the provider + auth gate:

- "Use one model for everything" → set `primary` to the registry's
  first available model for the chosen provider; leave
  `explorer`/`scoring` unset.
- "Assign different models per role" → prompt for primary, then
  optionally explorer, then optionally scoring.

The picker only fires on true first run
(`!hasSlotConfig && !hasLegacyConfig`). It is bypassable via
`{ modelStrategy: "skip" | "single" }` for tests and CI.

### CLI surface

Extends Phase 1 commands without changing their shape:

```
agentify models set <slot> <provider>/<model>     # slot: primary|explorer|scoring
agentify models set <provider>/<model>            # legacy: writes to provider/model
agentify models unset <slot>                      # clears that slot
agentify models unset                             # legacy: clears provider/model
agentify models show                              # pinned lines + slots block
agentify models show --resolved                   # final resolved model per role
```

The three pinned lines (`provider:`, `model:`, `thinking:`) printed by
`models show` are byte-for-byte identical to Phase 1 (test-pinned).
The new `slots:` block appears underneath.

### Logout cleanup

`agentify logout --provider <name>` now also clears any slot whose
`provider` matches the logged-out provider. `agentify logout --all`
clears all slots. `thinkingLevel` is always preserved.

### `spawn_explorer` wiring

`SpawnExplorerToolOptions` now requires `explorerModel: Model<Api>` and
`modelRegistry: ModelRegistry`. `PiSdkRuntime.runSession` builds the
tool internally from these values:

- `explorerModel = selectModelForRole(registry, config, "explorer")?.model`
  (or the parent's resolved model if the explorer slot is unset).
- `modelRegistry` is the same registry the runtime uses.

The advisory-only `MODE_MODEL_DEFAULT` table is **deleted**. The
`haiku`/`sonnet`/`opus` literals are now mapped to specific known
`{provider, id}` pairs (anthropic/claude-haiku-4-5-20251001,
anthropic/claude-sonnet-4-6, anthropic/claude-opus-4-8) via
`LITERAL_TO_MODEL`, with `registry.find` validation — if the literal
points at a model the user can't call, the tool returns a clear
error rather than silently downgrading.

### `AgentRuntimeSessionOptions.modelRole`

A new optional field. Defaults to `"primary"`. Wired by callers that
want to opt into a different slot:

| Caller | Phase 2 modelRole |
| --- | --- |
| Brownfield builder | unset → primary |
| Greenfield chat | unset → primary |
| Orchestrator host | unset → primary |
| Orchestrator agent-manager | unset → primary |
| Webhook worker | unset → primary |
| AIW runtime | unset → primary |
| `spawn_explorer` | `"explorer"` (the only non-primary caller in Phase 2) |

## Consequences

- `src/core/models/resolver.ts` (new) exports `selectModelForRole` and
  the two error classes. It replaces the inline `selectModel` helper
  that previously lived in `pi-sdk-runtime.ts`.
- `src/core/pi-sdk-runtime.ts` no longer holds its own resolver; it
  delegates to the new module. It also constructs `spawn_explorer`
  internally (instead of accepting it as a `customTool` from the
  caller) so the tool uses the same registry + explorer slot.
- `src/core/audit/spawn-explorer-tool.ts` requires `explorerModel`
  and `modelRegistry` and uses them for the literal-mapping path.
  `MODE_MODEL_DEFAULT` is deleted.
- `src/core/agentify-config.ts` extends the loader and adds the
  strategy picker to `ensureAgentifyConfig`.
- `src/core/cli-commands.ts` extends `models set/unset/show` for
  slot awareness and the `--resolved` flag. `logout` clears
  per-provider slots.
- `tests/cli-commands.test.ts` gains 10 slot tests; existing pinned
  tests stay green.
- `tests/config-schema.test.ts` (new) round-trips `modelsByRole`.
- `tests/first-run-picker.test.ts` (new) covers the strategy picker.
- `tests/audit/spawn-explorer-slot.test.ts` (new) verifies the slot
  is honored.

## Out of scope (Phase 3+)

- Wiring AIW runtime / webhook worker / orchestrator agent-manager
  to non-`primary` slots.
- `agent-expert.ts` LEARN/REUSE slot consumer.
- Tier *presets* in the first-run picker UI (e.g., "Max quality",
  "Balanced", "Cost optimized").
- `--alias haiku` shortcuts on `models set`.
- `coms` envelope model field (cross-process routing).
- File locking for `config.json` writes (currently last-writer-wins;
  `auth.json` is already locked via `AuthStorage`).
- New roles beyond `primary`/`explorer`/`scoring`. The schema uses
  `Partial<Record<ModelRole, ModelSlot>>` so adding a role would be a
  compile-time nudge to update all consumers.

## Risks

1. **Tier-1 hard-fail on slot set but model missing.** The "max
   quality is the floor" rule is inverted here: explicit user choice
   missing from registry = configuration error, not "use whatever's
   lying around". This is a deliberate trade-off; surface the error
   clearly so the user re-runs `models set` with a valid id.
2. **Auto-populate visibility.** When `models set explorer X`
   synthesizes `primary` from legacy fields, the user sees `primary`
   appear in `models show`. Document this in the help text.
3. **`loadAgentifyConfig` must stay pure.** Synthesis happens in
   `modelsSet`, never in the loader. If synthesis leaks into the
   loader, `loadAgentifyConfig` returns state that doesn't match
   disk.
4. **Concurrent writes to `config.json`.** Phase 1 routed auth
   through `AuthStorage` (file-locked), but `saveAgentifyConfig`
   for `config.json` is not locked. Phase 4 hardening; Phase 2
   inherits the race window. Document in CHANGELOG.
5. **`MODE_MODEL_DEFAULT` removal is a behavioral change.** Today's
   `model: "haiku"` parameter feels like it works (the user task
   gets a "Constraints" paragraph mentioning haiku) but doesn't
   actually switch models. Phase 2 deletes the table and makes the
   literal actually call `registry.find` — the honest fix.