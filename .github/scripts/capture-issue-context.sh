#!/usr/bin/env bash
# agentify:managed
set -euo pipefail

issue_number=${1:?usage: capture-issue-context.sh ISSUE_NUMBER OUTPUT_DIRECTORY}
output_directory=${2:?usage: capture-issue-context.sh ISSUE_NUMBER OUTPUT_DIRECTORY}

mkdir -p "$output_directory/related"
gh issue view "$issue_number" \
  --json author,body,comments,labels,number,state,title,url \
  > "$output_directory/issue.json"

body=$(jq -r '.body // ""' "$output_directory/issue.json")
while IFS= read -r related_number; do
  [ -n "$related_number" ] || continue
  [ "$related_number" != "$issue_number" ] || continue
  gh issue view "$related_number" \
    --json author,body,comments,labels,number,state,title,url \
    > "$output_directory/related/${related_number}.json"
done < <(grep -oE '#[0-9]+' <<<"$body" | tr -d '#' | sort -u || true)
