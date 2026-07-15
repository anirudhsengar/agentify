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
| Experimental runtime lifecycle decisions and evidence | `docs/architecture/experimental-runtime-decisions.md` |
| Dependency compatibility matrix and upgrade gates | `docs/architecture/dependency-compatibility-matrix.md` |
| Generation architecture and trust boundary | `docs/architecture.md` |
| Modernization parity baseline and behavior contract | `docs/refactors/modernization-baseline.md` |
| Runtime reachability roots and deletion evidence | `docs/refactors/runtime-reachability.md` |
| Audit schema domain ownership, migration design, and drift gates | `docs/refactors/audit-schema-domain-migration.md` |
| Compiled build, runtime assets, and npm package boundary | `docs/build-and-package.md` |
| Execution-policy security model | `SECURITY.md` (repo root) |
| Transactional provider-state lifecycle | `docs/state-lifecycle.md` |
| Legacy state and deprecated API retirement design | `docs/migrations/legacy-state-retirement.md` |
| Webhook HTTP security model | `docs/webhook-security.md` |
| Verified artifact release process | `docs/release-process.md` |
| Working notes for coding agents operating in this repo | `AGENTS.md` (repo root) |
| Changelog | `CHANGELOG.md` (repo root) |
| Contributing guide | `CONTRIBUTING.md` (repo root) |

## Source references

Documentation describes supported contracts and trust boundaries. Source code
remains authoritative for implementation details, but source availability does
not make an internal module a supported package API.

- **Public CLI and parser** — `src/cli.ts`, `src/core/cli-parser.ts`,
  `src/core/cli-commands.ts`.
- **Audit and defense hook** — `src/core/audit/`, `src/core/audit/defense/`,
  `src/core/audit/schema/`, the stable `src/core/audit/schema.ts` façade, and
  `src/core/audit/prompts/`.
- **Execution policy** — `src/core/security/execution-policy.ts`.
- **Transactional state** — `src/core/state-dir.ts`,
  `src/core/state-transaction.ts`.
- **Build and package boundary** — `scripts/build.mjs`, `bin/agentify.js`,
  `src/core/package-root.ts`, `tests/package/installed-cli-smoke.mjs`.
- **Experimental runtime lifecycle decisions** —
  `docs/architecture/experimental-runtime-decisions.md`.
- **Dependency upgrade planning** —
  `docs/architecture/dependency-compatibility-matrix.md`.
- **Internal experimental orchestrator** — `src/core/orchestrator/`.
- **Internal experimental AIW runtime** — `src/core/aiw/`.
- **Internal experimental webhook runtime** — `src/core/webhook/`.
- **Named model slots** — `src/core/models/`.
- **Harness export** — `src/core/artifact-exporters.ts`.
- **Shipped scaffold** — `scaffold/`.
- **Modernization parity gate** — `tests/parity/`, `npm run test:parity`.
- **Maintenance invariants** — `tests/maintenance/`.
- **Complete tests** — `tests/`.
