# ADR 0008: One package, two entry modes

Status: Accepted

## Context

agentify began as a Pi extension named "GreenField" with several
public command families (webhook, aiw, orchestrator, expert). That
surface was large, confusing, and leaked internal machinery to users.

## Decision

agentify is a **standalone npm package with one public CLI command**:
`agentify`. It has no Pi manifest and is not a Pi extension. `bin.agentify`
points at `./bin/agentify.js`.

The single command adapts to the repository it is run in:

- **Brownfield** (existing code): audit and export the agentic surface.
- **Greenfield** (empty/starter): a local-first formation chat.

Bootstrap, attach, and recovery all start from `agentify` with no
positional arguments. Internal runtimes (webhook, AIW, orchestrator,
coms) still ship as library code but are not public commands.

## Consequences

- `src/core/agentify-app.ts` rejects any positional argument.
- The contract test forbids reintroducing subcommands, a `pi`
  manifest, the `pi-package` keyword, or extension adapter files.
- Non-command flags remain: `--help`, `--version`, `--config-dir`,
  and the non-interactive flags documented in the
  [development guide](../14-development-guide.md).
