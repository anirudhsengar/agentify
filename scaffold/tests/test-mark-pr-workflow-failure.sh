#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
marker="$repo_root/.github/scripts/mark-pr-workflow-failure.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

calls="$tmp/calls.log"
comment="$tmp/comment.md"
bin_dir="$tmp/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${GH_TOKEN:-}" != "github-token" ]; then
  echo "expected GITHUB_TOKEN for PR failure handoff" >&2
  exit 1
fi

printf 'gh %s\n' "$*" >> "$CALLS_LOG"
case "$1 $2" in
  "pr comment")
    cat "${@: -1}" > "$COMMENT_CAPTURE"
    ;;
  "pr edit")
    if [ "$*" != "pr edit 9 --add-label agent:blocked" ]; then
      echo "unexpected pr edit call: $*" >&2
      exit 1
    fi
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$bin_dir/gh"

reason="$tmp/failure_reason.txt"
printf 'Branch advanced during review run.\n' > "$reason"

CALLS_LOG="$calls" \
COMMENT_CAPTURE="$comment" \
PATH="$bin_dir:$PATH" \
GH_TOKEN="github-token" \
  bash "$marker" 9 "agent:review" "$reason" "https://github.com/owner/repo/actions/runs/123"

grep -q 'gh pr edit 9 --add-label agent:blocked' "$calls"
grep -q '`agent:review` run failed.' "$comment"
grep -q 'Branch advanced during review run.' "$comment"
grep -q 'https://github.com/owner/repo/actions/runs/123' "$comment"
grep -q 'Re-add `agent:review` to retry.' "$comment"

: > "$calls"
rm -f "$reason"

CALLS_LOG="$calls" \
COMMENT_CAPTURE="$comment" \
PATH="$bin_dir:$PATH" \
GH_TOKEN="github-token" \
  bash "$marker" 9 "agent:update-branch" "$reason" "https://github.com/owner/repo/actions/runs/456"

grep -q '`agent:update-branch` run failed.' "$comment"
grep -q '(no reason file written - check workflow logs)' "$comment"
grep -q 'Re-add `agent:update-branch` to retry.' "$comment"

if CALLS_LOG="$calls" \
  COMMENT_CAPTURE="$comment" \
  PATH="$bin_dir:$PATH" \
  GH_TOKEN="github-token" \
  bash "$marker" 9 "agent:deploy" "$reason" "run-url" >/dev/null 2>&1; then
  echo "unsupported agent label should fail" >&2
  exit 1
fi

if CALLS_LOG="$calls" \
  COMMENT_CAPTURE="$comment" \
  PATH="$bin_dir:$PATH" \
  GH_TOKEN="github-token" \
  bash "$marker" not-a-number "agent:review" "$reason" "run-url" >/dev/null 2>&1; then
  echo "non-numeric PR should fail" >&2
  exit 1
fi

echo "PR workflow failure handoff passed."
