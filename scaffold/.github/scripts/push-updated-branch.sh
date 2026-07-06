#!/usr/bin/env bash
set -euo pipefail

branch=${1:-}
branch_head_sha=${2:-}
failure_reason_file=${3:-}

if [ -z "$branch" ] || [ -z "$branch_head_sha" ] || [ -z "$failure_reason_file" ]; then
  echo "Usage: push-updated-branch.sh <agent-branch> <expected-head-sha> <failure-reason-file>" >&2
  exit 2
fi

case "$branch" in
  agent/*) ;;
  *)
    echo "Refusing to push non-agent branch: $branch" >&2
    exit 1
    ;;
esac

: "${AGENT_PAT:?AGENT_PAT is required -- see SETUP.md}"

GH_TOKEN="$AGENT_PAT" gh auth setup-git

push_err=$(mktemp)
trap 'rm -f "$push_err"' EXIT

set +e
git push --force-with-lease="refs/heads/$branch:$branch_head_sha" origin "$branch" 2> "$push_err"
status=$?
set -e

if [ "$status" -ne 0 ]; then
  if grep -qiE "non-fast-forward|rejected|fetch first|stale info" "$push_err"; then
    echo "Branch advanced during update-branch run." > "$failure_reason_file"
    cat "$push_err"
    exit 1
  fi
  cat "$push_err"
  exit "$status"
fi
