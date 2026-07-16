# Changelog

All notable changes to Agentify are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses Semantic Versioning while remaining pre-1.0.

## [Unreleased]

### Changed

- Brownfield audit map guidance now directs read-only model sessions to submit inline maps with `write_map(mode="auto")`; automatic private draft transport handles oversized maps without suggesting an unavailable general-purpose write tool.
- The paired Pi runtime packages are upgraded atomically to 0.80.7, retaining Node 22.19.0 support, Pi-controlled TypeBox 1.1.38 copies, Agentify-owned authentication and execution policy, model-visible tool contracts, and the existing Smithy integrity override while accepting upstream provider, dynamic-tool, session-affinity, and Bedrock fixes.
- The direct TypeBox dependency is upgraded to 1.3.6 while Pi-controlled nested TypeBox copies remain at 1.1.38; schema serialization, validation/error behavior, tool-schema identity, package boundaries, and the Node support policy are unchanged.
- esbuild is upgraded to 0.28.1 and tsx to 4.23.1 as one build-tooling group; the lockfile deduplicates tsx's nested esbuild/platform tree while preserving the Node 22 ESM bundle, source maps, runtime assets, installed CLI behavior, and 181-file package inventory.
- TypeScript is upgraded to 6.0.3 with Node-22 declarations 22.20.1; obsolete `baseUrl`, wildcard `paths`, and `ignoreDeprecations` configuration are removed while the Node 22.19.0 runtime floor and ESM/bundler behavior remain unchanged.
- Audit-schema domain ownership and downward-only dependencies are documented and machine-enforced while preserving the declaration-free façade, schema identity, algorithm separation, and package confinement.
- Audit-map complete/partial composition and write-map parameter schemas now have canonical owners under `src/core/audit/schema/`; the stable `schema.ts` façade is declaration-free and preserves object identity.
- Supported runtime code now owns state exclusively through explicit provider-scoped contexts, write-map factories, renderer contexts, and state-directory-aware manifest and greenfield APIs.
- Phase B retained-source migration, transaction recovery, deterministic conflict handling, provider switching, and Pi canonical `.pi/agentify` behavior remain unchanged.

### Removed

- Removed deprecated singleton `writeMapTool` / `writeMapDeltaTool` exports, mutable write-map and renderer state setters, omitted-context renderer behavior, and obsolete manifest, greenfield, and legacy path wrappers.
- Removed ordinary canonical-loader fallback probes; retained legacy trees are migration sources only and are never selected by normal readers.

## [0.2.1] - 2026-07-14

### Fixed

- `v0.2.0` was tagged, but npm publication did not complete and no GitHub release was published. The workflow passed `release-artifact/agentify-0.2.0.tgz` as an ambiguous package specification, so npm interpreted it as GitHub shorthand instead of a local tarball path.
- The publication workflow now resolves exactly one downloaded local `.tgz` file and publishes that explicit path, failing closed when zero or multiple tarballs are present.

### Changed

- `0.2.1` contains the complete release contents intended for `0.2.0`, together with the corrected artifact-publication workflow.
- The unscoped `agentify` npm name is owned by another publisher, so the official package is now `@anirudhsengar/agentify`; the installed executable remains `agentify`.
- Release artifact handling now derives the exact tarball filename from the single validated result returned by `npm pack --json` instead of assuming an unscoped filename.

## [0.2.0] - 2026-07-13

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

- Legacy state now migrates with a retained-source, journaled copy → verify → atomic-install transaction; the original legacy tree is retained and never silently deleted, explicit provider switches require `--targets` plus `--migrate-state`, recovery is phase-driven, and canonical readers/scaffold scripts no longer probe cross-provider fallbacks.
- Deprecated callable state, manifest, renderer, greenfield, and write-map compatibility APIs remain available in 0.2.0; this release does not perform Phase C removal.
- Relocated the internal communications registry, protocol types, and Unix-socket peer server beneath `src/core/orchestrator/comms/` without changing protocol, state, CLI, build, package, or support behavior.
- Legacy `.pi/agentify` compatibility use is classified deterministically and reported once per command with the exact source and provider-selected destination, providing deprecation guidance before any eligible migration.
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

- Provider-switch manifests are opened once with no-follow semantics, validated with `fstat`, and read from the same descriptor, removing the check-to-read race without weakening symlink refusal.
- Root confinement checks both lexical and symlink-resolved paths.
- Unrestricted shell tools were removed from brownfield audit sessions.
- Reload management is disabled by default and requires loopback plus constant-time token authentication.
- High-severity advisories in transitive `undici`, `protobufjs`, and `ws` dependencies were removed through the Pi runtime upgrade.

## [0.1.0]

Initial public CLI release.
