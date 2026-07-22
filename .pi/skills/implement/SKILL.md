---
name: implement
description: Build one work item test-first at its agreed seams, run the validation surface, and report a structured result. Use to execute a build spec, a PRD, or a set of issues.
disable-model-invocation: true
tier: core

---
<!-- agentify:managed -->

# Implement

Execute one unit of work — a build spec (`specs/<class>-<slug>.md`), a PRD, or an issue —
and leave the branch green. This is the **build** primitive the chains compose
([ADR-0009](../../../docs/adr/0009-machinery-shipped-intelligence-generated.md)); it must
stay runnable on its own.

## Load context first

1. If given a `<spec-path>`, read it. A build spec **MUST** have `## Steps` and
   `## Validation Commands`; if either is missing, STOP and report the missing section.
   If given a PRD/issue instead, treat its acceptance criteria as the steps.
2. Read `AGENTS.md` for project conventions, pitfalls, and the validation surface.
3. Read `CONTEXT.md` (if present) so names and interfaces match the project's domain
   language; respect ADRs in the area you're touching.
4. Read ``<agentify-state-dir>/conditional_docs.md`` (if present) and load any feature docs whose conditions
   match the work. If a `/<feature>` specialist owns the affected area, lift its types,
   conventions, and pitfalls.

## Build test-first

Use `/tdd` at the spec's pre-agreed seams (existing seams preferred, highest seam
possible):

1. **RED** — write one failing test for the next behavior.
2. **GREEN** — minimal code to pass it.
3. **REPEAT** until the work item is done.
4. **REFACTOR** — only while green; deepen modules where natural (`/codebase-design`).

Follow the codebase's conventions; avoid the pitfalls named in `AGENTS.md` and the
specialist. Run typechecking and single test files regularly as you go.

## Validate, report, commit

5. Run the spec's `## Validation Commands` **in order** (or the project's test +
   typecheck commands from `AGENTS.md`). Run the full suite once at the end. Each must
   exit 0. If a command fails: record the failing command and step, **STOP**, do not
   auto-fix — the caller (a human, or `/fix` in a chain) decides.
6. Emit an `ImplementResult` as the last thing in your response (this is what chains and
   CI parse):

   ```
   <output>
   {
     "success": true,
     "spec_path": "specs/<class>-<slug>.md",
     "files_modified": ["..."],
     "validation_results": [{"command": "...", "passed": true}],
     "diff_shortstat": "N files changed, +X -Y",
     "failed_step": null,
     "implementation_summary": "..."
   }
   </output>
   ```

7. Commit to the current branch with a conventional-commit message (`feat:`, `fix:`,
   `refactor:`, `test:`, `docs:`). In CI, **do not** push or open a PR — the workflow
   does that. Locally, leave the commit for the user to push.

After a successful local run, `/review` against the base is the natural next step.
