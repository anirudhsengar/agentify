#!/usr/bin/env bash
# Complete the issue-to-PR handoff after the implementation draft PR exists.
# The review label must be applied with AGENT_PAT so the review workflow is
# triggered; source issue cleanup is best-effort visibility work.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: complete-implementation-handoff.sh <issue-number> <pr-number> <run-url>" >&2
  exit 2
fi

issue_number=$1
pr_number=$2
run_url=$3

: "${AGENT_PAT:?AGENT_PAT is required - see SETUP.md}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "issue number must be numeric: $issue_number" >&2
  exit 1
fi

if ! [[ "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "PR number must be numeric: $pr_number" >&2
  exit 1
fi

comment_file=$(mktemp)
trap 'rm -f "$comment_file"' EXIT

cat > "$comment_file" <<EOF
Opened draft PR #${pr_number} and queued it for automated review (\`agent:review\`).

**Workflow run:** ${run_url}
EOF

GH_TOKEN="$AGENT_PAT" gh pr edit "$pr_number" --add-label "agent:review" --add-label "agentify:draft"
GH_TOKEN="$GITHUB_TOKEN" gh issue edit "$issue_number" --remove-label "agent:queued" || true
GH_TOKEN="$GITHUB_TOKEN" gh issue comment "$issue_number" --body-file "$comment_file" || true
