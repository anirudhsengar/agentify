# Changelog

All notable changes to Agentify are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses Semantic Versioning while remaining pre-1.0.

## [Unreleased]

### Added

- Typed top-level CLI parsing with process-level regression coverage.
- Recursive test discovery, security regression suites, and installed-package smoke tests.
- Explicit per-session execution policies for tools, filesystem roots, shell access, and network posture.
- Transactional provider-scoped state with journals, backups, rollback, migration, and interrupted-run recovery.
- Webhook replay protection, pre-authentication throttling, sanitized task status, and opt-in administrative reload.
- Tag/version release verification, artifact-driven publication, Node 22/24 CI, production dependency auditing, and package installation gates.
- A documented supported-versus-experimental product boundary.
- A compiled ESM distribution with packaged prompt/workflow assets and raw-source exclusion.

### Changed

- Brownfield audits and explorer sessions are read-only by capability, not by prompt convention.
- Webhook and AIW sessions now receive explicit repository-jail policies.
- Pi runtime packages were upgraded to `0.80.6`; provider environment-auth resolution is owned by Agentify.
- npm publication now uses the exact tarball verified by CI.
- The public npm package exposes only the `agentify` executable and blocks deep imports.
- The CLI binary executes `dist/cli.js` directly; `jiti` and runtime TypeScript execution were removed.
- TypeScript now rejects unused locals and parameters across production code and tests.

### Fixed

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
