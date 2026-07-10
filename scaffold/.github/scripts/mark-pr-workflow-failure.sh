#!/usr/bin/env bash
# Mark PR-scoped agent workflow failures through trusted GitHub side effects.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: mark-pr-workflow-failure.sh <pr-number> <agent-label> <failure-reason-file> <run-url>" >&2
  exit 2
fi

pr_number=$1
agent_label=$2
failure_reason_file=$3
run_url=$4

if ! [[ "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "PR number must be numeric: $pr_number" >&2
  exit 1
fi

case "$agent_label" in
  agent:review|agent:update-branch) ;;
  *)
    echo "Unsupported PR workflow label: $agent_label" >&2
    exit 1
    ;;
esac

: "${GH_TOKEN:?GH_TOKEN is required}"

reason="(no reason file written - check workflow logs)"
if [ -f "$failure_reason_file" ]; then
  reason=$(cat "$failure_reason_file")
fi

comment_file=$(mktemp)
trap 'rm -f "$comment_file"' EXIT

cat > "$comment_file" <<EOF
\`${agent_label}\` run failed.

**Reason:** ${reason}

**Workflow run:** ${run_url}

Re-add \`${agent_label}\` to retry.
EOF

gh pr edit "$pr_number" --add-label "agent:blocked" || true
gh pr comment "$pr_number" --body-file "$comment_file"
