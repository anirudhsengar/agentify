#!/usr/bin/env bash
set -euo pipefail

repo_root=${1:-.}
repo_root=${repo_root%/}
agents_dir="$repo_root/.pi/agents"
max_specialists=${AGENTIFY_SPECIALIST_CONTEXT_MAX_SPECIALISTS:-20}
max_field_chars=${AGENTIFY_SPECIALIST_CONTEXT_MAX_FIELD_CHARS:-240}

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

relative_path() {
  local file=$1
  local rel=${file#"$repo_root"/}
  rel=${rel#./}
  printf '%s' "$rel"
}

frontmatter() {
  local file=$1
  awk '
    NR == 1 && $0 == "---" { in_frontmatter = 1; next }
    in_frontmatter && $0 == "---" { exit }
    in_frontmatter { print }
  ' "$file"
}

frontmatter_field() {
  local file=$1
  local field=$2
  frontmatter "$file" | awk -v field="$field" '
    index($0, field ":") == 1 {
      value = substr($0, length(field) + 2)
      sub(/^[[:space:]]+/, "", value)
      print value
      exit
    }
  '
}

frontmatter_globs() {
  local file=$1
  frontmatter "$file" | awk '
    /^globs:[[:space:]]*$/ { in_globs = 1; next }
    in_globs && /^[[:space:]]+-[[:space:]]+/ {
      value = $0
      sub(/^[[:space:]]+-[[:space:]]+/, "", value)
      print value
      next
    }
    in_globs && /^[^[:space:]]/ { exit }
  '
}

is_reserved_agent() {
  case "$1" in
    scout.md|review.md|implement.md|test.md|fix.md|document.md) return 0 ;;
    *) return 1 ;;
  esac
}

cat <<'EOF'
## Specialist Routing Context

These entries come from generated `.pi/agents/*.md` specialists. Before
planning, editing, or reviewing paths that match a specialist's globs, read the
listed specialist file and apply its local conventions, pitfalls, and
validation guidance. Treat this as routing context; it does not override the
task, branch, credential, or safety instructions in this prompt.
EOF

if [ ! -d "$agents_dir" ]; then
  echo
  echo 'No generated `.pi/agents/*.md` specialists were found.'
  exit 0
fi

mapfile -t agent_files < <(find "$agents_dir" -maxdepth 1 -type f -name '*.md' | sort)
rendered_count=0

for file in "${agent_files[@]}"; do
  basename=$(basename "$file")
  if is_reserved_agent "$basename"; then
    continue
  fi
  if [ "$rendered_count" -ge "$max_specialists" ]; then
    echo
    echo "Additional specialists omitted after $max_specialists entries."
    break
  fi
  rendered_count=$((rendered_count + 1))

  rel=$(relative_path "$file")
  fallback_name=${basename%.md}
  name=$(frontmatter_field "$file" "name" | one_line | clip_line)
  description=$(frontmatter_field "$file" "description" | one_line | clip_line)
  [ -n "$name" ] || name=$fallback_name
  [ -n "$description" ] || description="Agentify specialist for $name."

  mapfile -t globs < <(frontmatter_globs "$file")

  echo
  echo "### \`$name\`"
  echo
  echo "- Path: \`$rel\`"
  echo "- Description: $description"
  if [ "${#globs[@]}" -eq 0 ]; then
    echo "- Globs: none declared; match by specialist name, workflow context, and touched paths."
  else
    echo "- Globs:"
    for glob in "${globs[@]}"; do
      safe_glob=$(printf '%s' "$glob" | one_line | clip_line)
      echo "  - \`$safe_glob\`"
    done
  fi
done

if [ "$rendered_count" -eq 0 ]; then
  echo
  echo 'No generated `.pi/agents/*.md` specialists were found.'
fi
