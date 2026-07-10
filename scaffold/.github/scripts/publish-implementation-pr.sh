#!/usr/bin/env bash
# Publish an implementation branch and open its draft PR. The model has no
# GitHub credentials; this trusted script owns the force-push and PR creation.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: publish-implementation-pr.sh <branch> <base-ref> <title-file> <description-file> <github-output-file>" >&2
  exit 2
fi

branch=$1
base_ref=$2
title_file=$3
description_file=$4
github_output=$5

: "${AGENT_PAT:?AGENT_PAT is required - see SETUP.md}"

if [[ "$branch" != agent/* ]]; then
  echo "refusing to publish non-agent branch: $branch" >&2
  exit 1
fi

if [ ! -s "$title_file" ]; then
  echo "PR title file is missing or empty: $title_file" >&2
  exit 1
fi

if [ ! -s "$description_file" ]; then
  echo "PR description file is missing or empty: $description_file" >&2
  exit 1
fi

pr_title=$(cat "$title_file")

GH_TOKEN="$AGENT_PAT" gh auth setup-git
git push --force origin "$branch"

pr_url=$(GH_TOKEN="$AGENT_PAT" gh pr create \
  --draft --base "$base_ref" --head "$branch" \
  --title "$pr_title" --body-file "$description_file" | tail -n1)
pr_number=$(basename "$pr_url")

if ! [[ "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "could not parse PR number from gh output: $pr_url" >&2
  exit 1
fi

echo "pr_number=$pr_number" >> "$github_output"
