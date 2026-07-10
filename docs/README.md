# Documentation Index

This directory is the documentation root for agentify. Detailed
prose docs (orientation, lifecycle walkthroughs, roadmap) are tracked
in this folder; Architecture Decision Records (ADRs) live under
`docs/adr/`.

## Where to start

| Topic | Path |
| --- | --- |
| Public CLI surface, modes, and config-utility subcommands | `README.md` (repo root) |
| Working notes for coding agents operating in this repo | `AGENTS.md` (repo root) |
| Changelog | `CHANGELOG.md` (repo root) |
| Security policy | `SECURITY.md` (repo root) |
| Contributing guide | `CONTRIBUTING.md` (repo root) |

## Architecture Decision Records (`docs/adr/`)

ADRs are numbered, dated, and immutable once accepted. When you change
something that supersedes an ADR, write a new ADR that links to and
retires the older one.

| ADR | Title |
| --- | --- |
| 0008 | One package, two entry modes |
| 0014 | Coverage gate in code |
| 0015 | Public orchestration plane |
| 0017 | Named model slots (`primary`, `explorer`, `scoring`) |
| 0020 | Provider-scoped state directory (ADR 0020) |

> The full ADR list (0001–0020) is committed to this directory; the
> individual files are the canonical reference. The list above is
> intended as a quick lookup.

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