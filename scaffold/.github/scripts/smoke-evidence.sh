#!/usr/bin/env bash
# Shared JSON evidence writer for live smoke scripts.

json_escape() {
  local value=${1:-}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

resolve_smoke_commit_sha() {
  if [ -n "${AGENTIFY_SMOKE_COMMIT_SHA:-}" ]; then
    printf '%s' "$AGENTIFY_SMOKE_COMMIT_SHA"
    return 0
  fi
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git rev-parse HEAD
    return 0
  fi
  echo "Could not determine smoke evidence commit. Run from a git checkout or set AGENTIFY_SMOKE_COMMIT_SHA." >&2
  return 1
}

latest_smoke_workflow_url() {
  local repo=${1:-}
  local workflow=${2:-}
  local event=${3:-}
  local started_at=${4:-}

  if [ -z "$repo" ] || [ -z "$workflow" ] || [ -z "$event" ]; then
    return 0
  fi

  local jq_filter
  if [ -n "$started_at" ]; then
    jq_filter="map(select(.createdAt >= \"$started_at\")) | .[0].url // \"\""
  else
    jq_filter='.[0].url // ""'
  fi

  gh run list \
    --repo "$repo" \
    --workflow "$workflow" \
    --event "$event" \
    --limit 20 \
    --json url,createdAt \
    --jq "$jq_filter"
}

write_smoke_evidence() {
  local evidence_file=${1:-}
  local gate=${2:-}
  local repo=${3:-}
  local result=${4:-}
  local issue_url=${5:-}
  local pr_url=${6:-}
  local workflow_url=${7:-}
  local details=${8:-}

  if [ -z "$evidence_file" ]; then
    return 0
  fi

  local evidence_dir
  evidence_dir=$(dirname "$evidence_file")
  mkdir -p "$evidence_dir"

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local commit_sha
  commit_sha=$(resolve_smoke_commit_sha)

  local tmp_file="${evidence_file}.tmp"
  {
    printf '{\n'
    printf '  "schema": "agentify.smoke-evidence.v1",\n'
    printf '  "gate": "%s",\n' "$(json_escape "$gate")"
    printf '  "repo": "%s",\n' "$(json_escape "$repo")"
    printf '  "result": "%s",\n' "$(json_escape "$result")"
    printf '  "commit_sha": "%s",\n' "$(json_escape "$commit_sha")"
    printf '  "completed_at": "%s",\n' "$(json_escape "$completed_at")"
    printf '  "issue_url": "%s",\n' "$(json_escape "$issue_url")"
    printf '  "pr_url": "%s",\n' "$(json_escape "$pr_url")"
    printf '  "workflow_url": "%s",\n' "$(json_escape "$workflow_url")"
    printf '  "details": "%s"\n' "$(json_escape "$details")"
    printf '}\n'
  } > "$tmp_file"
  mv "$tmp_file" "$evidence_file"
}
