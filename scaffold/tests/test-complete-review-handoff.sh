#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
handoff="$repo_root/.github/scripts/complete-review-handoff.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

calls="$tmp/calls.log"
bin_dir="$tmp/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf 'token=%s gh %s\n' "${GH_TOKEN:-}" "$*" >> "$CALLS_LOG"

case "$1 $2" in
  "pr comment")
    if [ "${GH_TOKEN:-}" != "github-token" ]; then
      echo "expected GITHUB_TOKEN for review comments" >&2
      exit 1
    fi
    cat "${@: -1}" > "$COMMENT_CAPTURE"
    ;;
  "pr edit")
    if [ "${*: -2}" = "--add-label agent:implement" ]; then
      if [ "${GH_TOKEN:-}" != "agent-token" ]; then
        echo "expected AGENT_PAT for implementation requeue" >&2
        exit 1
      fi
    elif [ "${*: -2}" = "--add-label agent:approved" ]; then
      if [ "${GH_TOKEN:-}" != "github-token" ]; then
        echo "expected GITHUB_TOKEN for approval label" >&2
        exit 1
      fi
    else
      echo "unexpected pr edit call: $*" >&2
      exit 1
    fi
    ;;
  "pr ready")
    if [ "${GH_TOKEN:-}" != "github-token" ]; then
      echo "expected GITHUB_TOKEN for pr ready" >&2
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

summary="$tmp/summary.md"
printf 'Looks good.\n' > "$summary"
comment="$tmp/comment.md"

CALLS_LOG="$calls" \
COMMENT_CAPTURE="$comment" \
PATH="$bin_dir:$PATH" \
GITHUB_TOKEN="github-token" \
AGENT_PAT="agent-token" \
  bash "$handoff" 9 approve "$summary"

grep -q '## Agent review - approved' "$comment"
grep -q 'Looks good.' "$comment"
grep -q 'token=github-token gh pr edit 9 --add-label agent:approved' "$calls"
grep -q 'token=github-token gh pr ready 9' "$calls"
if grep -q 'agent:implement' "$calls"; then
  echo "approved reviews must not requeue implementation" >&2
  exit 1
fi

: > "$calls"
printf 'Please address the blocker.\n' > "$summary"

CALLS_LOG="$calls" \
COMMENT_CAPTURE="$comment" \
PATH="$bin_dir:$PATH" \
GITHUB_TOKEN="github-token" \
AGENT_PAT="agent-token" \
  bash "$handoff" 9 request_changes "$summary"

grep -q '## Agent review - changes requested' "$comment"
grep -q 'Please address the blocker.' "$comment"
grep -q 'token=agent-token gh pr edit 9 --add-label agent:implement' "$calls"
if grep -q 'agent:approved' "$calls"; then
  echo "request_changes reviews must not add approval label" >&2
  exit 1
fi

if CALLS_LOG="$calls" \
  COMMENT_CAPTURE="$comment" \
  PATH="$bin_dir:$PATH" \
  GITHUB_TOKEN="github-token" \
  AGENT_PAT="agent-token" \
  bash "$handoff" 9 maybe "$summary" >/dev/null 2>&1; then
  echo "unsupported verdict should fail" >&2
  exit 1
fi

if CALLS_LOG="$calls" \
  COMMENT_CAPTURE="$comment" \
  PATH="$bin_dir:$PATH" \
  GITHUB_TOKEN="github-token" \
  bash "$handoff" 9 request_changes "$summary" >/dev/null 2>&1; then
  echo "request_changes must require AGENT_PAT" >&2
  exit 1
fi

echo "review handoff passed."
