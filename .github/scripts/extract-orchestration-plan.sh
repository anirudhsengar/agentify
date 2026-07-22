#!/usr/bin/env bash
# agentify:managed
# Extract a bounded orchestration plan from the credential-free routing agent.
# The plan is guidance for the implement agent; it never grants extra
# privileges or overrides the issue task.
set -euo pipefail

if [ "$#" -ne 2 ] && [ "$#" -ne 5 ]; then
  echo "usage: extract-orchestration-plan.sh <transcript> <output-markdown> [workflow-context specialist-context expert-context]" >&2
  exit 2
fi

transcript=$1
output_markdown=$2
workflow_context=${3:-}
specialist_context=${4:-}
expert_context=${5:-}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tmp_json=$(mktemp)
tmp_workflows=$(mktemp)
tmp_specialists=$(mktemp)
tmp_experts=$(mktemp)
tmp_validation_commands=$(mktemp)
trap 'rm -f "$tmp_json" "$tmp_workflows" "$tmp_specialists" "$tmp_experts" "$tmp_validation_commands"' EXIT

bash "$script_dir/extract-output.sh" "$transcript" > "$tmp_json"

if ! jq -e '
  def bounded_string($max): type == "string" and length > 0 and length <= $max;
  def safe_name: bounded_string(80) and test("^[a-z0-9][a-z0-9_-]{0,79}$");
  def safe_command: bounded_string(160) and (contains("\n") | not);
  type == "object" and
  (.summary | bounded_string(600)) and
  (.selectedWorkflows | type == "array" and length <= 5 and all(.[]; safe_name)) and
  (.selectedSpecialists | type == "array" and length <= 5 and all(.[]; safe_name)) and
  (.selectedExperts | type == "array" and length <= 5 and all(.[]; safe_name)) and
  (.validationFocus | type == "array" and length <= 8 and all(.[]; safe_command))
' "$tmp_json" >/dev/null; then
  cat >&2 <<'EOF'
Orchestration plan must be JSON with:
- summary: 1-600 characters
- selectedWorkflows/selectedSpecialists/selectedExperts: arrays of safe names, max 5 each
- validationFocus: single-line command strings, max 8 entries
EOF
  exit 1
fi

context_names() {
  local context_file=$1
  local output_file=$2
  sed -n 's/^### `\([^`][^`]*\)`$/\1/p' "$context_file" | sort -u > "$output_file"
}

context_validation_commands() {
  : > "$tmp_validation_commands"
  for context_file in "$@"; do
    [ -f "$context_file" ] || continue
    sed -n 's/^- Test command: `\([^`][^`]*\)`$/\1/p' "$context_file"
  done | sort -u > "$tmp_validation_commands"
}

validate_known_names() {
  local field=$1
  local label=$2
  local allowed_file=$3
  local selected

  while IFS= read -r selected; do
    [ -n "$selected" ] || continue
    if ! grep -Fxq "$selected" "$allowed_file"; then
      echo "Orchestration plan selected unknown $label: $selected" >&2
      exit 1
    fi
  done < <(jq -r --arg field "$field" '.[$field][]' "$tmp_json")
}

validate_known_validation_focus() {
  local selected
  while IFS= read -r selected; do
    [ -n "$selected" ] || continue
    if ! grep -Fxq "$selected" "$tmp_validation_commands"; then
      echo "Orchestration plan selected unknown validationFocus command: $selected" >&2
      exit 1
    fi
  done < <(jq -r '.validationFocus[]' "$tmp_json")
}

if [ -n "$workflow_context" ]; then
  context_names "$workflow_context" "$tmp_workflows"
  context_names "$specialist_context" "$tmp_specialists"
  context_names "$expert_context" "$tmp_experts"
  context_validation_commands "$workflow_context" "$specialist_context" "$expert_context"
  validate_known_names "selectedWorkflows" "workflow" "$tmp_workflows"
  validate_known_names "selectedSpecialists" "specialist" "$tmp_specialists"
  validate_known_names "selectedExperts" "expert" "$tmp_experts"
  validate_known_validation_focus
fi

{
  echo "## Orchestration Plan"
  echo
  jq -r '.summary' "$tmp_json"
  echo
  echo "### Selected Workflows"
  jq -r 'if .selectedWorkflows == [] then "- none" else .selectedWorkflows[] | "- `" + . + "`" end' "$tmp_json"
  echo
  echo "### Selected Specialists"
  jq -r 'if .selectedSpecialists == [] then "- none" else .selectedSpecialists[] | "- `" + . + "`" end' "$tmp_json"
  echo
  echo "### Selected Experts"
  jq -r 'if .selectedExperts == [] then "- none" else .selectedExperts[] | "- `" + . + "`" end' "$tmp_json"
  echo
  echo "### Validation Focus"
  jq -r 'if .validationFocus == [] then "- Use the repository validation surface from AGENTS.md." else .validationFocus[] | "- `" + . + "`" end' "$tmp_json"
} > "$output_markdown"
