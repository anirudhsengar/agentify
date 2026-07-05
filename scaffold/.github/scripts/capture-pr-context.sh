#!/usr/bin/env bash
set -euo pipefail

pr_number=${1:?usage: capture-pr-context.sh PR_NUMBER GH_REPO OUTPUT_DIRECTORY}
gh_repo=${2:?usage: capture-pr-context.sh PR_NUMBER GH_REPO OUTPUT_DIRECTORY}
output_directory=${3:?usage: capture-pr-context.sh PR_NUMBER GH_REPO OUTPUT_DIRECTORY}

mkdir -p "$output_directory/issues"

gh pr view "$pr_number" \
  --json author,baseRefName,body,closingIssuesReferences,comments,files,headRefName,labels,number,state,title,url \
  > "$output_directory/pr.json"
gh api "repos/${gh_repo}/pulls/${pr_number}/reviews?per_page=100" \
  > "$output_directory/reviews.json"
gh api "repos/${gh_repo}/pulls/${pr_number}/comments?per_page=100" \
  > "$output_directory/inline-comments.json"

while IFS= read -r issue_number; do
  [ -n "$issue_number" ] || continue
  gh issue view "$issue_number" \
    --json author,body,comments,labels,number,state,title,url \
    > "$output_directory/issues/${issue_number}.json"
done < <(jq -r '.closingIssuesReferences[]?.number' "$output_directory/pr.json")
