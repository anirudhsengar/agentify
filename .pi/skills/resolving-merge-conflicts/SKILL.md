---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
tier: core

---
<!-- agentify:managed -->

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages. Check the PRs and original issues/tickets — live via the GitHub CLI in an interactive session; in an agentify CI agent run, GitHub credentials are unavailable mid-run, so read the pre-fetched JSON snapshots under `${PR_CONTEXT_DIR}` instead.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always resolve; never `--abort`.

4. Discover the project's **automated checks** and run them — typically typecheck, then tests, then format. Fix anything the merge broke.

5. **Finish the merge/rebase.** Stage everything and commit. If rebasing, continue the rebase process until all commits are rebased. In an agentify CI agent run, do not push — end your final message with the `<output>{"comment": "..."}</output>` block the calling prompt requires (see `.github/agent-prompts/update-branch.md`) instead of just reporting done.
