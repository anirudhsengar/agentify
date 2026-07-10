#!/usr/bin/env bash
# Live GitHub smoke for the public /agent retry command. This exercises the
# trusted command-router workflow and the blocked -> implement retry transition
# without intentionally starting a Pi model run.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/smoke-evidence.sh"

repo=${GH_REPO:-}
timeout_seconds=${AGENTIFY_RETRY_SMOKE_TIMEOUT_SECONDS:-180}
poll_seconds=${AGENTIFY_RETRY_SMOKE_POLL_SECONDS:-5}
body_file=""
evidence_file=""
keep_issue=0

usage() {
  cat >&2 <<'EOF'
usage: smoke-retry-github-runtime.sh [--repo owner/name] [--timeout seconds] [--poll seconds] [--body-file path] [--evidence-file path] [--keep-issue]

Creates a temporary blocked issue, comments /agent retry, and waits for the
trusted command router to remove blocked state and queue implementation. The
issue is not labeled agent:queued, so any follow-on implement workflow should
stop at preflight without running Pi.
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
    --keep-issue)
      keep_issue=1
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

gh workflow view agent-command.yml "${repo_args[@]}" >/dev/null
gh label list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "agent:blocked" "label"
gh label list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "agent:implement" "label"
gh label list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "agent:in-progress" "label"
gh secret list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "AGENT_PAT" "Actions secret"

cleanup_body=0
if [ -z "$body_file" ]; then
  body_file=$(mktemp)
  cleanup_body=1
fi

if [ "$cleanup_body" -eq 1 ]; then
  trap 'rm -f "$body_file"' EXIT
fi

cat > "$body_file" <<'EOF'
agentify-retry-smoke

This issue intentionally starts blocked and in-progress. A trusted
`/agent retry` command should remove blocked/in-progress state, add
`agent:implement`, and post a queue confirmation.
EOF

title="agentify retry smoke: blocked issue retry"
smoke_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
issue_url=$(gh issue create "${repo_args[@]}" --title "$title" --body-file "$body_file")
issue_number=${issue_url##*/}

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "Could not parse issue number from gh issue create output: $issue_url" >&2
  exit 1
fi

echo "Created retry smoke issue #${issue_number} in ${repo}."
gh issue edit "$issue_number" "${repo_args[@]}" --add-label agent:blocked
gh issue edit "$issue_number" "${repo_args[@]}" --add-label agent:in-progress
gh issue comment "$issue_number" "${repo_args[@]}" --body "/agent retry"
echo "Waiting for command-router retry confirmation..."

deadline=$((SECONDS + timeout_seconds))
while [ "$SECONDS" -le "$deadline" ]; do
  has_retry_comment=$(
    gh issue view "$issue_number" "${repo_args[@]}" --json comments \
      --jq 'any(.comments[]?; ((.body // "") | contains("Queued retry with `agent:implement`.")))'
  )
  still_blocked_or_running=$(
    gh issue view "$issue_number" "${repo_args[@]}" --json labels \
      --jq 'any(.labels[]?; .name == "agent:blocked" or .name == "agent:in-progress")'
  )

  if [ "$has_retry_comment" = "true" ] && [ "$still_blocked_or_running" != "true" ]; then
    workflow_url=$(latest_smoke_workflow_url "$repo" "agent-command.yml" "issue_comment" "$smoke_started_at")
    if [ -z "$workflow_url" ]; then
      echo "Could not find the Agent Command Router workflow run URL for smoke evidence." >&2
      exit 1
    fi
    if [ "$keep_issue" -eq 0 ]; then
      gh issue close "$issue_number" "${repo_args[@]}" --comment "agentify retry smoke completed."
    fi
    write_smoke_evidence \
      "$evidence_file" \
      "retry_command" \
      "$repo" \
      "passed" \
      "$issue_url" \
      "" \
      "$workflow_url" \
      "Trusted command router accepted /agent retry and queued implementation."
    echo "agentify retry smoke passed on issue #${issue_number}."
    exit 0
  fi

  sleep "$poll_seconds"
done

cat >&2 <<EOF
Timed out waiting for /agent retry routing on issue #${issue_number}.
Inspect the issue and the Agent Command Router workflow logs in ${repo}.
EOF
exit 1
