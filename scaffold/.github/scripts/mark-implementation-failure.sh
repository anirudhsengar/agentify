#!/usr/bin/env bash
# Mark an issue implementation run as blocked after a workflow failure. If the
# draft PR already exists, the PR is blocked and the source issue points the
# user there; otherwise the source issue is blocked directly.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: mark-implementation-failure.sh <issue-number> <created-pr-number-or-empty> <failure-reason-file> <run-url>" >&2
  exit 2
fi

issue_number=$1
created_pr_number=$2
failure_reason_file=$3
run_url=$4

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "issue number must be numeric: $issue_number" >&2
  exit 1
fi

if [ -n "$created_pr_number" ] && ! [[ "$created_pr_number" =~ ^[0-9]+$ ]]; then
  echo "created PR number must be numeric when provided: $created_pr_number" >&2
  exit 1
fi

reason="(no reason file written - check workflow logs)"
if [ -f "$failure_reason_file" ]; then
  reason=$(cat "$failure_reason_file")
fi

comment_file=$(mktemp)
trap 'rm -f "$comment_file"' EXIT

if [ -n "$created_pr_number" ]; then
  cat > "$comment_file" <<EOF
Implementation PR #${created_pr_number} was created, but the handoff failed.

**Reason:** ${reason}

**Workflow run:** ${run_url}

Inspect the PR, then add \`agent:review\` there to continue.
EOF
  GH_TOKEN="$GITHUB_TOKEN" gh issue edit "$issue_number" --remove-label "agent:queued" || true
  GH_TOKEN="$GITHUB_TOKEN" gh pr edit "$created_pr_number" --add-label "agent:blocked" || true
  GH_TOKEN="$GITHUB_TOKEN" gh issue comment "$issue_number" --body-file "$comment_file"
  exit 0
fi

cat > "$comment_file" <<EOF
\`agent:implement\` run failed.

**Reason:** ${reason}

**Workflow run:** ${run_url}

Re-add \`agent:implement\` to retry.
EOF

GH_TOKEN="$GITHUB_TOKEN" gh issue edit "$issue_number" --add-label "agent:blocked" || true
GH_TOKEN="$GITHUB_TOKEN" gh issue comment "$issue_number" --body-file "$comment_file"
