#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
handoff="$repo_root/.github/scripts/complete-implementation-handoff.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

calls="$tmp/calls.log"
comment_body="$tmp/comment.md"
bin_dir="$tmp/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/gh" <<'EOF'
#!/usr/bin/env bash
printf 'token=%s gh %s\n' "${GH_TOKEN:-}" "$*" >> "$CALLS_LOG"
if [ "$1 $2" = "pr edit" ] && [ "${GH_TOKEN:-}" != "agent-token" ]; then
  echo "expected AGENT_PAT token for PR label" >&2
  exit 1
fi
if [ "$1 $2" = "issue edit" ] && [ "${GH_TOKEN:-}" != "github-token" ]; then
  echo "expected GITHUB_TOKEN token for issue label cleanup" >&2
  exit 1
fi
if [ "$1 $2" = "issue comment" ]; then
  if [ "${GH_TOKEN:-}" != "github-token" ]; then
    echo "expected GITHUB_TOKEN token for issue comment" >&2
    exit 1
  fi
  cat "${@: -1}" > "$COMMENT_CAPTURE"
fi
EOF
chmod +x "$bin_dir/gh"

CALLS_LOG="$calls" \
COMMENT_CAPTURE="$comment_body" \
PATH="$bin_dir:$PATH" \
AGENT_PAT="agent-token" \
GITHUB_TOKEN="github-token" \
  bash "$handoff" \
    42 \
    123 \
    "https://github.com/owner/repo/actions/runs/999"

grep -q 'token=agent-token gh pr edit 123 --add-label agent:review' "$calls" || {
  echo "expected PR to be queued for review with AGENT_PAT" >&2
  exit 1
}
grep -q 'token=github-token gh issue edit 42 --remove-label agent:queued' "$calls" || {
  echo "expected source issue queued label to be removed with GITHUB_TOKEN" >&2
  exit 1
}
grep -q 'token=github-token gh issue comment 42 --body-file' "$calls" || {
  echo "expected source issue handoff comment with GITHUB_TOKEN" >&2
  exit 1
}
grep -q 'Opened draft PR #123' "$comment_body" || {
  echo "expected comment to mention the opened PR" >&2
  exit 1
}
grep -q 'https://github.com/owner/repo/actions/runs/999' "$comment_body" || {
  echo "expected comment to include the workflow URL" >&2
  exit 1
}

if CALLS_LOG="$calls" COMMENT_CAPTURE="$comment_body" PATH="$bin_dir:$PATH" GITHUB_TOKEN="github-token" \
  bash "$handoff" 42 123 "https://github.com/owner/repo/actions/runs/999" >/dev/null 2>&1; then
  echo "expected missing AGENT_PAT to fail" >&2
  exit 1
fi

if CALLS_LOG="$calls" COMMENT_CAPTURE="$comment_body" PATH="$bin_dir:$PATH" AGENT_PAT="agent-token" GITHUB_TOKEN="github-token" \
  bash "$handoff" 42 "not-a-number" "https://github.com/owner/repo/actions/runs/999" >/dev/null 2>&1; then
  echo "expected non-numeric PR number to fail" >&2
  exit 1
fi
