---
name: plan-build-review
description: The 3-step chain — spec, implement, then review. Adds spec-compliance verification before declaring done; stops on review failure without auto-fixing. Use when you want a verified result you'll review yourself.
disable-model-invocation: true
---

# Plan-build-review

`/spec` → `/implement` → `/review`. Adds verification before "done". It stops on review
failure rather than auto-fixing — auto-fix is `/plan-build-review-fix`'s job. Keeping them
separate is deliberate: it keeps each primitive runnable and makes clear which phase failed.

## Workflow

1. Run the `/plan-build` chain (`/spec` then `/implement`).
2. If `/plan-build` failed, **STOP** — do not review.
3. Run `/review <spec-path>` (or the branch). The reviewer reads the spec + diff (+
   screenshots if any) and returns a verdict.
4. If the review passes (no `blocker`): done. Report spec path, implement result, review.
5. If the review found `blocker` issues: report them and **STOP**. Do **not** auto-run
   `/fix` here — escalate to the user or use `/plan-build-review-fix`.
