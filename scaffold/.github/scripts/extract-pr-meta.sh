#!/usr/bin/env bash
# Extract and validate the structured PR handoff metadata emitted by the
# credential-free write-pr agent. The trusted workflow owns this validation so
# malformed metadata fails before any branch push or PR creation.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: extract-pr-meta.sh <transcript> <issue-number> <output-dir>" >&2
  exit 2
fi

transcript=$1
issue_number=$2
output_dir=$3

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "issue number must be numeric: $issue_number" >&2
  exit 1
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$output_dir"

meta_file="$output_dir/pr_meta.json"
title_file="$output_dir/pr_title.txt"
description_file="$output_dir/pr_description.txt"

bash "$script_dir/extract-output.sh" "$transcript" > "$meta_file"

if ! jq -e --arg issue "$issue_number" '
  type == "object" and
  (.prTitle | type == "string" and length > 0 and length <= 70 and (contains("\n") | not)) and
  (.prDescription | type == "string" and length > 0) and
  (.prDescription | test("(?i)(closes|fixes|resolves)[[:space:]]+#" + $issue + "\\b"))
' "$meta_file" >/dev/null; then
  cat >&2 <<EOF
PR metadata must be an object with:
- prTitle: a non-empty single line no longer than 70 characters
- prDescription: non-empty text containing "Closes #$issue_number", "Fixes #$issue_number", or "Resolves #$issue_number"
EOF
  exit 1
fi

jq -r '.prTitle' "$meta_file" > "$title_file"
jq -r '.prDescription' "$meta_file" > "$description_file"
