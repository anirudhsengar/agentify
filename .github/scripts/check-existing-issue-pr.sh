#!/usr/bin/env bash
# agentify:managed
# Refuse issue implementation when an open PR already closes the same issue.
# This trusted preflight runs before the credential-free implementation agent.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: check-existing-issue-pr.sh <issue-number> <github-output-file>" >&2
  exit 2
fi

issue_number=$1
output_file=$2

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "issue number must be numeric: $issue_number" >&2
  exit 1
fi

if [ -z "$output_file" ]; then
  echo "GITHUB_OUTPUT path is required." >&2
  exit 64
fi

prs_json=$(
  gh pr list \
    --state open \
    --search "in:body \"#${issue_number}\"" \
    --json number,url,body
)

if ! jq -e 'type == "array"' <<<"$prs_json" >/dev/null; then
  echo "gh pr list returned invalid JSON." >&2
  exit 1
fi

matching_url=$(
  jq -r --arg issue "$issue_number" '
    [
      .[]
      | select((.body // "") | test("(?i)(closes|fixes|resolves)[[:space:]]+#" + $issue + "\\b"))
      | .url
      | select(type == "string" and length > 0)
    ][0] // ""
  ' <<<"$prs_json"
)

if [ -n "$matching_url" ]; then
  echo "existing_pr_url=$matching_url" >> "$output_file"
  echo "refused=true" >> "$output_file"
else
  echo "refused=false" >> "$output_file"
fi
