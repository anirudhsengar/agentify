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
scaffold payload completeness, single public command, docs presence).

When you add a unit test file, add it to the `test:unit` script in
`package.json`.

## Running agentify without a TTY

The CLI prompts interactively for provider/auth on first run. For CI or
scripted use, pre-seed auth via environment (e.g. `OPENAI_API_KEY`) and
pass the non-interactive flags:

```bash
agentify --non-interactive --assume brownfield
```

- `--non-interactive` (alias `--yes`): never prompt; fail with a clear
  message if a required input is missing.
- `--assume brownfield|greenfield`: skip project-kind classification
  for ambiguous repos.
- `--config-dir <dir>`: use a different agentify state directory.

## Release

`prepublishOnly` runs `npm run typecheck && npm test`. The published
tarball is curated by the `files` field in `package.json`
(`bin`, `src`, `scaffold`, `.agents`, `.claude`, `skills-lock.json`,
`README.md`, `LICENSE`, `AGENTS.md`). Tests and docs are not published.
