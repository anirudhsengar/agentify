# TASK

PR #${PR_NUMBER} (branch `${BRANCH}`) has merge conflicts against its base
`${BASE_REF}`. A `git merge origin/${BASE_REF} --no-edit` has already been
attempted and left the working tree in a conflicted state. Resolve every
conflict, finish the merge, and report what you did.

# CONTEXT

Read `CONTEXT.md` and any relevant ADRs under `docs/adr/` before resolving
anything substantive.

Read every JSON file under `${PR_CONTEXT_DIR}` for the PR and its closing
issues, then run:

```
git status
git diff --name-only --diff-filter=U
```

# RESOLUTION POLICY

Always resolve. Do not abort the merge. Do not leave the branch in a
half-finished state.

For each conflicting hunk:

1. **Investigate intent on both sides** before choosing a resolution. Use
   `git log -p --follow -- <path>` on both `origin/${BASE_REF}` and
   `${BRANCH}` to see how each side reached this state. Read the commit
   messages. Closing issue snapshots are under `${PR_CONTEXT_DIR}/issues/`.
2. **Pick the resolution that preserves both intents** wherever possible.
   Where the intents are incompatible, pick the one that best matches the
   PR's stated goal from `${PR_CONTEXT_DIR}/pr.json` and note the trade-off.
3. **Do not invent new behaviour.** Your job is reconciliation, not feature
   work. If a sensible resolution requires writing new logic that wasn't on
   either side, that's a signal to flag uncertainty rather than to be
   creative.

After resolving, run whatever checks this repo uses (typecheck/test — check
`AGENTS.md`/`CLAUDE.md`/`package.json`/`CONTEXT.md`). If something is
broken and you can't fix it, say so clearly in your report rather than
hiding it.

GitHub credentials are intentionally unavailable during the agent run. Do
not push or comment directly; the workflow does that afterward.

# COMMIT

Stage everything and finish the merge with a single commit, conventional
style (e.g. `chore: merge origin/${BASE_REF} into ${BRANCH}`). Do NOT push
— the workflow does that after you're done.

# OUTPUT

Once the merge commit exists, emit a single `<output>` block as the **last
thing** in your response:

<output>
{
  "comment": "Markdown body posted as a PR comment. Describe which conflicts existed, how you resolved each, and flag any uncertainty or remaining problems. Reference commit SHAs or file paths where useful."
}
</output>

This comment is the only safety net for the human author — write it like
you're handing the branch back to them and want them to be able to spot any
bad call you made in 30 seconds.
