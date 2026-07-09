#!/usr/bin/env bash
# Model-backed live GitHub smoke for the PR review workflow. This starts Pi
# through GitHub Actions, so it requires explicit confirmation.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/smoke-evidence.sh"

repo=${GH_REPO:-}
pr_number=""
timeout_seconds=${AGENTIFY_REVIEW_SMOKE_TIMEOUT_SECONDS:-1800}
poll_seconds=${AGENTIFY_REVIEW_SMOKE_POLL_SECONDS:-15}
evidence_file=""
confirm_model_run=0

usage() {
  cat >&2 <<'EOF'
usage: smoke-review-github-runtime.sh --confirm-model-run --pr number [--repo owner/name] [--timeout seconds] [--poll seconds] [--evidence-file path]

Applies agent:review to an existing agent-owned PR and waits for the review
workflow to approve it or requeue implementation. This runs Pi and can spend
provider tokens. Run smoke-model-github-runtime.sh first to create a smoke PR.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      repo=${2:-}
      shift 2
      ;;
    --pr)
      pr_number=${2:-}
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
  echo "Refusing to start a model-backed review smoke without --confirm-model-run." >&2
  exit 2
fi

if ! [[ "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "PR number must be numeric. Pass --pr <number>." >&2
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

gh workflow view agent-review.yml "${repo_args[@]}" >/dev/null

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

gh label list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "agent:review" "label"
gh label list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "agent:approved" "label"
gh label list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "agent:implement" "label"
gh label list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "agent:blocked" "label"
gh secret list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "PI_API_KEY" "Actions secret"
gh secret list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "AGENT_PAT" "Actions secret"
gh variable list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "PI_VERSION" "Actions variable"
gh variable list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "PI_MODEL" "Actions variable"

head_ref=$(gh pr view "$pr_number" "${repo_args[@]}" --json headRefName --jq .headRefName)
case "$head_ref" in
  agent/*) ;;
  *)
    echo "Refusing to review non-agent PR branch: $head_ref" >&2
    exit 1
    ;;
esac

smoke_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh pr edit "$pr_number" "${repo_args[@]}" --remove-label agent:approved || true
gh pr edit "$pr_number" "${repo_args[@]}" --remove-label agent:blocked || true
gh pr edit "$pr_number" "${repo_args[@]}" --add-label agent:review
echo "Waiting for review outcome on PR #${pr_number}..."

deadline=$((SECONDS + timeout_seconds))
while [ "$SECONDS" -le "$deadline" ]; do
  outcome=$(
    gh pr view "$pr_number" "${repo_args[@]}" --json labels \
      --jq 'if any(.labels[]?; .name == "agent:blocked") then "blocked" elif any(.labels[]?; .name == "agent:approved") then "approved" elif any(.labels[]?; .name == "agent:implement") then "requeued" else "pending" end'
  )

  case "$outcome" in
    approved)
      workflow_url=$(latest_smoke_workflow_url "$repo" "agent-review.yml" "pull_request_target" "$smoke_started_at")
      if [ -z "$workflow_url" ]; then
        echo "Could not find the Agent Review workflow run URL for smoke evidence." >&2
        exit 1
      fi
      write_smoke_evidence \
        "$evidence_file" \
        "model_review" \
        "$repo" \
        "passed" \
        "" \
        "https://github.com/${repo}/pull/${pr_number}" \
        "$workflow_url" \
        "Review workflow approved the agent-owned PR."
      echo "agentify review smoke passed: PR #${pr_number} was approved."
      exit 0
      ;;
    requeued)
      workflow_url=$(latest_smoke_workflow_url "$repo" "agent-review.yml" "pull_request_target" "$smoke_started_at")
      if [ -z "$workflow_url" ]; then
        echo "Could not find the Agent Review workflow run URL for smoke evidence." >&2
        exit 1
      fi
      write_smoke_evidence \
        "$evidence_file" \
        "model_review" \
        "$repo" \
        "passed" \
        "" \
        "https://github.com/${repo}/pull/${pr_number}" \
        "$workflow_url" \
        "Review workflow requested changes and requeued implementation."
      echo "agentify review smoke passed: PR #${pr_number} requested changes and requeued implementation."
      exit 0
      ;;
    blocked)
      echo "Review smoke PR #${pr_number} was marked agent:blocked. Inspect Agent Review workflow logs." >&2
      exit 1
      ;;
    pending) ;;
    *)
      echo "Unexpected review smoke outcome: $outcome" >&2
      exit 1
      ;;
  esac

  sleep "$poll_seconds"
done

cat >&2 <<EOF
Timed out waiting for review outcome on PR #${pr_number}.
Inspect the Agent Review workflow logs in ${repo}.
EOF
exit 1
