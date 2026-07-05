# 001 — Product invariants test harness

## Goal

Add regression tests that encode the audit's most important product
contracts before refactoring the implementation.

## Why this matters

The current suite is broad, but it does not fail for several product
breakages: partial files left after failed audit, conflicts reported as
success, and docs/package mismatch.

## Evidence

- `tests/audit/coverage-gate.test.ts` verifies no harness export on an
  incomplete map, but does not assert that user-facing files are rolled
  back.
- `tests/scaffold-installer.test.ts` checks conflict reporting, but not
  how conflicts affect `runAgentify()` state.
- `src/core/repo-status.ts` marks readiness from path existence.

## Scope

Add tests only; do not change production behavior except for test seams if
necessary.

## Implementation plan

1. Add a test where fake runtime writes `AGENTS.md`, `specs/README.md`,
   and `ai_docs/README.md` but no valid map; assert the final desired
   behavior is no applied user-facing files after issue 004.
2. Add a test where pre-existing user-owned `AGENTS.md` conflicts; assert
   no harness export copies that content to `CLAUDE.md` after issue 005.
3. Add a test where pre-existing user-owned `.github/workflows/agent-implement.yml`
   conflicts; assert persisted project state is `partial`, not `ready`,
   after issue 005.
4. Add a package/docs test around `npm pack --dry-run` or a static
   equivalent: README/stamped SETUP links must resolve in the package or
   not be present.

## Acceptance criteria

- New tests are present and initially document the desired behavior.
- Tests are named so future agents understand which product invariant
  failed.
- `npm run typecheck` passes.

## Validation

```bash
npm run typecheck
npm run test:unit
bash tests/run.sh
```
