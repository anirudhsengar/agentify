#!/usr/bin/env bash
set -euo pipefail

base_ref=${1:-}

if [ -z "$base_ref" ]; then
  echo "Usage: validate-refresh-surface.sh <base-ref>" >&2
  exit 2
fi

resolve_base() {
  if git rev-parse --verify --quiet "origin/$base_ref" >/dev/null; then
    printf '%s\n' "origin/$base_ref"
    return
  fi
  if git rev-parse --verify --quiet "$base_ref" >/dev/null; then
    printf '%s\n' "$base_ref"
    return
  fi
  echo "Unable to resolve refresh base ref: $base_ref" >&2
  exit 1
}

base=$(resolve_base)

changed_paths() {
  {
    git diff --name-only "$base..HEAD"
    git diff --name-only
    git diff --cached --name-only
    git ls-files --others --exclude-standard
  } | sed '/^$/d' | sort -u
}

is_allowed_refresh_path() {
  local rel=$1
  local state_dir
  state_dir="$(dirname "$(dirname "$0")")/scripts/resolve-state-dir.sh" "$repo_root"
  case "$rel" in
    AGENTS.md|CLAUDE.md|specs/README.md|ai_docs/README.md|"$state_dir/conditional_docs.md"|"$state_dir/manifest.json")
      return 0
      ;;
    "$state_dir"/agents/*.md|"$state_dir"/prompts/experts/*/expertise.yaml|.codex/agents/*.toml|.claude/agents/*.md)
      return 0
      ;;
    app_docs/*|app_review/*|app_fix_reports/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

require_text() {
  local file=$1
  local pattern=$2
  local message=$3
  if ! grep -qE "$pattern" "$file"; then
    echo "$message" >&2
    exit 1
  fi
}

mapfile -t paths < <(changed_paths)

for rel in "${paths[@]}"; do
  if ! is_allowed_refresh_path "$rel"; then
    echo "Refresh changed a non-agentic-surface file: $rel" >&2
    exit 1
  fi
done

if [ -f AGENTS.md ]; then
  line_count=$(awk 'END { print NR }' AGENTS.md)
  if [ "$line_count" -gt 200 ]; then
    echo "AGENTS.md has $line_count lines; refresh output must stay at or below 200." >&2
    exit 1
  fi
fi

for rel in "${paths[@]}"; do
  [ -f "$rel" ] || continue
  case "$rel" in
    AGENTS.md|CLAUDE.md|specs/README.md|ai_docs/README.md|.pi/conditional_docs.md|.pi/agents/*.md|.claude/agents/*.md|app_docs/*.md|app_review/*.md|app_fix_reports/*.md)
      require_text "$rel" 'agentify:managed' "Refresh changed managed markdown without an agentify marker: $rel"
      ;;
    .codex/agents/*.toml)
      require_text "$rel" '^# agentify:managed' "Refresh changed managed TOML without an agentify marker: $rel"
      ;;
    .pi/prompts/experts/*/expertise.yaml)
      require_text "$rel" '^# agentify:managed' "Refresh changed expert YAML without an agentify marker: $rel"
      require_text "$rel" '^domain:' "Refresh changed expert YAML missing domain: $rel"
      require_text "$rel" '^last_updated:' "Refresh changed expert YAML missing last_updated: $rel"
      require_text "$rel" '^primary_paths:' "Refresh changed expert YAML missing primary_paths: $rel"
      require_text "$rel" '^testing:' "Refresh changed expert YAML missing testing: $rel"
      ;;
    .pi/agentify/manifest.json)
      jq -e 'type == "object" and .schema_version == "1" and (.files | type == "array")' "$rel" >/dev/null
      ;;
  esac
done

echo "Refresh surface validation passed."
