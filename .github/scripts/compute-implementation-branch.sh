#!/usr/bin/env bash
# agentify:managed
# Compute the deterministic branch name for issue implementation runs. Keeping
# this in trusted shell makes title normalization testable and prevents
# malformed issue titles from writing unsafe GITHUB_OUTPUT records.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: compute-implementation-branch.sh <issue-number> <issue-title> <run-id> <github-output-file>" >&2
  exit 2
fi

issue_number=$1
issue_title=$2
run_id=$3
github_output=$4

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "issue number must be numeric: $issue_number" >&2
  exit 1
fi
if ! [[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "run ID is unsafe: $run_id" >&2
  exit 1
fi

slug=$(
  printf '%s' "$issue_title" |
    LC_ALL=C tr '[:upper:]' '[:lower:]' |
    tr '\r\n' '  ' |
    sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' |
    cut -c1-50
)

if [ -z "$slug" ]; then
  slug="issue"
fi

printf 'name=agent/draft-%s-%s-%s\n' "$issue_number" "$run_id" "$slug" >> "$github_output"
