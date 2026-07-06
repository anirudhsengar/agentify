#!/usr/bin/env bash
# Create or reuse drill-requested issues from the final structured Pi output.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

transcript=${1:?transcript path is required}
parent_issue=${2:?parent issue number is required}
summary_file=${3:?summary output path is required}

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"

output_json=$(mktemp)
requests_jsonl=$(mktemp)
trap 'rm -f "$output_json" "$requests_jsonl"' EXIT

bash "$script_dir/extract-output.sh" "$transcript" > "$output_json"

jq -e '
  def bounded_string($max): type == "string" and length > 0 and length <= $max;
  def issue_request:
    type == "object"
    and (.slug | bounded_string(80) and test("^[a-z0-9][a-z0-9-]{0,79}$"))
    and (.title | bounded_string(120))
    and (.body | bounded_string(12000));
  def implementation_issue_request:
    issue_request
    and (.body | test("(?m)^##[[:space:]]+What to build[[:space:]]*$"))
    and (.body | test("(?m)^##[[:space:]]+Acceptance criteria[[:space:]]*$"))
    and (.body | test("(?m)^##[[:space:]]+Blocked by[[:space:]]*$"));
  def optional_issue_array($max):
    . == null or (type == "array" and length <= $max and all(.[]; issue_request));
  def optional_implementation_issue_array($max):
    . == null or (type == "array" and length <= $max and all(.[]; implementation_issue_request));
  (.childIssues | optional_issue_array(10))
  and (.prdIssues | optional_issue_array(10))
  and (.implementationIssues | optional_implementation_issue_array(20))
' "$output_json" >/dev/null

jq -c '
  ((.childIssues // [])[] | { kind: "subgoal", label: "agent:drill-me", slug, title, body }),
  ((.prdIssues // [])[] | { kind: "prd", label: "artifact:prd", slug, title, body }),
  ((.implementationIssues // [])[] | { kind: "slice", label: "agent:queued", slug, title, body })
' "$output_json" > "$requests_jsonl"

: > "$summary_file"
[ -s "$requests_jsonl" ] || exit 0

printf '### Created Or Reused Issues\n' >> "$summary_file"

while IFS= read -r request; do
  [ -n "$request" ] || continue
  kind=$(jq -r '.kind' <<<"$request")
  label=$(jq -r '.label' <<<"$request")
  slug=$(jq -r '.slug' <<<"$request")
  title=$(jq -r '.title' <<<"$request")
  body=$(jq -r '.body' <<<"$request")
  marker="<!-- agentify-source:issue-${parent_issue}-${kind}-${slug} -->"

  existing=$(mktemp)
  body_file=$(mktemp)
  gh issue list \
    --repo "$GH_REPO" \
    --state all \
    --search "$marker in:body" \
    --json number,url,title \
    > "$existing"

  number=$(jq -r '.[0].number // empty' "$existing")
  url=$(jq -r '.[0].url // empty' "$existing")
  existing_title=$(jq -r '.[0].title // empty' "$existing")

  if [ -z "$number" ]; then
    {
      printf '%s\n\n' "$body"
      printf '%s\n' "$marker"
    } > "$body_file"
    url=$(gh issue create \
      --repo "$GH_REPO" \
      --title "$title" \
      --body-file "$body_file" \
      --label "$label")
    number=$(sed -E 's#.*/issues/([0-9]+).*#\1#' <<<"$url")
    if [ "$number" = "$url" ]; then
      number="?"
    fi
  elif [ -n "$existing_title" ]; then
    title=$existing_title
  fi

  printf -- '- #%s %s (`%s`)\n' "$number" "$title" "$label" >> "$summary_file"
  rm -f "$existing" "$body_file"
done < "$requests_jsonl"
