#!/usr/bin/env bash
# agentify:managed
# Render a validated drill-me issue reply from the final structured Pi output.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

transcript=${1:?transcript path is required}
comment_file=${2:?comment output path is required}
event_marker=${3:?event marker is required}
issue_summary_file=${4:-}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

bash "$script_dir/extract-output.sh" "$transcript" > "$tmp"

jq -e '
  def bounded_string($max): type == "string" and length > 0 and length <= $max;
  def issue_request:
    type == "object"
    and (.slug | bounded_string(80) and test("^[a-z0-9][a-z0-9-]{0,79}$"))
    and (.title | bounded_string(120))
    and (.body | bounded_string(12000));
  def optional_issue_array($max):
    . == null or (type == "array" and length <= $max and all(.[]; issue_request));
  type == "object"
  and (.reply | type == "string" and length > 0 and length <= 6000)
  and (.state | type == "string" and test("^(interviewing|ready_to_split|ready_for_prd|planning|awaiting_issue_approval|blocked|complete)$"))
  and (.filesChanged | type == "boolean")
  and (.childIssues | optional_issue_array(10))
  and (.prdIssues | optional_issue_array(10))
  and (.implementationIssues | optional_issue_array(20))
' "$tmp" >/dev/null

jq -r '.reply' "$tmp" > "$comment_file"
if [ -n "$issue_summary_file" ] && [ -s "$issue_summary_file" ]; then
  printf '\n\n' >> "$comment_file"
  cat "$issue_summary_file" >> "$comment_file"
fi
printf '\n\n<!-- %s agentify-state:%s -->\n' "$event_marker" "$(jq -r '.state' "$tmp")" >> "$comment_file"
