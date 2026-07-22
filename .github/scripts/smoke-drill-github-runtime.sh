#!/usr/bin/env bash
# agentify:managed
# Live GitHub smoke for the post-launch drill workflow. This intentionally
# exercises a trusted no-model preflight path, so it validates GitHub events,
# labels, workflow execution, and trusted issue comments without running Pi.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/smoke-evidence.sh"

repo=${GH_REPO:-}
timeout_seconds=${AGENTIFY_DRILL_SMOKE_TIMEOUT_SECONDS:-180}
poll_seconds=${AGENTIFY_DRILL_SMOKE_POLL_SECONDS:-5}
body_file=""
evidence_file=""
keep_issue=0

usage() {
  cat >&2 <<'EOF'
usage: smoke-drill-github-runtime.sh [--repo owner/name] [--timeout seconds] [--poll seconds] [--body-file path] [--evidence-file path] [--keep-issue]

Creates a temporary drill-me issue with the trusted no-model smoke marker and
waits for agent-drill-me-issue.yml to comment and exit before any Pi model run
starts.
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

gh workflow view agent-drill-me-issue.yml "${repo_args[@]}" >/dev/null
gh label list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "agent:drill-me" "label"
gh secret list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "AGENT_PAT" "Actions secret"
gh variable list "${repo_args[@]}" --json name --jq '.[].name' | require_list_item "AGENT_BOT_LOGIN" "Actions variable"

cleanup_body=0
if [ -z "$body_file" ]; then
  body_file=$(mktemp)
  cleanup_body=1
fi

if [ "$cleanup_body" -eq 1 ]; then
  trap 'rm -f "$body_file"' EXIT
fi

cat > "$body_file" <<'EOF'
agentify-drill-smoke-no-model

This issue intentionally exercises the trusted no-model preflight in
`agent-drill-me-issue.yml`. The workflow should comment, remove
`agent:drill-me`, and stop before checkout or Pi starts.
EOF

title="agentify drill smoke: no-model preflight"
smoke_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
issue_url=$(gh issue create "${repo_args[@]}" --title "$title" --body-file "$body_file")
issue_number=${issue_url##*/}

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "Could not parse issue number from gh issue create output: $issue_url" >&2
  exit 1
fi

echo "Created drill smoke issue #${issue_number} in ${repo}."
gh issue edit "$issue_number" "${repo_args[@]}" --add-label agent:drill-me
echo "Waiting for drill workflow no-model preflight..."

deadline=$((SECONDS + timeout_seconds))
while [ "$SECONDS" -le "$deadline" ]; do
  has_smoke_comment=$(
    gh issue view "$issue_number" "${repo_args[@]}" --json comments \
      --jq 'any(.comments[]?; ((.body // "") | contains("agentify drill smoke preflight passed")) and ((.body // "") | contains("no Pi model run started")))'
  )
  still_has_trigger=$(
    gh issue view "$issue_number" "${repo_args[@]}" --json labels \
      --jq 'any(.labels[]?; .name == "agent:drill-me")'
  )

  if [ "$has_smoke_comment" = "true" ] && [ "$still_has_trigger" != "true" ]; then
    workflow_url=$(latest_smoke_workflow_url "$repo" "agent-drill-me-issue.yml" "issues" "$smoke_started_at")
    if [ -z "$workflow_url" ]; then
      echo "Could not find the Agent Drill-Me Issue workflow run URL for smoke evidence." >&2
      exit 1
    fi
    if [ "$keep_issue" -eq 0 ]; then
      gh issue close "$issue_number" "${repo_args[@]}" --comment "agentify drill smoke completed."
    fi
    write_smoke_evidence \
      "$evidence_file" \
      "drill_preflight" \
      "$repo" \
      "passed" \
      "$issue_url" \
      "" \
      "$workflow_url" \
      "Trusted drill workflow handled the no-model smoke marker before Pi started."
    echo "agentify drill smoke passed on issue #${issue_number}."
    exit 0
  fi

  sleep "$poll_seconds"
done

cat >&2 <<EOF
Timed out waiting for drill no-model preflight on issue #${issue_number}.
Inspect the issue and the Agent Drill-Me Issue workflow logs in ${repo}.
EOF
exit 1
