#!/usr/bin/env bash
# agentify:managed
set -euo pipefail

transcript=${1:-}
output_dir=${2:-}
github_output=${3:-}

if [ -z "$transcript" ] || [ -z "$output_dir" ] || [ -z "$github_output" ]; then
  echo "usage: extract-review-verdict.sh <transcript> <output-dir> <github-output>" >&2
  exit 2
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$output_dir"

review_json="$output_dir/review.json"
summary_file="$output_dir/summary.md"
verdict_file="$output_dir/verdict.txt"

bash "$script_dir/extract-output.sh" "$transcript" > "$review_json"

jq -e '
  type == "object" and
  ((.verdict == "approve") or (.verdict == "request_changes")) and
  (.summary | type == "string" and length > 0)
' "$review_json" >/dev/null

jq -r '.verdict' "$review_json" > "$verdict_file"
jq -r '.summary' "$review_json" > "$summary_file"
printf 'value=%s\n' "$(cat "$verdict_file")" >> "$github_output"
