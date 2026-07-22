#!/usr/bin/env bash
# Remove one recorded orphaned Agentify draft branch after explicit confirmation.
set -euo pipefail
if [ "$#" -ne 3 ] || [ "$3" != "--confirm" ]; then echo "usage: cleanup-draft-branch.sh <draft-state-file> <branch> --confirm" >&2; exit 2; fi
state_file=$1; branch=$2; : "${GH_REPO:?GH_REPO is required}"; : "${GH_TOKEN:?GH_TOKEN is required}"
[[ "$branch" =~ ^agent/draft-[0-9]+-[A-Za-z0-9._-]+$ ]] || { echo "refusing to delete non-Agentify branch" >&2; exit 1; }
jq -e --arg branch "$branch" '.remote_branches[] | select(.branch==$branch and .owned==true and .status=="orphaned" and .associated_pr==null)' "$state_file" >/dev/null || { echo "branch is not a recorded owned orphan" >&2; exit 1; }
default_branch=$(GH_TOKEN="$GH_TOKEN" gh repo view "$GH_REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')
[ "$branch" != "$default_branch" ] || { echo "refusing to delete the default branch" >&2; exit 1; }
encoded_branch=${branch//\//%2F}
if GH_TOKEN="$GH_TOKEN" gh api "repos/$GH_REPO/branches/$encoded_branch/protection" >/dev/null 2>&1; then echo "refusing to delete a protected branch" >&2; exit 1; fi
active=$(GH_TOKEN="$GH_TOKEN" gh pr list --repo "$GH_REPO" --state open --head "$branch" --json number --limit 1 --jq 'length')
[ "$active" = 0 ] || { echo "refusing to delete a branch with an active PR" >&2; exit 1; }
git check-ref-format --branch "$branch" >/dev/null; git push origin --delete "$branch"
tmp="${state_file}.$$"; jq --arg branch "$branch" --arg now "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '(.remote_branches[] | select(.branch==$branch)) |= (.status="deleted" | .deleted_at=$now)' "$state_file" > "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$state_file"
