#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
handler="$repo_root/.github/scripts/mark-implementation-failure.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

calls="$tmp/calls.log"
comments="$tmp/comments.log"
bin_dir="$tmp/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/gh" <<'EOF'
#!/usr/bin/env bash
if [ "${GH_TOKEN:-}" != "github-token" ]; then
  echo "expected GITHUB_TOKEN for failure handoff" >&2
  exit 1
fi
printf 'gh %s\n' "$*" >> "$CALLS_LOG"
if [ "$1 $2" = "issue comment" ]; then
  cat "${@: -1}" >> "$COMMENT_CAPTURE"
  printf '\n---\n' >> "$COMMENT_CAPTURE"
fi
EOF
chmod +x "$bin_dir/gh"

reason="$tmp/failure-reason.txt"
printf '%s\n' 'Validation failed.' > "$reason"

CALLS_LOG="$calls" \
COMMENT_CAPTURE="$comments" \
PATH="$bin_dir:$PATH" \
GITHUB_TOKEN="github-token" \
  bash "$handler" \
    42 \
    123 \
    "$reason" \
    "https://github.com/owner/repo/actions/runs/999"

grep -q 'gh issue edit 42 --remove-label agent:queued' "$calls" || {
  echo "expected source issue queued label to be removed when PR exists" >&2
  exit 1
}
grep -q 'gh pr edit 123 --add-label agent:blocked' "$calls" || {
  echo "expected created PR to be marked blocked" >&2
  exit 1
}
grep -q 'Implementation PR #123 was created, but the handoff failed.' "$comments" || {
  echo "expected created-PR failure comment" >&2
  exit 1
}
grep -q 'Validation failed.' "$comments" || {
  echo "expected failure reason in created-PR comment" >&2
  exit 1
}

: > "$calls"
: > "$comments"
missing_reason="$tmp/missing-reason.txt"
CALLS_LOG="$calls" \
COMMENT_CAPTURE="$comments" \
PATH="$bin_dir:$PATH" \
GITHUB_TOKEN="github-token" \
  bash "$handler" \
    77 \
    "" \
    "$missing_reason" \
    "https://github.com/owner/repo/actions/runs/1000"

grep -q 'gh issue edit 77 --add-label agent:blocked' "$calls" || {
  echo "expected source issue to be marked blocked when no PR exists" >&2
  exit 1
}
grep -q '`agent:implement` run failed.' "$comments" || {
  echo "expected issue failure comment" >&2
  exit 1
}
grep -q 'no reason file written' "$comments" || {
  echo "expected default failure reason when reason file is missing" >&2
  exit 1
}

if CALLS_LOG="$calls" COMMENT_CAPTURE="$comments" PATH="$bin_dir:$PATH" GITHUB_TOKEN="github-token" \
  bash "$handler" 77 not-a-number "$reason" "https://github.com/owner/repo/actions/runs/1000" >/dev/null 2>&1; then
  echo "expected non-numeric PR number to fail" >&2
  exit 1
fi
