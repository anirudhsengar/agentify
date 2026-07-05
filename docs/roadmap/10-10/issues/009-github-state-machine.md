# 009 — GitHub async state machine

## Goal

Turn the GitHub scaffold into a clear, documented state machine for issues,
comments, PRs, labels, approvals, failure, and retry.

## Evidence

- `docs/lifecycle/README.md` says issue creation alone is not a go signal.
- `agent-drill-me-issue.yml` handles issue opened/comment for
  `agent:drill-me` only.
- Implementation requires labels and preflight checks in
  `agent-implement.yml`.

## Scope

Scaffold workflows, scripts, docs, and tests. Do not add a public CLI
subcommand.

## Implementation plan

1. Document canonical states:
   - intake,
   - drilling,
   - queued,
   - implementing,
   - review,
   - blocked,
   - approved,
   - human merge.
2. Add a machine-readable label/state contract file under scaffold.
3. Make issue-created behavior explicit:
   - either default to safe triage,
   - or document and test that only `agent:drill-me` starts intake.
4. Add comment command routing for trusted actors, at minimum:
   - retry,
   - stop/block,
   - implement,
   - review,
   - update branch.
5. Ensure every failure path comments with next action and workflow URL.

## Acceptance criteria

- Users can understand exactly what creating an issue does.
- Every label transition is documented and tested.
- Comment-triggered actions are actor-authorized and idempotent.
- No workflow silently does nothing without a visible status comment when
  the user expected action.

## Validation

```bash
bash scaffold/tests/run.sh
npm run test:unit
```
