#!/usr/bin/env bash
# agentify:managed
set -euo pipefail

comment_body=${1:?comment body is required}
number=${2:?issue or PR number is required}
is_pr=${3:?is_pr boolean is required}

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

command=$(printf '%s\n' "$comment_body" | sed -n '1s/^[[:space:]]*\/agent[[:space:]]*//p' | awk '{print $1}')

comment() {
  gh issue comment "$number" --repo "$GITHUB_REPOSITORY" --body "$1"
}

remove_runnable_labels() {
  gh issue edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:implement" || true
  gh issue edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:review" || true
  gh issue edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:update-branch" || true
  gh issue edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:in-progress" || true
}

case "$command" in
  retry)
    if [ "$is_pr" = "true" ]; then
      gh pr edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:blocked" || true
      gh pr edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:in-progress" || true
      gh pr edit "$number" --repo "$GITHUB_REPOSITORY" --add-label "agent:review"
      comment "Queued retry with \`agent:review\`."
    else
      gh issue edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:blocked" || true
      gh issue edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:in-progress" || true
      gh issue edit "$number" --repo "$GITHUB_REPOSITORY" --add-label "agent:implement"
      comment "Queued retry with \`agent:implement\`."
    fi
    ;;
  stop|block)
    remove_runnable_labels
    gh issue edit "$number" --repo "$GITHUB_REPOSITORY" --add-label "agent:blocked"
    comment "Stopped agent automation and marked this item \`agent:blocked\`. Re-run with \`/agent retry\` or \`/agent implement\`."
    ;;
  implement)
    gh issue edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:blocked" || true
    gh issue edit "$number" --repo "$GITHUB_REPOSITORY" --add-label "agent:implement"
    comment "Queued implementation with \`agent:implement\`."
    ;;
  review)
    if [ "$is_pr" != "true" ]; then
      comment "\`/agent review\` only works on PR comments. Use \`/agent implement\` on issues."
      exit 0
    fi
    gh pr edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:blocked" || true
    gh pr edit "$number" --repo "$GITHUB_REPOSITORY" --add-label "agent:review"
    comment "Queued automated review with \`agent:review\`."
    ;;
  update-branch)
    if [ "$is_pr" != "true" ]; then
      comment "\`/agent update-branch\` only works on PR comments."
      exit 0
    fi
    gh pr edit "$number" --repo "$GITHUB_REPOSITORY" --remove-label "agent:blocked" || true
    gh pr edit "$number" --repo "$GITHUB_REPOSITORY" --add-label "agent:update-branch"
    comment "Queued branch update with \`agent:update-branch\`."
    ;;
  *)
    comment "Unknown agent command. Supported: \`/agent retry\`, \`/agent stop\`, \`/agent implement\`, \`/agent review\`, \`/agent update-branch\`."
    ;;
esac
