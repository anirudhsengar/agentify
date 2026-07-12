# Documentation Index

This directory is the documentation root for Agentify. The installed CLI is the
only supported public runtime surface in 0.1.x. Internal runtime modules are
explicitly classified as experimental and are documented separately from the
public product contract.

## Where to start

| Topic | Path |
| --- | --- |
| Public CLI surface, modes, and config-utility subcommands | `README.md` (repo root) |
| Supported versus internal experimental surfaces | `docs/experimental-surfaces.md` |
| Generation architecture and trust boundary | `docs/architecture.md` |
| Execution-policy security model | `SECURITY.md` (repo root) |
| Transactional provider-state lifecycle | `docs/state-lifecycle.md` |
| Webhook HTTP security model | `docs/webhook-security.md` |
| Verified artifact release process | `docs/release-process.md` |
| Working notes for coding agents operating in this repo | `AGENTS.md` (repo root) |
| Changelog | `CHANGELOG.md` (repo root) |
| Contributing guide | `CONTRIBUTING.md` (repo root) |

## Source references

Where this documentation tree does not yet cover an implementation detail, the
source of truth remains the code under `src/`. Source availability does not make
an internal module a supported package API.

- **Public CLI and parser** — `src/cli.ts`, `src/core/cli-parser.ts`,
  `src/core/cli-commands.ts`.
- **Audit and defense hook** — `src/core/audit/`, `src/core/audit/defense/`,
  `src/core/audit/schema.ts`, `src/core/audit/prompts/`.
- **Execution policy** — `src/core/security/execution-policy.ts`.
- **Transactional state** — `src/core/state-dir.ts`,
  `src/core/state-transaction.ts`.
- **Internal experimental orchestrator** — `src/core/orchestrator/`.
- **Internal experimental AIW runtime** — `src/core/aiw/`.
- **Internal experimental webhook runtime** — `src/core/webhook/`.
- **Named model slots** — `src/core/models/`.
- **Harness export** — `src/core/artifact-exporters.ts`.
- **Shipped scaffold** — `scaffold/`.
- **Tests** — `tests/`.
