#!/usr/bin/env bash
# agentify:managed
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
    and ((.activate == null) or (.activate | type == "boolean"))
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
  ((.implementationIssues // [])[] | { kind: "slice", label: "agent:queued", activate: (.activate // false), slug, title, body })
' "$output_json" > "$requests_jsonl"

: > "$summary_file"
[ -s "$requests_jsonl" ] || exit 0

printf '### Created Or Reused Issues\n' >> "$summary_file"

blocked_section() {
  awk '
    /^##[[:space:]]+Blocked by[[:space:]]*$/ { in_section = 1; next }
    in_section && /^##[[:space:]]+/ { exit }
    in_section { print }
  ' <<<"$1"
}

open_blockers_for_body() {
  local body=$1
  local blocked_by blocker blocker_number state
  blocked_by=$(blocked_section "$body")
  mapfile -t blockers < <(grep -oE '#[0-9]+' <<<"$blocked_by" | sort -u || true)
  for blocker in "${blockers[@]}"; do
    blocker_number=${blocker#\#}
    state=$(gh issue view "$blocker_number" --repo "$GH_REPO" --json state --jq '.state')
    if [ "$state" != "CLOSED" ]; then
      printf '%s\n' "$blocker"
    fi
  done
}

while IFS= read -r request; do
  [ -n "$request" ] || continue
  kind=$(jq -r '.kind' <<<"$request")
  label=$(jq -r '.label' <<<"$request")
  activate=$(jq -r '.activate // false' <<<"$request")
  slug=$(jq -r '.slug' <<<"$request")
  title=$(jq -r '.title' <<<"$request")
  body=$(jq -r '.body' <<<"$request")
  marker="<!-- agentify-source:issue-${parent_issue}-${kind}-${slug} -->"

  existing=$(mktemp)
  body_file=$(mktemp)
  activation_body=$body
  existing_state=""
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
    if [ "$kind" = "slice" ] && [ "$activate" = "true" ]; then
      existing_issue_json=$(gh issue view "$number" --repo "$GH_REPO" --json body,state)
      activation_body=$(jq -r '.body // ""' <<<"$existing_issue_json")
      existing_state=$(jq -r '.state // ""' <<<"$existing_issue_json")
    fi
  fi

  label_summary="\`$label\`"
  if [ "$kind" = "slice" ] && [ "$activate" = "true" ]; then
    mapfile -t open_blockers < <(open_blockers_for_body "$activation_body")
    if [ -n "$existing_state" ] && [ "$existing_state" != "OPEN" ]; then
      label_summary="\`agent:queued\`; activation skipped: issue is $existing_state"
    elif [ "${#open_blockers[@]}" -gt 0 ]; then
      label_summary="\`agent:queued\`; activation skipped: blocked by ${open_blockers[*]}"
    elif [ "$number" != "?" ]; then
      gh issue edit "$number" \
        --repo "$GH_REPO" \
        --add-label "agent:queued" \
        --add-label "agent:implement"
      label_summary="\`agent:queued\`, \`agent:implement\`"
    else
      label_summary="\`agent:queued\`; activation skipped: issue number unavailable"
    fi
  fi

  printf -- '- #%s %s (%s)\n' "$number" "$title" "$label_summary" >> "$summary_file"
  rm -f "$existing" "$body_file"
done < "$requests_jsonl"
