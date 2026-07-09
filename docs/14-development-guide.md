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
agentify models show [--resolved]
agentify models set <provider>/<model>             # legacy: writes to provider/model
agentify models set <slot> <provider>/<model>      # slot: primary|explorer|scoring
agentify models unset                                # legacy: clears provider/model
agentify models unset <slot>                         # clears that slot
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

## Model slots (ADR 0017)

The `models` subcommands manage named model slots:

- `primary` — every existing `runSession` caller (brownfield, greenfield,
  orchestrator host, AIW phase, webhook task).
- `explorer` — consumed by `spawn_explorer` sub-agents.
- `scoring` — reserved for future lightweight judgment-call surfaces.

The resolver (`src/core/models/resolver.ts`) follows a 4-tier
precedence: explicit slot → inherited primary → legacy fields →
registry default. **Max quality is the floor**: unset slots fall back
to `primary`, and an explicit user choice is never silently overridden
(tier-1 misses throw a clear error).

On first run, `ensureAgentifyConfig` prompts for a model strategy
(one model vs. different models per role). The CLI lets you change
this later — `models set primary openai/gpt-4o` writes the primary
slot, `models set explorer anthropic/claude-haiku-4-5-20251001`
writes the explorer slot. Auto-populate: when you set `explorer` or
`scoring` without `primary` being set, primary is synthesized from
the legacy `provider`/`model` fields.

`spawn_explorer` is wired to the resolved `explorer` slot. The
advisory-only `MODE_MODEL_DEFAULT` table is deleted; the
`haiku`/`sonnet`/`opus` literals now map to specific known model IDs
(anthropic/claude-haiku-4-5-20251001, claude-sonnet-4-6,
claude-opus-4-8) and error cleanly if your auth doesn't cover them.

When extending the slot system: add the slot name to `ModelRole` in
`src/core/types.ts` (the `Partial<Record<ModelRole, ModelSlot>>`
shape will refuse to compile until all consumers update). Update the
resolver, the CLI parser, the spawn_explorer wiring, and add tests.
Wiring a new call site to a non-`primary` slot is just a matter of
setting `modelRole: "<slot>"` on the `AgentRuntimeSessionOptions`.

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
