#!/usr/bin/env bash
# Live GitHub smoke for the stamped runtime. This intentionally exercises the
# implement workflow's preflight refusal path, so it validates GitHub events,
# labels, workflow execution, and trusted issue comments without running Pi.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/smoke-evidence.sh"

repo=${GH_REPO:-}
timeout_seconds=${AGENTIFY_SMOKE_TIMEOUT_SECONDS:-180}
poll_seconds=${AGENTIFY_SMOKE_POLL_SECONDS:-5}
body_file=""
evidence_file=""
keep_issue=0

usage() {
  cat >&2 <<'EOF'
usage: smoke-github-runtime.sh [--repo owner/name] [--timeout seconds] [--poll seconds] [--body-file path] [--evidence-file path] [--keep-issue]

Creates a temporary issue, labels it agent:implement without agent:queued, and
waits for the trusted implement preflight to refuse the run. No Pi model run is
started when the smoke passes.
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

gh workflow view agent-implement.yml "${repo_args[@]}" >/dev/null

label_names=$(gh label list "${repo_args[@]}" --json name --jq '.[].name')
if ! grep -Fxq "agent:implement" <<<"$label_names"; then
  echo "Missing agent:implement label. Run bash .github/scripts/setup-agentify.sh first." >&2
  exit 1
fi

cleanup_body=0
if [ -z "$body_file" ]; then
  body_file=$(mktemp)
  cleanup_body=1
fi

if [ "$cleanup_body" -eq 1 ]; then
  trap 'rm -f "$body_file"' EXIT
fi

cat > "$body_file" <<'EOF'
agentify-live-smoke

This issue intentionally lacks `agent:queued`. Adding `agent:implement` should
trigger the implement workflow's trusted preflight refusal before any Pi model
run starts.
EOF

title="agentify live smoke: implement preflight refusal"
smoke_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
issue_url=$(gh issue create "${repo_args[@]}" --title "$title" --body-file "$body_file")
issue_number=${issue_url##*/}

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "Could not parse issue number from gh issue create output: $issue_url" >&2
  exit 1
fi

echo "Created smoke issue #${issue_number} in ${repo}."
gh issue edit "$issue_number" "${repo_args[@]}" --add-label agent:implement
echo "Waiting for implement preflight refusal..."

deadline=$((SECONDS + timeout_seconds))
while [ "$SECONDS" -le "$deadline" ]; do
  has_refusal=$(
    gh issue view "$issue_number" "${repo_args[@]}" --json comments \
      --jq 'any(.comments[]?; ((.body // "") | contains("Refused to run `agent:implement`")) and ((.body // "") | contains("not labeled agent:queued")))'
  )
  still_has_trigger=$(
    gh issue view "$issue_number" "${repo_args[@]}" --json labels \
      --jq 'any(.labels[]?; .name == "agent:implement")'
  )

  if [ "$has_refusal" = "true" ] && [ "$still_has_trigger" != "true" ]; then
    workflow_url=$(latest_smoke_workflow_url "$repo" "agent-implement.yml" "issues" "$smoke_started_at")
    if [ -z "$workflow_url" ]; then
      echo "Could not find the Agent Implement workflow run URL for smoke evidence." >&2
      exit 1
    fi
    if [ "$keep_issue" -eq 0 ]; then
      gh issue close "$issue_number" "${repo_args[@]}" --comment "agentify live smoke completed."
    fi
    write_smoke_evidence \
      "$evidence_file" \
      "implement_preflight" \
      "$repo" \
      "passed" \
      "$issue_url" \
      "" \
      "$workflow_url" \
      "Trusted implement preflight refused an unqueued issue before Pi started."
    echo "agentify GitHub runtime smoke passed on issue #${issue_number}."
    exit 0
  fi

  sleep "$poll_seconds"
done

cat >&2 <<EOF
Timed out waiting for implement preflight refusal on issue #${issue_number}.
Inspect the issue and the Agent Implement workflow logs in ${repo}.
EOF
exit 1
