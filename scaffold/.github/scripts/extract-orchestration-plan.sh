#!/usr/bin/env bash
# Extract a bounded orchestration plan from the credential-free routing agent.
# The plan is guidance for the implement agent; it never grants extra
# privileges or overrides the issue task.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: extract-orchestration-plan.sh <transcript> <output-markdown>" >&2
  exit 2
fi

transcript=$1
output_markdown=$2
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tmp_json=$(mktemp)
trap 'rm -f "$tmp_json"' EXIT

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
