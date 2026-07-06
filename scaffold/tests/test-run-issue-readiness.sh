#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
runner="$repo_root/.github/scripts/run-issue-readiness.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "api" ] && [[ "${2:-}" == *"/collaborators/"* ]]; then
  printf '%s\n' "write"
  exit 0
fi

if [ "${1:-} ${2:-} ${3:-} ${4:-}" = "issue view 42 --json" ]; then
  printf '%s\n' "$ISSUE_JSON"
  exit 0
fi

if [ "${1:-} ${2:-} ${4:-} ${5:-}" = "issue view --json state" ]; then
  blocker=$3
  case "$blocker" in
    7) printf '%s\n' "${BLOCKER_7_STATE:-CLOSED}" ;;
    8) printf '%s\n' "${BLOCKER_8_STATE:-CLOSED}" ;;
    *) echo "unexpected blocker: $blocker" >&2; exit 1 ;;
  esac
  exit 0
fi

case "${1:-} ${2:-}" in
  "issue edit"|"issue comment")
    printf '%s\n' "$*" >> "$GH_CAPTURE"
    ;;
  *)
    printf 'unexpected gh invocation: %q ' "$@" >&2
    printf '\n' >&2
    exit 1
    ;;
esac
SH
chmod +x "$tmp/bin/gh"

export PATH="$tmp/bin:$PATH"
export GH_REPO=owner/repo
export GH_TOKEN=gh-test
export GH_CAPTURE="$tmp/gh-capture.txt"
output="$tmp/output.txt"

export ISSUE_JSON='{"body":"## Blocked by\n\n- #7\n- #8\n\n## Acceptance criteria\n\n- done","labels":[{"name":"agent:queued"}]}'
export BLOCKER_7_STATE=CLOSED
export BLOCKER_8_STATE=OPEN
bash "$runner" 42 maintainer "$output"

grep -q '^proceed=false$' "$output"
grep -q 'issue edit 42 --remove-label agent:implement' "$GH_CAPTURE"
grep -q 'issue comment 42 --body Refused to run `agent:implement`: Issue #42 is blocked by open issue(s): #8.' "$GH_CAPTURE"

: > "$GH_CAPTURE"
: > "$output"
export ISSUE_JSON='{"body":"## Blocked by\n\nNone - can start immediately","labels":[{"name":"agent:queued"}]}'
export BLOCKER_8_STATE=CLOSED
bash "$runner" 42 maintainer "$output"

grep -q '^proceed=true$' "$output"
if [ -s "$GH_CAPTURE" ]; then
  echo "ready issue should not mutate GitHub during readiness" >&2
  exit 1
fi

echo "issue readiness workflow preflight passed."
