# 002 — CLI error handling and UX polish

## Goal

Make expected CLI failures print clean `agentify: ...` errors instead of
Node stack traces.

## Evidence

- `bin/agentify.js` imports and awaits `main()` directly.
- `src/cli.ts` has a catch only in the `if (import.meta.url === ...)`
  branch, which is bypassed when launched through `bin/agentify.js`.
- Running `node bin/agentify.js foo` prints a stack trace.

## Scope

CLI behavior only.

## Implementation plan

1. Wrap the `await main(process.argv.slice(2))` call in `bin/agentify.js`
   with the same catch behavior used in `src/cli.ts`.
2. Add tests in `tests/cli-main.test.ts` or a new CLI-bin test that
   invokes the bin with a bad positional arg.
3. Confirm non-interactive missing-auth errors are concise.

## Acceptance criteria

- Expected user errors print one concise line beginning `agentify:`.
- Exit code is non-zero for failures.
- No stack trace is printed for invalid flags, subcommands, or missing
  non-interactive auth.

## Validation

```bash
node bin/agentify.js foo
node bin/agentify.js --non-interactive --assume brownfield --config-dir /tmp/empty-agentify-config
npm run typecheck
npm run test:unit
```
