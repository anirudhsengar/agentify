# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Full `docs/` tree: lifecycle, orientation, repository layout,
  development guide, webhook-server notes, orchestrator notes, and the
  ADR set (`docs/adr/0001`–`0014`).
- `LICENSE` (MIT) and this changelog.
- Root CI workflow (`.github/workflows/ci.yml`) running typecheck and
  the full test suite on push and pull request.
- Non-interactive CLI mode: `--non-interactive` / `--yes`,
  `--assume brownfield|greenfield`, documented `--config-dir`.
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

- `npm test` now runs `tsc --noEmit` before the unit and contract
  suites.
- The final codebase map is preserved as a managed artifact instead of
  being deleted on every run; partial/aborted runs no longer discard
  progress.

## [0.1.0]

- Initial internal version: brownfield audit, greenfield formation,
  harness exports, GitHub scaffold, internal runtimes.
