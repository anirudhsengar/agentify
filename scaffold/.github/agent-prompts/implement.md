# TASK

Implement issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

You are on branch `${BRANCH}`, already created from the default branch.
Read the issue and every related issue snapshot under `${ISSUE_CONTEXT_DIR}`.
If its body references a plan file in the repository, read that too.
GitHub credentials are intentionally unavailable during the agent run; do
not attempt remote mutations.

# EXECUTION

Follow the `/implement` skill. It carries the discipline this run needs:
load context (`AGENTS.md`, `CONTEXT.md`, ADRs, the `/<feature>` specialist and
conditional docs for the area), build test-first (red-green-refactor) at the
issue's seams, run the validation surface, and commit. Treat the issue's
acceptance criteria as the spec; if its body references a plan or spec file,
read that too.

This is the same skill a developer runs locally — CI just supplies the issue
context and handles the git plumbing.

# COMMIT

Make one or more git commits on `${BRANCH}` with conventional-commit messages,
exactly as `/implement` directs.

Do NOT push. Do NOT open a pull request. Do NOT close the issue. The
workflow handles all of that after you're done.
