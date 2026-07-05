# TASK

Address open feedback on PR #${PR_NUMBER} (branch `${BRANCH}`).

# CONTEXT

Read every JSON file under `${PR_CONTEXT_DIR}` for the PR, top-level
comments, review summaries, inline comments, and closing issues. Then run:

```
git diff ${BASE_REF}...${BRANCH}
```

Read every review summary, top-level comment, and inline review comment.
Treat the most recent `agent:review` summary (if any) as the primary task
list — it was written specifically to be actionable.

# EXECUTION

Address each piece of feedback. Use red-green-refactor where applicable.
Run whatever this repo uses for tests and type checking before committing
(check `AGENTS.md`/`CLAUDE.md`/`package.json`/`CONTEXT.md`).

If a piece of feedback is wrong, out of scope, or you disagree with it,
don't silently ignore it — say so in your final reply (the workflow posts
your final message as a PR comment) and explain why.

GitHub credentials are intentionally unavailable during the agent run. Do
not attempt to push or comment directly.

# COMMIT

Make one or more git commits on `${BRANCH}`, conventional-commit style. Do
NOT push — the workflow does that after you're done. If there's truly
nothing actionable, make no commits and say so.
