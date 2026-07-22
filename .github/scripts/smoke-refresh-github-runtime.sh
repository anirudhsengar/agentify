#!/usr/bin/env bash
# agentify:managed
# Model-backed live GitHub smoke for the self-refresh workflow. This triggers
# Agent Refresh Surface through workflow_dispatch and waits for the workflow
# run to complete. It can start Pi, so it requires explicit confirmation.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/smoke-evidence.sh"

repo=${GH_REPO:-}
ref=""
timeout_seconds=${AGENTIFY_REFRESH_SMOKE_TIMEOUT_SECONDS:-1800}
poll_seconds=${AGENTIFY_REFRESH_SMOKE_POLL_SECONDS:-15}
evidence_file=""
confirm_model_run=0

usage() {
  cat >&2 <<'EOF'
usage: smoke-refresh-github-runtime.sh --confirm-model-run [--repo owner/name] [--ref branch] [--timeout seconds] [--poll seconds] [--evidence-file path]

Dispatches agent-refresh-surface.yml and waits for the latest workflow_dispatch
run on the selected ref to complete successfully. This runs Pi and can spend
provider tokens.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      repo=${2:-}
      shift 2
      ;;
    --ref)
      ref=${2:-}
      shift 2
      ;;
    --timeout)
      timeout_seconds=${2:-}
      shift 2
      ;;
    --poll)
      poll_seconds=${2:-}
      shift 2
      ;;
    --evidence-file)
      evidence_file=${2:-}
      shift 2
      ;;
    --confirm-model-run)
      confirm_model_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [ "$confirm_model_run" -ne 1 ] && [ "${AGENTIFY_CONFIRM_MODEL_SMOKE:-}" != "1" ]; then
  echo "Refusing to start a model-backed refresh smoke without --confirm-model-run." >&2
  exit 2
fi

if ! [[ "$timeout_seconds" =~ ^[0-9]+$ ]] || [ "$timeout_seconds" -le 0 ]; then
  echo "timeout must be a positive integer." >&2
  exit 2
fi

if ! [[ "$poll_seconds" =~ ^[0-9]+$ ]]; then
  echo "poll must be a non-negative integer." >&2
  exit 2
fi

command -v gh >/dev/null || {
  echo "gh is required." >&2
  exit 1
}

gh auth status >/dev/null

repo_view_args=()
if [ -n "$repo" ]; then
  repo_view_args=("$repo")
fi

resolved_repo=$(gh repo view "${repo_view_args[@]}" --json nameWithOwner --jq .nameWithOwner)
if [ -z "$resolved_repo" ]; then
  echo "Could not resolve GitHub repository. Pass --repo owner/name or run from a GitHub checkout." >&2
  exit 1
fi
repo=$resolved_repo
repo_args=(--repo "$repo")

if [ -z "$ref" ]; then
  ref=$(gh repo view "${repo_view_args[@]}" --json defaultBranchRef --jq .defaultBranchRef.name)
fi

if [ -z "$ref" ]; then
  echo "Could not resolve default branch. Pass --ref explicitly." >&2
  exit 1
fi

require_list_item() {
  local item=$1
  local description=$2
  local list
  list=$(cat)
  if ! grep -Fxq "$item" <<<"$list"; then
    echo "Missing ${description}: ${item}" >&2
    exit 1
  fi
}

gh secret list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "PI_API_KEY" "Actions secret"
gh secret list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "AGENT_PAT" "Actions secret"
gh variable list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "PI_VERSION" "Actions variable"
gh variable list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "PI_MODEL" "Actions variable"

gh workflow view agent-refresh-surface.yml "${repo_args[@]}" >/dev/null
smoke_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run agent-refresh-surface.yml "${repo_args[@]}" --ref "$ref"
echo "Waiting for agent-refresh-surface.yml workflow_dispatch on ${ref}..."

deadline=$((SECONDS + timeout_seconds))
while [ "$SECONDS" -le "$deadline" ]; do
  run_status=$(
    gh run list "${repo_args[@]}" \
      --workflow agent-refresh-surface.yml \
      --branch "$ref" \
      --event workflow_dispatch \
      --limit 20 \
      --json status,conclusion,url,createdAt \
      --jq "map(select(.createdAt >= \"$smoke_started_at\")) | [.[0].status // \"\", .[0].conclusion // \"\", .[0].url // \"\"] | @tsv"
  )

  IFS=$'\t' read -r status conclusion url <<<"$run_status"
  if [ "$status" = "completed" ] && [ "$conclusion" = "success" ]; then
    write_smoke_evidence \
      "$evidence_file" \
      "model_refresh" \
      "$repo" \
      "passed" \
      "" \
      "" \
      "$url" \
      "Self-refresh workflow_dispatch completed successfully on ${ref}."
    echo "agentify refresh smoke passed: ${url}"
    exit 0
  fi
  if [ "$status" = "completed" ] && [ -n "$conclusion" ] && [ "$conclusion" != "success" ]; then
    echo "agentify refresh smoke failed with conclusion '${conclusion}': ${url}" >&2
    exit 1
  fi

  sleep "$poll_seconds"
done

cat >&2 <<EOF
Timed out waiting for agent-refresh-surface.yml workflow_dispatch on ${ref}.
Inspect the workflow runs in ${repo}.
EOF
exit 1
