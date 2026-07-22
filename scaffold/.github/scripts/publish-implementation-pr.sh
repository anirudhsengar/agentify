#!/usr/bin/env bash
# Publish an implementation branch and open its draft PR. The model has no
# GitHub credentials; this trusted script owns the non-force push and draft PR creation.
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "usage: publish-implementation-pr.sh <branch> <base-ref> <expected-base-sha> <title-file> <description-file> <github-output-file>" >&2
  exit 2
fi

branch=$1
base_ref=$2
expected_base_sha=$3
title_file=$4
description_file=$5
github_output=$6

: "${AGENT_PAT:?AGENT_PAT is required - see SETUP.md}"

if [[ "$branch" != agent/draft-* ]] || [ "$branch" = "$base_ref" ]; then
  echo "refusing to publish non-agent branch: $branch" >&2
  exit 1
fi
if [[ "$branch" =~ ^agent/draft-([0-9]+)- ]]; then issue_number=${BASH_REMATCH[1]}; else echo "draft branch does not encode an issue number" >&2; exit 1; fi

if [ ! -s "$title_file" ]; then
  echo "PR title file is missing or empty: $title_file" >&2
  exit 1
fi

if [ ! -s "$description_file" ]; then
  echo "PR description file is missing or empty: $description_file" >&2
  exit 1
fi

pr_title="Agentify draft #${issue_number}: $(cat "$title_file")"
if ! grep -Eq "#${issue_number}([^0-9]|$)" "$description_file"; then
  echo "PR description must link issue #${issue_number}" >&2
  exit 1
fi

GH_TOKEN="$AGENT_PAT" gh auth setup-git
remote_base_sha=$(git ls-remote --heads origin "refs/heads/$base_ref" | awk '{print $1}')
if [ -z "$remote_base_sha" ] || [ "$remote_base_sha" != "$expected_base_sha" ]; then
  echo "base branch changed or is unavailable; expected $expected_base_sha, found ${remote_base_sha:-missing}" >&2
  exit 1
fi
local_sha=$(git rev-parse "$branch")
remote_sha=$(git ls-remote --heads origin "refs/heads/$branch" | awk '{print $1}')
if [ -n "$remote_sha" ] && [ "$remote_sha" != "$local_sha" ]; then
  echo "branch collision: remote $branch belongs to another run" >&2
  exit 1
fi
if [ -z "$remote_sha" ]; then
  git push --set-upstream origin "$branch"
fi

pr_url=$(GH_TOKEN="$AGENT_PAT" gh pr create \
  --draft --base "$base_ref" --head "$branch" \
  --title "$pr_title" --body-file "$description_file" | tail -n1)
pr_number=$(basename "$pr_url")

if ! [[ "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "could not parse PR number from gh output: $pr_url" >&2
  exit 1
fi

echo "pr_number=$pr_number" >> "$github_output"
