# TASK

The default branch just moved. Keep this repo's agentic surface current by following the
`/refresh-surface` skill: delta re-audit the feature areas the recent changes touched and
re-sync any affected experts.

You are on branch `${BRANCH}`, created from the default branch. GitHub credentials are
intentionally unavailable during the agent run; do not attempt remote mutations — the
workflow opens the PR after you finish.

# CONTEXT

Read `AGENTS.md`, `CONTEXT.md`, and the `.pi/agents/*.md` feature specialists to learn
the current surface. Scope the change with `git log` / `git diff` against the previous
state of the default branch.

# EXECUTION

Follow `/refresh-surface`:

- Map changed files to feature areas; run a **delta** refresh of those areas, or a
  **full** `/agentify` if the change is cross-cutting (module-graph edges, shared state,
  manifest, or added/removed areas).
- Update the affected `.pi/agents/<feature>.md`, the moved sections of `AGENTS.md` (keep
  it ≤200 lines), and `.pi/conditional_docs.md`.
- For each expert domain whose paths changed, run its `self-improve` (`USE_DIFF=true`).
- Be honest: reflect the code as it now is, including deletions. If nothing meaningful
  changed, make no edits and say so.

# COMMIT

Commit any changes on `${BRANCH}` with a conventional-commit message. Do NOT push or open
a PR — the workflow does that, and only if you actually changed files.
