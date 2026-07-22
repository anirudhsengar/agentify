#!/usr/bin/env bash
# agentify:managed
# Verify that a model-backed implementation run proved it used the
# specialist/expert route selected by the trusted orchestration planner.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: verify-routing-evidence.sh <transcript> <orchestration-plan.md> <specialist-context.md> <expert-context.md> <failure-reason-file>" >&2
  exit 2
fi

transcript=$1
plan=$2
specialist_context=$3
expert_context=$4
failure_reason=$5

for file in "$transcript" "$plan" "$specialist_context" "$expert_context"; do
  if [ ! -f "$file" ]; then
    echo "verify-routing-evidence: missing file: $file" >&2
    exit 2
  fi
done

selected_items() {
  local heading=$1
  awk -v heading="$heading" '
    $0 == heading { in_section = 1; next }
    in_section && /^### / { exit }
    in_section { print }
  ' "$plan" | sed -n 's/^- `\([^`][^`]*\)`$/\1/p'
}

context_path_for() {
  local context_file=$1
  local name=$2
  local heading="### \`$name\`"
  awk -v heading="$heading" '
    $0 == heading { in_section = 1; next }
    in_section && /^### / { exit }
    in_section { print }
  ' "$context_file" | sed -n 's/^- Path: `\([^`][^`]*\)`$/\1/p' | head -n 1
}

write_failure_reason() {
  mkdir -p "$(dirname "$failure_reason")"
  {
    echo "Implementation did not prove selected agentic routing evidence."
    echo
    echo "The orchestration planner selected generated specialists or experts, but the implementation transcript did not include the required routing evidence."
    echo
    echo "Required final-output section:"
    echo
    echo "## Routing evidence"
    echo
    echo "Each selected specialist/expert must list the generated file path that was read before implementation."
    echo
    echo "Missing evidence:"
    printf '%s\n' "$@"
  } > "$failure_reason"
}

declare -a selected_specialists=()
declare -a selected_experts=()
declare -a missing=()

mapfile -t selected_specialists < <(selected_items "### Selected Specialists")
mapfile -t selected_experts < <(selected_items "### Selected Experts")

selected_count=$((${#selected_specialists[@]} + ${#selected_experts[@]}))
if [ "$selected_count" -eq 0 ]; then
  exit 0
fi

if ! grep -Eq '^#{1,6}[[:space:]]+Routing evidence([[:space:]]|$)' "$transcript"; then
  missing+=("- missing routing evidence section: expected a final output heading named 'Routing evidence'")
fi

for specialist in "${selected_specialists[@]}"; do
  path=$(context_path_for "$specialist_context" "$specialist")
  if [ -z "$path" ]; then
    missing+=("- missing selected specialist context: \`$specialist\` has no Path entry")
    continue
  fi
  if ! grep -Fq "$path" "$transcript"; then
    missing+=("- missing selected specialist evidence: \`$specialist\` must cite \`$path\`")
  fi
done

for expert in "${selected_experts[@]}"; do
  path=$(context_path_for "$expert_context" "$expert")
  if [ -z "$path" ]; then
    missing+=("- missing selected expert context: \`$expert\` has no Path entry")
    continue
  fi
  if ! grep -Fq "$path" "$transcript"; then
    missing+=("- missing selected expert evidence: \`$expert\` must cite \`$path\`")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  write_failure_reason "${missing[@]}"
  cat "$failure_reason" >&2
  exit 1
fi
