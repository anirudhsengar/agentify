#!/usr/bin/env bash
# Model-backed live GitHub smoke for the issue -> implementation draft PR path.
# This intentionally starts Pi through GitHub Actions, so it requires explicit
# confirmation before it can spend provider tokens.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/smoke-evidence.sh"

repo=${GH_REPO:-}
timeout_seconds=${AGENTIFY_MODEL_SMOKE_TIMEOUT_SECONDS:-1800}
poll_seconds=${AGENTIFY_MODEL_SMOKE_POLL_SECONDS:-15}
body_file=""
evidence_file=""
confirm_model_run=0

usage() {
  cat >&2 <<'EOF'
usage: smoke-model-github-runtime.sh --confirm-model-run [--repo owner/name] [--timeout seconds] [--poll seconds] [--body-file path] [--evidence-file path]

Creates a queued smoke issue and applies agent:implement, then waits for the
implementation workflow to open a draft PR. This runs Pi and can spend provider
tokens. Run smoke-github-runtime.sh first to verify no-LLM preflight behavior.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      repo=${2:-}
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
    --body-file)
      body_file=${2:-}
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
  echo "Refusing to start a model-backed smoke without --confirm-model-run." >&2
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

gh workflow view agent-implement.yml "${repo_args[@]}" >/dev/null

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

gh label list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "agent:queued" "label"
gh label list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "agent:implement" "label"
gh secret list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "PI_API_KEY" "Actions secret"
gh secret list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "AGENT_PAT" "Actions secret"
gh variable list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "PI_VERSION" "Actions variable"
gh variable list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "PI_MODEL" "Actions variable"

cleanup_body=0
if [ -z "$body_file" ]; then
  body_file=$(mktemp)
  cleanup_body=1
fi

if [ "$cleanup_body" -eq 1 ]; then
  trap 'rm -f "$body_file"' EXIT
fi

cat > "$body_file" <<'EOF'
agentify-model-smoke

## What to build

Create or update `agentify-smoke.md` with one line:

`agentify model smoke`

Do not modify product code.

## Acceptance criteria

- `agentify-smoke.md` exists.
- The file contains `agentify model smoke`.
- The implementation opens a draft PR that closes this issue.

## Blocked by

None - can start immediately.
EOF

title="agentify model smoke: issue to draft PR"
smoke_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
issue_url=$(gh issue create "${repo_args[@]}" --title "$title" --body-file "$body_file")
issue_number=${issue_url##*/}

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "Could not parse issue number from gh issue create output: $issue_url" >&2
  exit 1
fi

echo "Created model-backed smoke issue #${issue_number} in ${repo}."
gh issue edit "$issue_number" "${repo_args[@]}" --add-label agent:queued
gh issue edit "$issue_number" "${repo_args[@]}" --add-label agent:implement
echo "Waiting for implementation draft PR..."

deadline=$((SECONDS + timeout_seconds))
while [ "$SECONDS" -le "$deadline" ]; do
  issue_blocked=$(
    gh issue view "$issue_number" "${repo_args[@]}" --json labels \
      --jq 'any(.labels[]?; .name == "agent:blocked")'
  )
  if [ "$issue_blocked" = "true" ]; then
    echo "Smoke issue #${issue_number} was marked agent:blocked. Inspect the Agent Implement workflow logs." >&2
    exit 1
  fi

  pr_match=$(
    gh pr list "${repo_args[@]}" \
      --state open \
      --search "in:body \"#${issue_number}\"" \
      --json number,url,isDraft,labels \
      --jq '[.[] | select(.isDraft == true) | select(any(.labels[]?; .name == "agent:review" or .name == "agent:approved" or .name == "agent:implement")) | "\(.number) \(.url)"][0] // ""'
  )

  if [ -n "$pr_match" ]; then
    pr_url=${pr_match#* }
    workflow_url=$(latest_smoke_workflow_url "$repo" "agent-implement.yml" "issues" "$smoke_started_at")
    if [ -z "$workflow_url" ]; then
      echo "Could not find the Agent Implement workflow run URL for smoke evidence." >&2
      exit 1
    fi
    write_smoke_evidence \
      "$evidence_file" \
      "model_implementation" \
      "$repo" \
      "passed" \
      "$issue_url" \
      "$pr_url" \
      "$workflow_url" \
      "Model-backed implement workflow opened a draft PR."
    echo "agentify model-backed GitHub smoke reached draft PR: ${pr_match}"
    echo "Inspect and close/merge the smoke PR when finished."
    exit 0
  fi

  sleep "$poll_seconds"
done

cat >&2 <<EOF
Timed out waiting for a draft PR that closes issue #${issue_number}.
Inspect the issue and Agent Implement workflow logs in ${repo}.
EOF
exit 1
