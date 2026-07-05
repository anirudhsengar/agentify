# ADR 0011: jiti runtime TypeScript, no build step

Status: Accepted

## Context

agentify is written in TypeScript ESM. Publishing normally requires a
build step producing `dist/`, plus keeping the build and source in
sync. We want the published package to run the TypeScript sources
directly without a compile step, while keeping strict typechecking as
a gate.

## Decision

`bin/agentify.js` loads `src/cli.ts` at runtime through `jiti`:

```js
const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../src/cli.ts");
```

`tsconfig.json` stays `noEmit: true`. `tsc --noEmit` is the type gate,
run in `npm run typecheck` and gated before publish via
`prepublishOnly`. The published tarball ships `bin/`, `src/`,
`scaffold/`, `.agents/`, `.claude/`, and `skills-lock.json` (see the
`files` field in `package.json`).

## Consequences

- No `dist/`, no build/source drift.
- `jiti` is a runtime dependency.
- First invocation pays a one-time transpile cost; acceptable for a
  one-shot bootstrap CLI.
- Typecheck is not enforced at import time, so `npm run typecheck` must
  run in CI and before publish.
