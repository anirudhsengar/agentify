#!/usr/bin/env bash
# Compute the deterministic branch name for issue implementation runs. Keeping
# this in trusted shell makes title normalization testable and prevents
# malformed issue titles from writing unsafe GITHUB_OUTPUT records.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: compute-implementation-branch.sh <issue-number> <issue-title> <github-output-file>" >&2
  exit 2
fi

issue_number=$1
issue_title=$2
github_output=$3

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "issue number must be numeric: $issue_number" >&2
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

printf 'name=agent/issue-%s-%s\n' "$issue_number" "$slug" >> "$github_output"
