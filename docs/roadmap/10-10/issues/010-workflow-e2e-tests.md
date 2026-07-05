# 010 — GitHub workflow E2E simulation

## Goal

Add end-to-end tests for stamped GitHub workflows using a fake `pi`, fake
`gh`, and temporary git repositories.

## Evidence

- Current scaffold tests cover shell helpers and invariants.
- There is no default test that simulates issue label -> Pi run -> branch
  -> PR -> review loop.
- AIW full dry-run E2E is gated behind `AGENTIFY_RUN_E2E=1`.

## Scope

Tests and fixtures only unless workflow seams need small testability changes.

## Implementation plan

1. Build a fake `pi` executable that records prompt input and writes
   deterministic final output.
2. Build a fake `gh` executable that stores issues/PRs/comments/labels in
   JSON files.
3. Simulate:
   - issue implementation success,
   - issue implementation failure,
   - PR review approve,
   - PR review request changes,
   - branch update conflict path,
   - refresh-surface creates PR only when files changed.
4. Run selected workflow shell steps locally where possible, or extract
   reusable scripts from YAML for testability.

## Acceptance criteria

- A workflow regression can be caught without hitting GitHub or real Pi.
- Prompt files are rendered and inspected in tests.
- Failure comments and labels are asserted.

## Validation

```bash
npm run typecheck
npm run test:unit
bash tests/run.sh
```
