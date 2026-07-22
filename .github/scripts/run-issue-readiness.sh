#!/usr/bin/env bash
# agentify:managed
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

issue_number=${1:?usage: run-issue-readiness.sh ISSUE_NUMBER ACTOR OUTPUT_FILE}
actor=${2:-}
output_file=${3:-${GITHUB_OUTPUT:-}}

if [ -z "$output_file" ]; then
  echo "GITHUB_OUTPUT path is required." >&2
  exit 64
fi

set +e
reason=$(bash "$script_dir/check-issue-ready.sh" "$issue_number" "$actor" 2>&1)
status=$?
set -e

if [ "$status" -ne 0 ]; then
  gh issue edit "$issue_number" --remove-label "agent:implement" || true
  gh issue comment "$issue_number" --body "Refused to run \`agent:implement\`: $reason"
  echo "proceed=false" >> "$output_file"
  exit 0
fi

echo "proceed=true" >> "$output_file"
