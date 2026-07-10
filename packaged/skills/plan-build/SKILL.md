---
name: plan-build
description: The spec → implement chain at three depths — depth 2 (spec + implement), depth 3 (+ review), depth 4 (+ auto-fix blockers). Pick depth with an argument (`depth:2 | depth:3 | depth:4`); defaults to depth 2. Use when a task is clear enough to plan and build in one go; add depth when you want verification or auto-fix on top.
disable-model-invocation: true
argument-hint: "depth:2 | depth:3 | depth:4  (default 2)"
tier: core
---

# Plan-build

`/spec` → `/implement`, optionally followed by `/review` and `/fix`. The minimum-viable
chain at depth 2; the full unattended chain at depth 4. Composes the primitives — never
hides them — so any phase can also be run by hand (`/spec`, `/implement`, `/review`,
`/fix`).

## Branches

Pick a depth — either by argument or by asking the user once at the start. The depth
controls how far the chain runs before stopping.

| Depth | Chain | Stops when |
|---|---|---|
| **2** | `/spec` → `/implement` | `/implement` returns `success: false` |
| **3** | `/spec` → `/implement` → `/review` | review returns `blocker` (no auto-fix) |
| **4** | `/spec` → `/implement` → `/review` → `/fix` (only on `blocker`) | `/fix` escalates or returns failure |

If `$ARGUMENTS` includes `depth:N`, use that. Otherwise default to **depth 2** and
confirm with the user only if they wrote `/plan-build` with no argument and the task
seems to warrant verification.

## Workflow (depth 2)

1. Read `AGENTS.md`, `specs/README.md`, and `<agentify-state-dir>/conditional_docs.md`
   (if present).
2. Run `/spec $ARGUMENTS`. It writes the build spec to `specs/<class>-<slug>.md` and
   returns the path. Read the spec; verify it has `## Validation Commands` (if missing,
   STOP and report).
3. Run `/implement <spec-path>`. It builds the spec and runs the validation commands.
4. If `/implement` reports `success: false`: **STOP**. Report the failing command and
   message. Do **not** auto-run `/fix` (that's depth 4's job). Do **not** re-run
   `/implement` to retry — the failure is real.
5. On success, report the spec path, the `diff_shortstat`, and the validation results.

## Workflow (depth 3) — adds review

1. Run the depth-2 chain above.
2. If depth 2 failed, **STOP** — do not review a broken build.
3. Run `/review <spec-path>` (or the branch). The reviewer reads the spec + diff (+
   screenshots if any) and returns a verdict.
4. If the review passes (no `blocker`): done. Report spec path, implement result, review.
5. If the review found `blocker` issues: report them and **STOP**. Do **not** auto-run
   `/fix` here — that's depth 4. Escalate to the user.

## Workflow (depth 4) — adds auto-fix

1. Run the depth-3 chain above.
2. If depth 3 passed (`review.success === true`): done.
3. If the review returned `blocker` issues:
   - Run `/fix <branch>` (or the review path). It writes a minimal patch per blocker and
     re-runs validation.
   - If `/fix` passes, report the result. If `/fix` escalates (patch > 50 lines,
     architectural change) or fails, **STOP** and report — the user reviews.
4. If the review found only `skippable` / `tech_debt` (not `blocker`): do **not** run
   `/fix` — those ship as-is. Report and let the user decide.

## Rules (apply to all depths)

- **MUST** read `AGENTS.md` and `specs/README.md` before running `/spec` (depth 2+).
- **MUST** run `/fix` only for `blocker` issues (depth 4 only).
- **MUST NOT** loop forever (depth 4 only): if `/fix` runs more than 3 times, STOP and
  escalate.
- **MUST NOT** widen the scope of any fix.
- **MUST NOT** re-run `/implement` to retry a failure — the failure is real; report it.