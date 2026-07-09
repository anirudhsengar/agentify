# ADR 0008: One package, two entry modes

Status: Accepted (amended 2026-07-09; further amended 2026-07-09 by ADR 0020)

## Context

agentify began as a Pi extension named "GreenField" with several
public command families (webhook, aiw, orchestrator, expert). That
surface was large, confusing, and leaked internal machinery to users.

The `.pi/agentify/` directory used for internal state was a
direct carry-over from the Pi extension era. With the harness
picker introduced in ADR 0018, that hardcoding no longer matches
the user's actual target. Per ADR 0020, the audit's state dir
is now derived from the user's selected provider rather than
the legacy `.pi/agentify/` constant.

## Decision

agentify is a **standalone npm package with one public runtime CLI
entry**: `agentify` with no positional arguments. It has no Pi manifest
and is not a Pi extension. `bin.agentify` points at `./bin/agentify.js`.

The single runtime entry adapts to the repository it is run in:

- **Brownfield** (existing code): audit and export the agentic surface.
- **Greenfield** (empty/starter): a local-first formation chat.

Bootstrap, attach, and recovery all start from `agentify` with no
positional arguments. Internal runtimes (webhook, AIW, orchestrator,
coms) still ship as library code but are not public runtime commands.

### Amendment (2026-07-09): config-utility subcommands

In addition to the single runtime entry, agentify exposes three
**config-utility subcommands** that operate only on
`~/.agentify/{config,auth}.json`:

- `agentify login` — store or replace an API key.
- `agentify logout` — remove one provider's credentials, or all.
- `agentify models` — list/show/set/unset the configured model.

These subcommands never invoke the audit runtime and never modify the
repository. They are dispatched in `src/cli.ts` before `--mode`
parsing; their handlers live in `src/core/cli-commands.ts`.

This amendment is intentionally narrow: any future operational
subcommand (one that starts a runtime, mutates the repo, or replaces
the runtime entry) requires a new ADR.

## Consequences

- `src/core/agentify-app.ts` continues to reject any positional
  argument as defense-in-depth. The runtime never observes a
  positional; subcommand dispatch happens earlier in `src/cli.ts`.
- Subcommand dispatch lives in `src/core/cli-commands.ts` and is
  routed by `src/cli.ts` before `--mode` is parsed.
- The contract test forbids reintroducing internal runtimes as
  subcommands (`webhook`, `aiw`, `orchestrator`, `expert`), a `pi`
  manifest, the `pi-package` keyword, or extension adapter files. It
  also asserts the three config-utility subcommands are dispatched in
  `src/core/cli-commands.ts`.
- Non-command flags remain: `--help`, `--version`, and `--mode <kind>`.
  See the [development guide](../14-development-guide.md).