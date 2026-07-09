# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Slot consumers wired across every LLM call site (Phase 3 of ADR 0017):
  - AIW phases (plan, build, review, fix) consume the `scoring`
    slot by default; `state.model_role` overrides per AIW.
  - Orchestrator sub-agents (`AgentManager.runAgent`) thread
    `state.model`, `state.thinking_level`, and `state.model_role`
    into the runtime session. Closes the Phase 2 gap.
  - Orchestrator host session itself sets `modelRole: "primary"`.
  - `agent-expert.ts` LEARN/REUSE flows accept a `modelSlot` and
    pass it to `pi -p` via `AGENTIFY_LEARN_MODEL` env var.
  - AIW `scheduleExpertSelfImprove` and orchestrator
    `AutoImproveScheduler` resolve the scoring slot at call time.
  - Webhook triggers carry a `model_role` slot hint in
    `PromptInvocationSchema`; the worker threads it through to
    the runtime.
- First-run picker offers three tier presets — `Max quality`,
  `Balanced`, `Cost optimized` — plus the existing `Customize`
  advanced path. `pickTierPreset` exports a pure helper that
  ranks models by `reasoning` and `contextWindow` and buckets them
  into three tiers.
- `--provider` and `--key` flags on `agentify login` (Phase 1).
- Named model slots (ADR 0017): `primary`, `explorer`, `scoring`.
  - `AgentifyConfig.modelsByRole?: Partial<Record<ModelRole, ModelSlot>>`
    plus `AgentRuntimeSessionOptions.modelRole?: ModelRole`.
  - Slot-aware resolver in `src/core/models/resolver.ts` with
    4-tier precedence (explicit slot → inherited primary → legacy
    fields → registry default). Tier-1 misses throw — agentify never
    silently downgrades from an explicit user choice.
  - CLI: `models set <slot> <provider>/<model>` and
    `models unset <slot>` for slot management; legacy
    `models set <provider>/<model>` and `models unset` still work.
    `models show` keeps the three pinned lines and appends a
    `slots:` block; `models show --resolved` prints the final
    resolved model per role.
  - First-run picker: on a fresh install, `ensureAgentifyConfig`
    prompts for a model strategy (one model for everything vs.
    different models per role) before saving the config.
  - `spawn_explorer` is now slot-aware: sub-agents run on the
    resolved `explorer` slot model. The advisory-only
    `MODE_MODEL_DEFAULT` table is deleted; the `haiku`/`sonnet`/
    `opus` literals now map to specific known model IDs and error
    cleanly if the user's auth doesn't cover them.
  - Logout cleanup: `agentify logout --provider <name>` clears any
    slot whose provider matches the logged-out provider.
  - "max quality is the floor" invariant: unset slots fall back to
    `primary`; explicit user choices are never silently overridden.
- New config-utility subcommands (ADR 0008 amendment, 2026-07-09) that
  manage `~/.agentify/{config,auth}.json` without invoking the audit
  runtime:
  - `agentify login [--provider <name>] [--key <key>]` — store or
    replace an API key. Prompts interactively when no flags are
    supplied; prints setup instructions for OAuth-only providers
    (e.g., `openai-codex`).
  - `agentify logout [--provider <name> | --all] [--yes]` — remove one
    provider's credentials, or wipe all stored auth. `--all` prompts
    for confirmation in interactive shells; `--yes` skips the prompt.
  - `agentify models list [--provider <name>]` — print available
    models from the Pi model registry, filtered by configured auth.
  - `agentify models show` — print the configured provider, model,
    and thinking level.
  - `agentify models set <provider>/<model>` — set the model in
    `config.json`, validating against the model registry and current
    auth.
  - `agentify models unset` — clear provider and model from
    `config.json` (preserves `thinkingLevel`).
- Full `docs/` tree: lifecycle, orientation, repository layout,
  development guide, webhook-server notes, orchestrator notes, and the
  ADR set (`docs/adr/0001`–`0014`).
- `LICENSE` (MIT) and this changelog.
- Root CI workflow (`.github/workflows/ci.yml`) running typecheck and
  the full test suite on push and pull request.
- Code-enforced audit coverage gate: success and harness export now
  require the validated codebase map to have every dimension
  `covered` ([ADR 0014](docs/adr/0014-coverage-gate-in-code.md)).
- Repository jail and expanded zero-access paths in the defense hook;
  the hook now also protects the agentify config dir and confines
  writes to the working directory.
- Defense hook is now attached to explorer sub-agent sessions and
  greenfield sessions.
- `package.json`: `files` allowlist, `repository`/`bugs`/`homepage`,
  and a `prepublishOnly` gate (`typecheck` + `test`).

### Changed

- ADR 0017 introduced; ADR 0008 amended to permit config-utility
  subcommands. The single runtime entry (`agentify` with no
  arguments) is unchanged; new subcommands operate only on the
  agentify config directory and never invoke the runtime.
  Defensive guard in `src/core/agentify-app.ts` rewritten to throw
  on unknown positional arguments with a message listing valid
  subcommands.
- `ensureAgentifyConfig` now writes `auth.json` via `AuthStorage`
  (file-locked) instead of `writeJson0600`, matching the write path
  used by `agentify login`.
- `npm test` now runs `tsc --noEmit` before the unit and contract
  suites.
- The final codebase map is preserved as a managed artifact instead of
  being deleted on every run; partial/aborted runs no longer discard
  progress.
- CLI surface reduced to `-h/--help`, `-v/--version`, and
  `--mode <kind>`. Removed `--non-interactive` / `--yes` /
  `--config-dir`; renamed `--assume` to `--mode`. The agentify state
  directory is no longer configurable from the CLI; it always lives at
  `~/.agentify`.

## [0.1.0]

- Initial internal version: brownfield audit, greenfield formation,
  harness exports, GitHub scaffold, internal runtimes.
