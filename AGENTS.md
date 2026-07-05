# AGENTS.md

Working notes for coding agents. For what `agentify` is and its command
surface, read `README.md` first. This file only covers what you can't
infer from the code: conventions, ownership boundaries, and gotchas.

## Build & test

- `npm run typecheck` — `tsc --noEmit`. Must pass.
- `npm test` — unit suite (`tsx`) then `bash tests/run.sh` contract tests.
- Node `>=22.19.0`. ESM only (`"type": "module"`).
- Tests in `tests/` mirror source; `tests/run.sh` runs the repo's own
  contract tests (`tests/test-*.sh`), distinct from the ones stamped into
  a target repo under `scaffold/tests/`.

## Conventions

- **TypeScript strict, no `any`.** Use `unknown` + type guards. `import
  type` for type-only imports. No default exports unless a framework
  requires it. No classes unless they hold state across many methods. No
  bespoke logging framework.
- **Naming:** files/folders `kebab-case`; functions `camelCase`;
  types/interfaces `PascalCase`; module constants `SCREAMING_SNAKE_CASE`;
  schema constants `PascalCaseSchema`; tool names `snake_case`.
- **TypeBox:** `Type.Object({...})` at top level. `description` strings
  are load-bearing (they steer the LLM) — write them deliberately.
  `Type.Optional(...)` for optional fields. `StringEnum` from
  `@earendil-works/pi-ai` for string-literal unions. Arrays carry
  `{ minItems, maxItems }`.

## Ownership boundaries

- `src/core/audit/schema.ts` is the **only** file that defines audit
  TypeBox schemas.
- Audit defense/gating policy lives under `src/core/audit/defense/` — keep
  it centralized there.
- Orchestrator state and prompts live under `src/core/orchestrator/`.

## Gotchas

- **The builder runs in-process** via `createAgentSession` from
  `@earendil-works/pi-coding-agent` — no subprocess, shim, temp prompt
  file, or auth forwarding. Session options assembled in
  `src/core/run-agentify.ts`; system prompt is
  `src/core/audit/prompts/builder.md`. Tool allowlist: `read, grep, find,
  ls, bash, write, edit`, `write_map`, `write_map_delta`, `spawn_explorer`.
- **No new runtime dependencies** without a documented ADR. Current
  approved runtime dep: `typebox`. Peers: `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`.
- **Structured output only** — the builder writes state through `write_map`
  against strict schemas. Never parse free-form LLM text.
- **Generated `AGENTS.md` is hard-capped at 200 lines** and only written
  after every coverage area reaches `covered` (no partial success). This
  applies to the file agentify emits into a *target* repo, produced by
  `builder.md` + `src/core/artifact-exporters.ts`.
- `package.json` exposes `bin.agentify` only. Do not add
  `keywords: ["pi-package"]` or a `pi` manifest.

## Out of scope

Do not resurrect extension adapters, slash-command registration, or Pi
auto-discovery. User-facing commands are CLI subcommands under
`src/cli*.ts`, not slash commands.
