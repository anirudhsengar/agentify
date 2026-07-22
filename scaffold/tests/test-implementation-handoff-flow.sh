#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

calls="$tmp/calls.log"
comment_body="$tmp/comment.md"
bin_dir="$tmp/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/git" <<'EOF'
#!/usr/bin/env bash
printf 'token=%s git %s\n' "${GH_TOKEN:-}" "$*" >> "$CALLS_LOG"
if [ "$1" = "rev-parse" ]; then echo abc123; fi
if [ "$1" = "ls-remote" ] && [[ "$*" == *"refs/heads/main"* ]]; then echo "base123 refs/heads/main"; fi
EOF
chmod +x "$bin_dir/git"

cat > "$bin_dir/gh" <<'EOF'
#!/usr/bin/env bash
printf 'token=%s gh %s\n' "${GH_TOKEN:-}" "$*" >> "$CALLS_LOG"
if [ "$1 $2" = "auth setup-git" ] && [ "${GH_TOKEN:-}" != "agent-token" ]; then
  echo "expected AGENT_PAT token for gh auth setup-git" >&2
  exit 1
fi
if [ "$1 $2" = "pr create" ]; then
  if [ "${GH_TOKEN:-}" != "agent-token" ]; then
    echo "expected AGENT_PAT token for PR creation" >&2
    exit 1
  fi
  echo "https://github.com/owner/repo/pull/456"
fi
if [ "$1 $2" = "pr edit" ] && [ "${GH_TOKEN:-}" != "agent-token" ]; then
  echo "expected AGENT_PAT token for review label" >&2
  exit 1
fi
if [ "$1 $2" = "issue edit" ] && [ "${GH_TOKEN:-}" != "github-token" ]; then
  echo "expected GITHUB_TOKEN for issue cleanup" >&2
  exit 1
fi
if [ "$1 $2" = "issue comment" ]; then
  if [ "${GH_TOKEN:-}" != "github-token" ]; then
    echo "expected GITHUB_TOKEN for issue comment" >&2
    exit 1
  fi
  cat "${@: -1}" > "$COMMENT_CAPTURE"
fi
EOF
chmod +x "$bin_dir/gh"

transcript="$tmp/write-pr-transcript.txt"
cat > "$transcript" <<'EOF'
The PR metadata is below.
<output>
{"prTitle":"feat: add billing export","prDescription":"## Summary\n\n- Added billing export.\n\nCloses #42"}
</output>
EOF

github_output="$tmp/github-output.txt"
CALLS_LOG="$calls" \
PATH="$bin_dir:$PATH" \
  bash "$repo_root/.github/scripts/compute-implementation-branch.sh" \
    42 \
    "Add Billing Export" \
    "999-1" \
    "$github_output"
branch=$(sed -n 's/^name=//p' "$github_output")

bash "$repo_root/.github/scripts/extract-pr-meta.sh" "$transcript" 42 "$tmp/pr-meta"

CALLS_LOG="$calls" \
PATH="$bin_dir:$PATH" \
AGENT_PAT="agent-token" \
  bash "$repo_root/.github/scripts/publish-implementation-pr.sh" \
    "$branch" \
    "main" \
    "base123" \
    "abc123" \
    "$tmp/pr-meta/pr_title.txt" \
    "$tmp/pr-meta/pr_description.txt" \
    "$github_output"
pr_number=$(sed -n 's/^pr_number=//p' "$github_output" | tail -n1)

CALLS_LOG="$calls" \
COMMENT_CAPTURE="$comment_body" \
PATH="$bin_dir:$PATH" \
AGENT_PAT="agent-token" \
GITHUB_TOKEN="github-token" \
  bash "$repo_root/.github/scripts/complete-implementation-handoff.sh" \
    42 \
    "$pr_number" \
    "https://github.com/owner/repo/actions/runs/999"

[ "$branch" = "agent/draft-42-999-1-add-billing-export" ] || {
  echo "unexpected branch: $branch" >&2
  exit 1
}
[ "$pr_number" = "456" ] || {
  echo "unexpected PR number: $pr_number" >&2
  exit 1
}
grep -q 'token=agent-token gh pr create --draft --base main --head agent/draft-42-999-1-add-billing-export --title Agentify draft #42: feat: add billing export --body-file '"$tmp/pr-meta/pr_description.txt" "$calls" || {
  echo "expected draft PR creation call" >&2
  exit 1
}
grep -q 'token=agent-token gh pr edit 456 --add-label agent:review --add-label agentify:draft' "$calls" || {
  echo "expected review label on created PR" >&2
  exit 1
}
grep -q 'token=github-token gh issue edit 42 --remove-label agent:queued' "$calls" || {
  echo "expected queued label cleanup on source issue" >&2
  exit 1
}
grep -q 'Opened draft PR #456' "$comment_body" || {
  echo "expected handoff comment to mention PR" >&2
  exit 1
}
grep -q 'https://github.com/owner/repo/actions/runs/999' "$comment_body" || {
  echo "expected handoff comment to include workflow URL" >&2
  exit 1
}
