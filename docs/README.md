# Documentation Index

This directory is the documentation root for agentify. Detailed
prose docs (orientation, lifecycle walkthroughs, roadmap) are tracked
in this folder.

## Where to start

| Topic | Path |
| --- | --- |
| Public CLI surface, modes, and config-utility subcommands | `README.md` (repo root) |
| Working notes for coding agents operating in this repo | `AGENTS.md` (repo root) |
| Changelog | `CHANGELOG.md` (repo root) |
| Security policy | `SECURITY.md` (repo root) |
| Contributing guide | `CONTRIBUTING.md` (repo root) |
| Generation architecture and trust boundary | `docs/architecture.md` |

## Code, not prose

Where this `docs/` tree does not yet cover a topic, the source of
truth is the code under `src/`. Specifically:

- **Audit and defense hook** — `src/core/audit/`, `src/core/audit/defense/`,
  `src/core/audit/schema.ts`, `src/core/audit/prompts/`.
- **Orchestrator** — `src/core/orchestrator/`.
- **AIW (plan / build / review / fix)** — `src/core/aiw/`.
- **Webhook server** — `src/core/webhook/`.
- **Named model slots** — `src/core/models/`.
- **Harness export** — `src/core/artifact-exporters/`.
- **Shipped scaffold** — `scaffold/`.
- **Tests** — `tests/`.
