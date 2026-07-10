#!/usr/bin/env bash
# Verify that PR feedback/review runs prove they used generated routing
# context for specialists/experts that match the PR diff.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: verify-diff-routing-evidence.sh <transcript> <base-ref> <specialist-context.md> <expert-context.md> <failure-reason-file>" >&2
  exit 2
fi

transcript=$1
base_ref=$2
specialist_context=$3
expert_context=$4
failure_reason=$5

for file in "$transcript" "$specialist_context" "$expert_context"; do
  if [ ! -f "$file" ]; then
    echo "verify-diff-routing-evidence: missing file: $file" >&2
    exit 2
  fi
done

if ! git rev-parse --verify "$base_ref" >/dev/null 2>&1; then
  echo "verify-diff-routing-evidence: base ref not found: $base_ref" >&2
  exit 2
fi

mapfile -t changed_paths < <(git diff --name-only "$base_ref"...HEAD | sed '/^$/d' | sort -u)
if [ "${#changed_paths[@]}" -eq 0 ]; then
  exit 0
fi

context_sections() {
  local context_file=$1
  awk '
    /^### `[^`]+`$/ {
      if (name != "") {
        print "__END__"
      }
      name = $0
      sub(/^### `/, "", name)
      sub(/`$/, "", name)
      print "__NAME__" name
      next
    }
    name != "" { print }
    END {
      if (name != "") {
        print "__END__"
      }
    }
  ' "$context_file"
}

path_matches_glob() {
  local changed_path=$1
  local glob=$2
  [[ "$changed_path" == $glob ]]
}

path_matches_prefix_or_glob() {
  local changed_path=$1
  local route_path=$2
  if [[ "$route_path" == *"*"* || "$route_path" == *"?"* || "$route_path" == *"["* ]]; then
    [[ "$changed_path" == $route_path ]]
    return
  fi
  [[ "$changed_path" == "$route_path" || "$changed_path" == "$route_path"/* ]]
}

write_failure_reason() {
  mkdir -p "$(dirname "$failure_reason")"
  {
    echo "PR run did not prove generated routing evidence for the changed paths."
    echo
    echo "The diff matched generated specialists or experts, but the transcript did not include the required routing evidence."
    echo
    echo "Required final-output section:"
    echo
    echo "## Routing evidence"
    echo
    echo "Each matching specialist/expert must list the generated file path that was read before implementation or review."
    echo
    echo "Missing evidence:"
    printf '%s\n' "$@"
  } > "$failure_reason"
}

declare -a required_paths=()
declare -a required_labels=()
declare -a missing=()

while IFS= read -r line; do
  case "$line" in
    __NAME__*)
      current_name=${line#__NAME__}
      current_path=""
      current_matches=0
      ;;
    __END__)
      if [ "${current_matches:-0}" -eq 1 ] && [ -n "${current_path:-}" ]; then
        required_paths+=("$current_path")
        required_labels+=("matching specialist \`$current_name\`")
      fi
      current_name=""
      current_path=""
      current_matches=0
      ;;
    "- Path: \`"*)
      current_path=$(printf '%s\n' "$line" | sed -n 's/^- Path: `\([^`][^`]*\)`$/\1/p')
      ;;
    "  - \`"*)
      route_glob=$(printf '%s\n' "$line" | sed -n 's/^  - `\([^`][^`]*\)`$/\1/p')
      if [ -n "$route_glob" ]; then
        for changed_path in "${changed_paths[@]}"; do
          if path_matches_glob "$changed_path" "$route_glob"; then
            current_matches=1
          fi
        done
      fi
      ;;
  esac
done < <(context_sections "$specialist_context")

while IFS= read -r line; do
  case "$line" in
    __NAME__*)
      current_name=${line#__NAME__}
      current_path=""
      current_matches=0
      ;;
    __END__)
      if [ "${current_matches:-0}" -eq 1 ] && [ -n "${current_path:-}" ]; then
        required_paths+=("$current_path")
        required_labels+=("matching expert \`$current_name\`")
      fi
      current_name=""
      current_path=""
      current_matches=0
      ;;
    "- Path: \`"*)
      current_path=$(printf '%s\n' "$line" | sed -n 's/^- Path: `\([^`][^`]*\)`$/\1/p')
      ;;
    "  - \`"*)
      route_path=$(printf '%s\n' "$line" | sed -n 's/^  - `\([^`][^`]*\)`.*$/\1/p')
      if [ -n "$route_path" ]; then
        for changed_path in "${changed_paths[@]}"; do
          if path_matches_prefix_or_glob "$changed_path" "$route_path"; then
            current_matches=1
          fi
        done
      fi
      ;;
  esac
done < <(context_sections "$expert_context")

if [ "${#required_paths[@]}" -eq 0 ]; then
  exit 0
fi

if ! grep -Eq '^#{1,6}[[:space:]]+Routing evidence([[:space:]]|$)' "$transcript"; then
  missing+=("- missing routing evidence section: expected a final output heading named 'Routing evidence'")
fi

for i in "${!required_paths[@]}"; do
  route_path=${required_paths[$i]}
  label=${required_labels[$i]}
  if ! grep -Fq "$route_path" "$transcript"; then
    missing+=("- missing ${label} evidence: transcript must cite \`$route_path\`")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  write_failure_reason "${missing[@]}"
  cat "$failure_reason" >&2
  exit 1
fi
