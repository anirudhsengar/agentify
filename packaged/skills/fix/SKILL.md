---
name: fix
description: Given a review blocker or a failing test, write a minimal patch and implement it — fix only the blocker, no refactors or scope creep. Use to close out review findings.
disable-model-invocation: true
tier: core

---

# Fix

Close one blocker with the **minimal** patch that fixes it. A patch is not a feature:
fix only the named blocker, widen nothing.

## Workflow

1. Find the current branch and `git diff <base>`. Find the spec (`specs/<type>-<slug>.md`,
   derived from the branch name or the most recent spec touched) and the review result
   (`app_review/<branch>/*.json` or the `ReviewResult` the caller passed).
2. Identify the blocker(s) to address. If the caller named one specific finding, address
   only that.
3. For each blocker, write a minimal patch spec to `specs/patch/patch-<branch>-<n>.md`
   (the Spec Format, stripped to Issue Summary, Files to Modify, Steps, Validation).
4. Implement the patch using the codebase's existing patterns (lift from the `/<feature>`
   specialist for the affected area, if one exists).
5. Run the spec's `## Validation Commands`; confirm all pass.
6. Write a patch report to `app_fix_reports/<branch>.md`.

## Rules

- **PATCH = minimal scope.** Fix the blocker only. No refactors, no drive-by
  improvements, no test-weakening.
- Do not widen the diff beyond the issue.
- If the fix would touch > 50 lines or need an architectural change, **STOP** and
  escalate: the patch has grown into a feature — write a new `/spec` instead.
