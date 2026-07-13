# Changelog

All notable changes to Agentify are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses Semantic Versioning while remaining pre-1.0.

## [Unreleased]

### Added

- A compatibility-first design and characterization fixture for retiring cross-provider `.pi/agentify` fallbacks and deprecated state/write-map APIs without deleting or silently selecting user state.
- A dependency compatibility matrix with official migration evidence, isolated lockfile impact, explicit #32/#33 gates, and six separately owned upgrade groups.
- Evidence-based lifecycle decisions for webhook, AIW, orchestrator, communications, and Agent Expert, with communications relocation split into a dedicated follow-up issue.
- An audited runtime-reachability inventory and maintenance guard for standalone scripts.
- Modernization behavior and runtime-reachability contracts with a reusable CLI, generated-bundle, state-directory, and installed-package parity gate.
- Typed top-level CLI parsing with process-level regression coverage.
- Recursive test discovery, security regression suites, and installed-package smoke tests.
- Explicit per-session execution policies for tools, filesystem roots, shell access, and network posture.
- Transactional provider-scoped state with journals, backups, rollback, migration, and interrupted-run recovery.
- Webhook replay protection, pre-authentication throttling, sanitized task status, and opt-in administrative reload.
- Tag/version release verification, artifact-driven publication, Node 22/24 CI, production dependency auditing, and package installation gates.
- A documented supported-versus-experimental product boundary.
- A compiled ESM distribution with packaged prompt/workflow assets and raw-source exclusion.

### Changed

- Relocated the internal communications registry, protocol types, and Unix-socket peer server beneath `src/core/orchestrator/comms/` without changing protocol, state, CLI, build, package, or support behavior.
- Legacy `.pi/agentify` compatibility use is now classified safely and reported once per command with the exact source and provider-selected destination; compatibility remains active and Phase A does not move or delete state.
- Enforced supported, neutral, and experimental source boundaries across imports, CLI registration, build assets, package contents, and documentation.
- Audit TypeBox declarations remain centralized in `schema.ts`, while coverage assessment, map defaults, and legacy-field interpretation now have focused internal owners behind stable re-exports.
- Structured write-map storage, input loading, validation, coverage formatting, delta merging, observability, tool construction, and legacy compatibility now have dedicated internal owners behind the stable façade.
- Deterministic brownfield artifact rendering is decomposed into pure output-family modules behind the stable renderer façade.
- Brownfield write-map tools and deterministic renderers now capture provider-scoped state through explicit per-run factories and contexts; deprecated mutable adapters remain for compatibility.
- Brownfield and greenfield run orchestration now live in explicit mode-specific modules behind the stable `runAgentify` coordinator.
- Repository-facing snapshot, staging, apply, reporting, and session-agent generation primitives now have dedicated internal owners while retaining compatibility re-exports.
- Shared artifact, agent-file, generated-surface, and package-version primitives now have dependency-neutral canonical owners with compatibility re-exports.
- Removed four evidence-backed, raw-source-only orphan scripts and corrected stale provider-state migration guidance.
- Brownfield audits and explorer sessions are read-only by capability, not by prompt convention.
- Webhook and AIW sessions now receive explicit repository-jail policies.
- Pi runtime packages were upgraded to `0.80.6`; provider environment-auth resolution is owned by Agentify.
- npm publication now uses the exact tarball verified by CI.
- The public npm package exposes only the `agentify` executable and blocks deep imports.
- The CLI binary executes `dist/cli.js` directly; `jiti` and runtime TypeScript execution were removed.
- TypeScript now rejects unused locals and parameters across production code and tests.

### Fixed

- Provider-scoped write-map factories now keep oversized-map draft transport under the selected state directory instead of writing through the legacy Pi path.
- `--mode` and `--targets` no longer collide with subcommand dispatch.
- Shell-based credential reads and repository mutation escapes are blocked.
- Webhook workers can no longer run without an enforceable sandbox policy.
- Failed Claude, Codex, and Pi runs no longer destroy valid prior state.
- Invalid webhook signatures no longer consume authenticated trigger quotas.
- Manual release dispatch can no longer publish packages or create GitHub releases.
- Test files can no longer be silently omitted by a manually maintained command chain.

### Security

- Root confinement checks both lexical and symlink-resolved paths.
- Unrestricted shell tools were removed from brownfield audit sessions.
- Reload management is disabled by default and requires loopback plus constant-time token authentication.
- High-severity advisories in transitive `undici`, `protobufjs`, and `ws` dependencies were removed through the Pi runtime upgrade.

## [0.1.0]

Initial public CLI release.
