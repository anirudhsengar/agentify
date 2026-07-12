# AGENTS.md

Working notes for coding agents. Read `README.md` first for the product and
command surface. This file covers repository conventions, ownership boundaries,
and implementation constraints.

## Build and test

- `npm run build` — bundle the ESM CLI into `dist/` and copy runtime assets.
- `npm run typecheck` — `tsc --noEmit`. Must pass.
- `npm run test:all` — build, recursively run TypeScript tests, then contract tests.
- `npm run test:package` — pack, inspect, install, and execute the real npm artifact.
- `npm test` — typecheck plus the complete executable test suite.
- Node `>=22.19.0`. ESM only (`"type": "module"`).
- Tests in `tests/` are discovered recursively; `tests/run.sh` runs repository
  contract tests. Scaffold tests under `scaffold/tests/` validate generated
  target-repository behavior.

## Conventions

- **Strict TypeScript, no `any`.** Use `unknown` plus type guards. Use `import
  type` for type-only imports. No default exports unless required by a framework.
  Prefer functions and explicit data structures; use classes only for genuine
  stateful behavior.
- **Naming:** files/folders `kebab-case`; functions `camelCase`;
  types/interfaces `PascalCase`; module constants `SCREAMING_SNAKE_CASE`;
  schema constants `PascalCaseSchema`; tool names `snake_case`.
- **TypeBox:** top-level schemas use `Type.Object({...})`. Descriptions are
  load-bearing model instructions. Use `Type.Optional(...)` for optional fields
  and bounded arrays where possible.

## Ownership boundaries

- `src/core/audit/schema.ts` is the only file defining audit TypeBox schemas.
- Audit coverage logic, map default injection, and legacy-field interpretation live
  in `coverage.ts`, `map-defaults.ts`, and `schema-compatibility.ts`; preserve
  their compatibility re-exports from `schema.ts` and do not add TypeBox
  declarations there.
- Audit defense and capability policy live under `src/core/audit/defense/`.
- State transaction behavior lives in `src/core/state-transaction.ts` and must
  remain crash-recoverable.
- Build logic lives in `scripts/build.mjs`; workflows call it rather than
  duplicating packaging behavior.
- Package-root discovery must use `src/core/package-root.ts`.
- Orchestrator, AIW, webhook, communications, and Agent Expert modules are
  internal experimental surfaces. Do not expose them through package exports or
  CLI commands without satisfying `docs/experimental-surfaces.md`.
- Supported code may depend on supported or explicitly neutral modules only.
  Neutral shared modules must not import experimental composition roots. The
  sole current neutral exception inside an experimental directory is
  `src/core/orchestrator/workflow-spec.ts`; declarative workflow JSON assets are
  build inputs, not an orchestrator runtime API.
- New shared exceptions, CLI routes, package exports, or build copies involving
  experimental paths require architecture, package, and security review plus an
  update to `tests/maintenance/module-boundaries.test.ts`.

## Security and generation invariants

- The builder and explorers run in-process through
  `@earendil-works/pi-coding-agent` with explicit execution policies.
- Brownfield evidence collection receives read-only built-ins: `read`, `grep`,
  `find`, and `ls`, plus trusted structured tools such as `write_map`,
  `write_map_delta`, and `spawn_explorer`. Do not restore unrestricted `bash`,
  `write`, or `edit` to audit sessions.
- Every model-backed session must declare allowed tools, readable/writable roots,
  protected paths, shell posture, and network posture. Prompts are not a sandbox.
- Structured output only: model proposals enter application-owned tools and
  strict schemas. Never parse free-form model prose as authoritative state.
- Generated user-facing artifacts are applied only after coverage/substance
  gates pass. Managed markers and manifests—not the model—determine ownership.
- Generated `AGENTS.md` in target repositories is capped at 200 lines.

## Dependency and package policy

- New production dependencies require explicit maintainer review and a clear
  installed-runtime justification.
- Current production dependencies are `typebox`, `@earendil-works/pi-ai`, and
  `@earendil-works/pi-coding-agent`. They are regular dependencies because the
  installed CLI requires them; they are not peer dependencies.
- Build/test tooling such as `esbuild`, `tsx`, and TypeScript belongs in
  `devDependencies`.
- The npm artifact exposes the `agentify` executable only, excludes raw `src/`,
  and blocks deep imports. Do not use runtime TypeScript loaders or add `jiti`.
- Runtime prompt/workflow assets must be copied explicitly and asserted by
  `tests/package/installed-cli-smoke.mjs`.

## Release and documentation

- Update `CHANGELOG.md` under `[Unreleased]` for notable changes.
- Update relevant architecture, security, build, state, or release docs when a
  trust boundary or lifecycle changes.
- Release publication must remain tag-only and artifact-driven. Manual dispatch
  is verification-only.

## Out of scope

Do not resurrect extension adapters, slash-command registration, Pi
auto-discovery, unsupported library exports, or hidden public control-plane
commands. User-facing behavior enters through the documented CLI and generated
GitHub runtime.
