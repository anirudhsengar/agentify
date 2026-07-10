#!/usr/bin/env bash
set -euo pipefail

base_ref=${1:-}
failure_reason_file=${2:-}

if [ -z "$base_ref" ]; then
  echo "Usage: verify-implementation-commits.sh <base-ref> <failure-reason-file>" >&2
  exit 2
fi

if [ -z "$failure_reason_file" ]; then
  echo "Usage: verify-implementation-commits.sh <base-ref> <failure-reason-file>" >&2
  exit 2
fi

commits_ahead=$(git rev-list --count "${base_ref}..HEAD")
if [ "$commits_ahead" -eq 0 ]; then
  echo "Agent finished but no commits were made on the branch." > "$failure_reason_file"
  exit 1
fi

echo "Implementation produced $commits_ahead commit(s)."
