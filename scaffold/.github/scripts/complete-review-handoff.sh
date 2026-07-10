#!/usr/bin/env bash
# Apply trusted PR review side effects after the credential-free review agent
# emits a structured verdict.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: complete-review-handoff.sh <pr-number> <verdict> <summary-file>" >&2
  exit 2
fi

pr_number=$1
verdict=$2
summary_file=$3

if ! [[ "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "PR number must be numeric: $pr_number" >&2
  exit 1
fi

if [ ! -s "$summary_file" ]; then
  echo "summary file is missing or empty: $summary_file" >&2
  exit 1
fi

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

comment_file=$(mktemp)
trap 'rm -f "$comment_file"' EXIT

case "$verdict" in
  approve)
    {
      echo "## Agent review - approved"
      echo
      cat "$summary_file"
    } > "$comment_file"
    GH_TOKEN="$GITHUB_TOKEN" gh pr comment "$pr_number" --body-file "$comment_file"
    GH_TOKEN="$GITHUB_TOKEN" gh pr edit "$pr_number" --add-label "agent:approved"
    GH_TOKEN="$GITHUB_TOKEN" gh pr ready "$pr_number" || true
    ;;
  request_changes)
    : "${AGENT_PAT:?AGENT_PAT is required - see SETUP.md}"
    {
      echo "## Agent review - changes requested"
      echo
      cat "$summary_file"
    } > "$comment_file"
    GH_TOKEN="$GITHUB_TOKEN" gh pr comment "$pr_number" --body-file "$comment_file"
    GH_TOKEN="$AGENT_PAT" gh pr edit "$pr_number" --add-label "agent:implement"
    ;;
  *)
    echo "Unsupported review verdict: $verdict" >&2
    exit 1
    ;;
esac
