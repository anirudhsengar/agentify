# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

- ADR 0008 amended to permit config-utility subcommands. The single
  runtime entry (`agentify` with no arguments) is unchanged; new
  subcommands operate only on the agentify config directory and never
  invoke the runtime. Defensive guard in `src/core/agentify-app.ts`
  rewritten to throw on unknown positional arguments with a message
  listing valid subcommands.
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
