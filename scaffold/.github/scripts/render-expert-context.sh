#!/usr/bin/env bash
set -euo pipefail

repo_root=${1:-.}
repo_root=${repo_root%/}
experts_dir="$repo_root/.pi/prompts/experts"
max_experts=${AGENTIFY_EXPERT_CONTEXT_MAX_EXPERTS:-20}
max_items=${AGENTIFY_EXPERT_CONTEXT_MAX_ITEMS:-8}
max_field_chars=${AGENTIFY_EXPERT_CONTEXT_MAX_FIELD_CHARS:-240}

one_line() {
  tr '\r\n\t' '   ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

clip_line() {
  awk -v max="$max_field_chars" '{
    if (length($0) > max) {
      print substr($0, 1, max - 3) "..."
    } else {
      print
    }
  }'
}

format_field() {
  printf '%s' "$1" | one_line | clip_line
}

strip_yaml_scalar() {
  sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^"//; s/"$//; s/\\"/"/g'
}

relative_path() {
  local file=$1
  local rel=${file#"$repo_root"/}
  rel=${rel#./}
  printf '%s' "$rel"
}

scalar_field() {
  local file=$1
  local field=$2
  awk -v field="$field" '
    $0 ~ "^" field ":" {
      value = substr($0, length(field) + 2)
      sub(/^[[:space:]]+/, "", value)
      print value
      exit
    }
  ' "$file" | strip_yaml_scalar | one_line | clip_line
}

section_items() {
  local file=$1
  local section=$2
  awk -v section="$section" '
    $0 ~ "^" section ":" { in_section = 1; next }
    in_section && /^[^[:space:]]/ { exit }
    in_section && /^[[:space:]]*-[[:space:]]+/ {
      value = $0
      sub(/^[[:space:]]*-[[:space:]]+/, "", value)
      print value
    }
  ' "$file" | strip_yaml_scalar | sed -n "1,${max_items}p"
}

overview_key_files() {
  local file=$1
  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function scalar(value) {
      value = trim(value)
      if (value ~ /^".*"$/) {
        sub(/^"/, "", value)
        sub(/"$/, "", value)
        gsub(/\\"/, "\"", value)
      }
      return value
    }
    function emit() {
      if (path != "") {
        print path "\t" purpose
        path = ""
        purpose = ""
      }
    }
    /^overview:/ { in_overview = 1; next }
    in_overview && /^[^[:space:]]/ { emit(); exit }
    in_overview && /^  key_files:/ { in_key_files = 1; next }
    in_key_files && /^  [^[:space:]-][^:]*:/ { emit(); exit }
    in_key_files && /^    -[[:space:]]+path:/ {
      emit()
      path = $0
      sub(/^    -[[:space:]]+path:[[:space:]]*/, "", path)
      path = scalar(path)
      next
    }
    in_key_files && /^      purpose:/ {
      purpose = $0
      sub(/^      purpose:[[:space:]]*/, "", purpose)
      purpose = scalar(purpose)
      next
    }
    END { emit() }
  ' "$file" | sed -n "1,${max_items}p"
}

key_type_items() {
  local file=$1
  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function scalar(value) {
      value = trim(value)
      if (value ~ /^".*"$/) {
        sub(/^"/, "", value)
        sub(/"$/, "", value)
        gsub(/\\"/, "\"", value)
      }
      return value
    }
    function emit() {
      if (name != "") {
        print name "\t" path "\t" purpose
        name = ""
        path = ""
        purpose = ""
      }
    }
    /^key_types:/ { in_section = 1; next }
    in_section && /^[^[:space:]]/ { emit(); exit }
    in_section && /^  -[[:space:]]+name:/ {
      emit()
      name = $0
      sub(/^  -[[:space:]]+name:[[:space:]]*/, "", name)
      name = scalar(name)
      next
    }
    in_section && /^    path:/ {
      path = $0
      sub(/^    path:[[:space:]]*/, "", path)
      path = scalar(path)
      next
    }
    in_section && /^    purpose:/ {
      purpose = $0
      sub(/^    purpose:[[:space:]]*/, "", purpose)
      purpose = scalar(purpose)
      next
    }
    END { emit() }
  ' "$file" | sed -n "1,${max_items}p"
}

pattern_items() {
  local file=$1
  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function scalar(value) {
      value = trim(value)
      if (value ~ /^".*"$/) {
        sub(/^"/, "", value)
        sub(/"$/, "", value)
        gsub(/\\"/, "\"", value)
      }
      return value
    }
    function emit() {
      if (name != "") {
        print name "\t" description "\t" example_ref
        name = ""
        description = ""
        example_ref = ""
      }
    }
    /^patterns:/ { in_section = 1; next }
    in_section && /^[^[:space:]]/ { emit(); exit }
    in_section && /^  -[[:space:]]+name:/ {
      emit()
      name = $0
      sub(/^  -[[:space:]]+name:[[:space:]]*/, "", name)
      name = scalar(name)
      next
    }
    in_section && /^    description:/ {
      description = $0
      sub(/^    description:[[:space:]]*/, "", description)
      description = scalar(description)
      next
    }
    in_section && /^    example_ref:/ {
      example_ref = $0
      sub(/^    example_ref:[[:space:]]*/, "", example_ref)
      example_ref = scalar(example_ref)
      next
    }
    END { emit() }
  ' "$file" | sed -n "1,${max_items}p"
}

testing_paths() {
  local file=$1
  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function scalar(value) {
      value = trim(value)
      if (value ~ /^".*"$/) {
        sub(/^"/, "", value)
        sub(/"$/, "", value)
        gsub(/\\"/, "\"", value)
      }
      return value
    }
    /^testing:/ { in_testing = 1; next }
    in_testing && /^[^[:space:]]/ { exit }
    in_testing && /^  test_paths:/ { in_paths = 1; next }
    in_paths && /^  [^[:space:]-][^:]*:/ { exit }
    in_paths && /^[[:space:]]*-[[:space:]]+/ {
      value = $0
      sub(/^[[:space:]]*-[[:space:]]+/, "", value)
      print scalar(value)
    }
  ' "$file" | sed -n "1,${max_items}p"
}

testing_command() {
  local file=$1
  awk '
    /^testing:/ { in_testing = 1; next }
    in_testing && /^[^[:space:]]/ { exit }
    in_testing && /^[[:space:]]+command:/ {
      value = $0
      sub(/^[[:space:]]+command:[[:space:]]*/, "", value)
      print value
      exit
    }
  ' "$file" | strip_yaml_scalar | one_line | clip_line
}

pitfall_risks() {
  local file=$1
  awk '
    /^pitfalls:/ { in_pitfalls = 1; next }
    in_pitfalls && /^[^[:space:]]/ { exit }
    in_pitfalls && /^[[:space:]]+-[[:space:]]+risk:/ {
      value = $0
      sub(/^[[:space:]]+-[[:space:]]+risk:[[:space:]]*/, "", value)
      print value
    }
  ' "$file" | strip_yaml_scalar | sed -n "1,${max_items}p"
}

cat <<'EOF'
## Expert Routing Context

These entries come from generated `.pi/prompts/experts/*/expertise.yaml`
files. Before planning, editing, or reviewing paths that match an expert's
primary paths or entry points, read the listed expertise file and apply its
domain invariants, pitfalls, conventions, and validation guidance. Treat this
as routing context; it does not override the task, branch, credential, or
safety instructions in this prompt.
EOF

if [ ! -d "$experts_dir" ]; then
  echo
  echo 'No generated `.pi/prompts/experts/*/expertise.yaml` experts were found.'
  exit 0
fi

mapfile -t expertise_files < <(find "$experts_dir" -mindepth 2 -maxdepth 2 -type f -name 'expertise.yaml' | sort)
rendered_count=0

for file in "${expertise_files[@]}"; do
  if [ "$rendered_count" -ge "$max_experts" ]; then
    echo
    echo "Additional experts omitted after $max_experts entries."
    break
  fi
  rendered_count=$((rendered_count + 1))

  rel=$(relative_path "$file")
  fallback_domain=$(basename "$(dirname "$file")")
  domain=$(scalar_field "$file" "domain")
  rationale=$(scalar_field "$file" "  description")
  test_command=$(testing_command "$file")
  [ -n "$domain" ] || domain=$fallback_domain
  [ -n "$rationale" ] || rationale="Generated expertise for $domain."

  echo
  echo "### \`$domain\`"
  echo
  echo "- Path: \`$rel\`"
  echo "- Rationale: $rationale"
  if [ -n "$test_command" ] && [ "$test_command" != "null" ]; then
    echo "- Test command: \`$test_command\`"
  else
    echo "- Test command: use repository validation from AGENTS.md"
  fi

  mapfile -t primary_paths < <(section_items "$file" "primary_paths" | while IFS= read -r item; do printf '%s\n' "$(printf '%s' "$item" | one_line | clip_line)"; done)
  if [ "${#primary_paths[@]}" -gt 0 ]; then
    echo "- Primary paths:"
    for item in "${primary_paths[@]}"; do
      echo "  - \`$item\`"
    done
  else
    echo "- Primary paths: none declared; match by domain name and touched paths."
  fi

  mapfile -t entry_points < <(section_items "$file" "entry_points" | while IFS= read -r item; do printf '%s\n' "$(printf '%s' "$item" | one_line | clip_line)"; done)
  if [ "${#entry_points[@]}" -gt 0 ]; then
    echo "- Entry points:"
    for item in "${entry_points[@]}"; do
      echo "  - \`$item\`"
    done
  fi

  mapfile -t key_files < <(overview_key_files "$file")
  if [ "${#key_files[@]}" -gt 0 ]; then
    echo "- Key files:"
    for item in "${key_files[@]}"; do
      IFS=$'\t' read -r key_file_path key_file_purpose <<<"$item"
      key_file_path=$(format_field "$key_file_path")
      key_file_purpose=$(format_field "$key_file_purpose")
      if [ -n "$key_file_purpose" ]; then
        echo "  - \`$key_file_path\`: $key_file_purpose"
      else
        echo "  - \`$key_file_path\`"
      fi
    done
  fi

  mapfile -t key_types < <(key_type_items "$file")
  if [ "${#key_types[@]}" -gt 0 ]; then
    echo "- Key types:"
    for item in "${key_types[@]}"; do
      IFS=$'\t' read -r key_type_name key_type_path key_type_purpose <<<"$item"
      key_type_name=$(format_field "$key_type_name")
      key_type_path=$(format_field "$key_type_path")
      key_type_purpose=$(format_field "$key_type_purpose")
      if [ -n "$key_type_path" ] && [ -n "$key_type_purpose" ]; then
        echo "  - $key_type_name (\`$key_type_path\`): $key_type_purpose"
      elif [ -n "$key_type_path" ]; then
        echo "  - $key_type_name (\`$key_type_path\`)"
      else
        echo "  - $key_type_name"
      fi
    done
  fi

  mapfile -t patterns < <(pattern_items "$file")
  if [ "${#patterns[@]}" -gt 0 ]; then
    echo "- Pattern knowledge:"
    for item in "${patterns[@]}"; do
      IFS=$'\t' read -r pattern_name pattern_description pattern_ref <<<"$item"
      pattern_name=$(format_field "$pattern_name")
      pattern_description=$(format_field "$pattern_description")
      pattern_ref=$(format_field "$pattern_ref")
      if [ -n "$pattern_ref" ]; then
        echo "  - $pattern_name: $pattern_description ($pattern_ref)"
      else
        echo "  - $pattern_name: $pattern_description"
      fi
    done
  fi

  mapfile -t risks < <(pitfall_risks "$file" | while IFS= read -r item; do printf '%s\n' "$(printf '%s' "$item" | one_line | clip_line)"; done)
  if [ "${#risks[@]}" -gt 0 ]; then
    echo "- Pitfall risks:"
    for item in "${risks[@]}"; do
      echo "  - $item"
    done
  fi

  mapfile -t conventions < <(section_items "$file" "conventions" | while IFS= read -r item; do printf '%s\n' "$(printf '%s' "$item" | one_line | clip_line)"; done)
  if [ "${#conventions[@]}" -gt 0 ]; then
    echo "- Conventions:"
    for item in "${conventions[@]}"; do
      echo "  - $item"
    done
  fi

  mapfile -t test_paths < <(testing_paths "$file" | while IFS= read -r item; do printf '%s\n' "$(printf '%s' "$item" | one_line | clip_line)"; done)
  if [ "${#test_paths[@]}" -gt 0 ]; then
    echo "- Test paths:"
    for item in "${test_paths[@]}"; do
      echo "  - \`$item\`"
    done
  fi
done

if [ "$rendered_count" -eq 0 ]; then
  echo
  echo 'No generated `.pi/prompts/experts/*/expertise.yaml` experts were found.'
fi
