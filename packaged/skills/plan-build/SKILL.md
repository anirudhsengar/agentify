---
name: plan-build
description: The 2-step chain — write a build spec, then implement it. Minimum-viable automation for one slice. Use when a task is clear enough to plan and build in one go.
disable-model-invocation: true
---

# Plan-build

`/spec` → `/implement`. The minimum-viable build chain. It composes the primitives; it
never hides them — you can always run `/spec` and `/implement` by hand.

## Workflow

1. Read `AGENTS.md`, `specs/README.md`, and `.pi/conditional_docs.md` (if present).
2. Run `/spec $ARGUMENTS`. It writes the build spec to `specs/<class>-<slug>.md` and
   returns the path. Read the spec; verify it has `## Validation Commands` (if missing,
   STOP and report).
3. Run `/implement <spec-path>`. It builds the spec and runs the validation commands.
4. If `/implement` reports `success: false`: **STOP**. Report the failing command and
   message. Do **not** auto-run `/fix` (that's `/plan-build-review-fix`). Do **not**
   re-run `/implement` to retry — the failure is real.
5. On success, report the spec path, the `diff_shortstat`, and the validation results.
