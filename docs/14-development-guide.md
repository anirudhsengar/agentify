# Development guide

## Prerequisites

- Node `>=22.19.0`
- ESM only (`"type": "module"`); the package runs TypeScript directly
  via jiti with no build step ([ADR 0011](adr/0011-jiti-runtime-typescript.md)).

## Commands

```bash
npm run typecheck   # tsc --noEmit — must pass
npm test            # typecheck + unit suite (tsx) + bash contract tests
bash tests/run.sh   # just the contract tests
npm run inspect-log # inspect a run's JSONL log
```

`npm test` runs `tsc --noEmit`, then the unit suite, then
`tests/run.sh`. Typecheck is part of the test gate; a type error fails
`npm test`.

## Conventions

- TypeScript strict, no `any`. Use `unknown` + type guards.
- `import type` for type-only imports. No default exports unless a
  framework requires it.
- Naming: files/folders `kebab-case`; functions `camelCase`;
  types/interfaces `PascalCase`; module constants `SCREAMING_SNAKE_CASE`;
  schema constants `PascalCaseSchema`; tool names `snake_case`.
- TypeBox: `Type.Object({...})` at top level; `description` strings are
  load-bearing (they steer the LLM); `Type.Optional(...)` for optional
  fields; arrays carry `{ minItems, maxItems }` where a floor matters.
- No new runtime dependencies without an ADR. Current runtime deps:
  `typebox`, `jiti`. Peers: `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`.

## Tests

Tests are bare `tsx` scripts using `node:assert/strict`. They are
hermetic: each creates temp dirs under `os.tmpdir()` and restores any
env/`HOME` it overrides. The contract tests
(`tests/test-*.sh`) guard repo invariants (skill mirror, skills-lock,
scaffold payload completeness, single public command, docs presence,
config-subcommand dispatch in `src/core/cli-commands.ts`).

When you add a unit test file, add it to the `test:unit` script in
`package.json`.

## Public CLI

`agentify` is a single-package, single-runtime-entry CLI. The runtime
entry is `agentify` with no positional arguments — that runs the
brownfield audit or starts the greenfield chat. Three
config-utility subcommands are also exposed
([ADR 0008](adr/0008-one-package-two-entry-modes.md), amended
2026-07-09):

```bash
agentify login [--provider <name>] [--key <key>]
agentify logout [--provider <name> | --all] [--yes]
agentify models list [--provider <name>]
agentify models show
agentify models set <provider>/<model>
agentify models unset
```

These subcommands operate only on `~/.agentify/{config,auth}.json` and
never invoke the runtime. Their handlers live in
`src/core/cli-commands.ts`; dispatch is wired in `src/cli.ts` before
`--mode` parsing. The defensive guard in `src/core/agentify-app.ts`
catches any positional argument that survives dispatch and throws
listing the valid subcommands.

When adding a new public subcommand, update `src/core/cli-commands.ts`,
extend the contract test in `tests/test-unification-invariants.sh`,
and add unit tests in `tests/cli-commands.test.ts`. Operational
subcommands (ones that start a runtime or mutate the repo) require a
new ADR — the 2026-07-09 amendment is intentionally narrow.

## Running agentify without a TTY

The CLI prompts interactively for provider/auth on first run. For CI or
scripted use, pre-seed auth via environment (e.g. `OPENAI_API_KEY`)
before running `agentify`; it will not prompt and will fail with a
clear message if a required input is missing. Use `--mode brownfield`
or `--mode greenfield` to skip project-kind classification for
ambiguous repos. `agentify login --provider <name> --key <key>` and
`agentify logout --all --yes` are non-interactive by design.

## Release

`prepublishOnly` runs `npm run typecheck && npm test`. The published
tarball is curated by the `files` field in `package.json`
(`bin`, `src`, `scaffold`, `.agents`, `.claude`, `skills-lock.json`,
`README.md`, `LICENSE`, `AGENTS.md`). Tests and docs are not published.
