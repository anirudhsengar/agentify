#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
checker="$repo_root/.github/scripts/check-issue-ready.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

cat > "$tmp_dir/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# gh api repos/<repo>/collaborators/<actor>/permission --jq .permission
if [ "${1:-}" = "api" ] && [[ "${2:-}" == *"/collaborators/"* ]]; then
  actor=${2##*/collaborators/}
  actor=${actor%%/permission}
  case "$actor" in
    outsider) printf '%s\n' "${OUTSIDER_PERMISSION:-none}" ;;
    *) printf '%s\n' "write" ;;
  esac
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

printf 'unexpected gh invocation: %q ' "$@" >&2
printf '\n' >&2
exit 1
EOF
chmod +x "$tmp_dir/gh"

run_checker() {
  PATH="$tmp_dir:$PATH" bash "$checker" 42
}

run_checker_actor() {
  PATH="$tmp_dir:$PATH" GH_REPO="owner/repo" bash "$checker" 42 "$1"
}

export ISSUE_JSON='{"body":"## Blocked by\n\nNone - can start immediately","labels":[{"name":"agent:queued"}]}'
run_checker >/dev/null

export ISSUE_JSON='{"body":"## Blocked by\n\nNone","labels":[{"name":"artifact:prd"}]}'
if run_checker >/dev/null 2>&1; then
  echo "expected a non-queued issue to be refused" >&2
  exit 1
fi

export ISSUE_JSON='{"body":"## Blocked by\n\n- #7\n- #8\n\n## Acceptance criteria\n\n- done","labels":[{"name":"agent:queued"}]}'
export BLOCKER_7_STATE=CLOSED
export BLOCKER_8_STATE=OPEN
if run_checker >/dev/null 2>&1; then
  echo "expected an issue with an open blocker to be refused" >&2
  exit 1
fi

export BLOCKER_8_STATE=CLOSED
run_checker >/dev/null

# Actor authorization: a collaborator with write access is allowed.
export ISSUE_JSON='{"body":"## Blocked by\n\nNone","labels":[{"name":"agent:queued"}]}'
run_checker_actor "maintainer" >/dev/null

# An outside actor (no write access) is refused before any work runs.
export OUTSIDER_PERMISSION=none
if run_checker_actor "outsider" >/dev/null 2>&1; then
  echo "expected an outside actor to be refused" >&2
  exit 1
fi
