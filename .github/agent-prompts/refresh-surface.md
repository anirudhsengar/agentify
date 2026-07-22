<!-- agentify:managed -->
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

Also read `${STALE_EXPERTS_FILE}`. It is produced by the trusted workflow before the
model runs and has this shape:

```json
{
  "checked": 2,
  "stale": [
    {
      "domain": "billing",
      "lastUpdated": "2026-07-01T00:00:00Z",
      "latestChangedPath": "src/billing/main.ts",
      "latestChangedAt": "2026-07-03T00:00:00.000Z",
      "checkedPathCount": 5,
      "reason": "referenced repository file is newer than expertise.yaml last_updated"
    }
  ]
}
```

Any domain in `stale` must be considered affected even if your git diff scoping misses
it.

# EXECUTION

Follow `/refresh-surface`:

- Map changed files to feature areas; run a **delta** refresh of those areas, or a
  **full** `/agentify` if the change is cross-cutting (module-graph edges, shared state,
  manifest, or added/removed areas).
- Update the affected `.pi/agents/<feature>.md`, the moved sections of `AGENTS.md` (keep
  it ≤200 lines), and `.pi/conditional_docs.md`.
- For each expert domain whose paths changed or appears in `${STALE_EXPERTS_FILE}`, run
  its `self-improve` (`USE_DIFF=true`).
- Be honest: reflect the code as it now is, including deletions. If nothing meaningful
  changed, make no edits and say so.

# HANDOFF

Do NOT commit, push, or open a PR. Leave any file edits unstaged in the worktree.
The trusted workflow reviews the diff, creates the conventional commit, pushes
`${BRANCH}`, and opens the refresh PR. If you determine the surface is already
current, make no edits and say so.
