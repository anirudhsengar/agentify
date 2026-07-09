---
name: plan-build-review-fix
description: The 4-step chain — spec, implement, review, then fix any blockers. End-to-end automation for one slice. Use when you want the agent to drive a slice to a clean review unattended.
disable-model-invocation: true
---

# Plan-build-review-fix

`/spec` → `/implement` → `/review` → `/fix` (only on `blocker`). The end-to-end chain.
This mirrors exactly what the CI implement → review → fix loop does — the local form of
the same cycle.

## Workflow

1. Run the `/plan-build-review` chain.
2. If it passed (`review.success === true`): done.
3. If the review returned `blocker` issues:
   - Run `/fix <branch>` (or the review path). It writes a minimal patch per blocker and
     re-runs validation.
   - If the fix passes, report the result. If `/fix` escalates (patch > 50 lines,
     architectural change) or fails, **STOP** and report — the user reviews.
4. If the review found only `skippable` / `tech_debt` (not `blocker`): do **not** run
   `/fix` — those ship as-is. Report and let the user decide.

## Rules

- **MUST** run `/fix` only for `blocker` issues.
- **MUST NOT** loop forever: if `/fix` runs more than 3 times, STOP and escalate.
- **MUST NOT** widen the scope of any fix.
