#!/usr/bin/env bash
# agentify:managed
# Idempotently publish an Agentify-owned branch and recover its draft PR.
set -euo pipefail
if [ "$#" -ne 8 ]; then echo "usage: publish-implementation-pr.sh <branch> <base-ref> <expected-base-sha> <expected-head-sha> <title-file> <description-file> <draft-state-file> <github-output-file>" >&2; exit 2; fi
branch=$1; base_ref=$2; expected_base_sha=$3; expected_head_sha=$4; title_file=$5; description_file=$6; state_file=$7; github_output=$8
: "${AGENT_PAT:?AGENT_PAT is required - see SETUP.md}"; : "${GH_REPO:?GH_REPO is required}"
if [[ "$branch" != agent/draft-* ]] || [ "$branch" = "$base_ref" ] || ! [[ "$branch" =~ ^agent/draft-([0-9]+)-[A-Za-z0-9._-]+$ ]]; then echo "refusing to publish unsafe or non-agent branch: $branch" >&2; exit 1; fi
issue_number=${BASH_REMATCH[1]}; [ -s "$title_file" ] && [ -s "$description_file" ] || { echo "PR title/description is missing" >&2; exit 1; }
grep -Eq "#${issue_number}([^0-9]|$)" "$description_file" || { echo "PR description must link issue #${issue_number}" >&2; exit 1; }
engagement=$(jq -er '.publication.engagement_id | select(type=="string" and length>0)' "$state_file")
marker="<!-- agentify:draft engagement=${engagement} issue=${issue_number} branch=${branch} -->"
grep -Fqx "$marker" "$description_file" || printf '\n%s\n' "$marker" >> "$description_file"
update_state() { local filter=$1; shift; local tmp="${state_file}.$$"; jq "$@" "$filter" "$state_file" > "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$state_file"; }
check_deadline() { node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/draft-run-control.mjs" check "$state_file" ignored "$1"; }
record_branch() { local status=$1 associated=$2; update_state '.publication.branch=$branch | .publication.base_branch=$base | .publication.issue_number=$issue | .remote_branches = ([.remote_branches[] | select(.branch != $branch)] + [{branch:$branch,owned:true,associated_pr:$associated,status:$status,recorded_at:$now}])' --arg branch "$branch" --arg base "$base_ref" --argjson issue "$issue_number" --arg status "$status" --argjson associated "$associated" --arg now "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"; }
recover_pr() {
  local json number url draft body head base
  # Search all states: a create response can be lost and the PR can be closed
  # before retry. Looking only at open PRs would permit a duplicate create.
  json=$(GH_TOKEN="$AGENT_PAT" gh pr list --repo "$GH_REPO" --state all --head "$branch" --base "$base_ref" --json number,url,isDraft,body,headRefName,baseRefName --limit 10)
  [ "$(jq 'length' <<<"$json")" -le 1 ] || { update_state '.publication.status="ownership_conflict" | .publication.error="multiple matching pull requests"'; echo "multiple matching PRs create an ownership conflict" >&2; return 2; }
  [ "$(jq 'length' <<<"$json")" -eq 1 ] || return 1
  number=$(jq -r '.[0].number' <<<"$json"); url=$(jq -r '.[0].url' <<<"$json"); draft=$(jq -r '.[0].isDraft' <<<"$json"); body=$(jq -r '.[0].body' <<<"$json"); head=$(jq -r '.[0].headRefName' <<<"$json"); base=$(jq -r '.[0].baseRefName' <<<"$json")
  if [ "$draft" != true ] || [ "$head" != "$branch" ] || [ "$base" != "$base_ref" ] || ! grep -Fq "$marker" <<<"$body"; then update_state '.publication.status="ownership_conflict" | .publication.error="matching branch PR is not owned by this draft run"'; echo "matching PR ownership conflict" >&2; return 2; fi
  update_state '.publication.status="publication_recorded" | .publication.pr_number=$number | .publication.pr_url=$url | .publication.error=null' --argjson number "$number" --arg url "$url"; record_branch active "$number"; printf 'pr_number=%s\npr_url=%s\n' "$number" "$url" >> "$github_output"; return 0
}
check_deadline "publication preflight"; GH_TOKEN="$AGENT_PAT" gh auth setup-git
remote_base_sha=$(git ls-remote --heads origin "refs/heads/$base_ref" | awk '{print $1}'); [ -n "$remote_base_sha" ] && [ "$remote_base_sha" = "$expected_base_sha" ] || { echo "base branch changed or is unavailable" >&2; exit 1; }
local_sha=$(git rev-parse "$branch"); [ "$local_sha" = "$expected_head_sha" ] || { echo "implementation head changed after validation" >&2; exit 1; }
remote_sha=$(git ls-remote --heads origin "refs/heads/$branch" | awk '{print $1}'); [ -z "$remote_sha" ] || [ "$remote_sha" = "$local_sha" ] || { echo "branch collision: remote $branch belongs to another run" >&2; exit 1; }
if [ -z "$remote_sha" ]; then check_deadline "branch push"; git push --set-upstream origin "$branch"; fi
record_branch orphaned null; update_state '.publication.status="branch_pushed"'
if recover_pr; then exit 0; else recovery=$?; [ "$recovery" -eq 1 ] || exit "$recovery"; fi
check_deadline "PR creation"; update_state '.publication.status="creating_pr"'
pr_title="Agentify draft #${issue_number}: $(cat "$title_file")"; create_error=""
if ! GH_TOKEN="$AGENT_PAT" gh pr create --repo "$GH_REPO" --draft --base "$base_ref" --head "$branch" --title "$pr_title" --body-file "$description_file" >/dev/null 2>"${state_file}.create-error"; then create_error=$(head -c 1000 "${state_file}.create-error"); fi
rm -f "${state_file}.create-error"; update_state '.publication.status="pr_created"'
if recover_pr; then exit 0; fi
update_state '.publication.status="failed" | .publication.error=$error' --arg error "${create_error:-PR creation did not return a recoverable owned PR}"; echo "PR creation failed: ${create_error:-no matching PR found after creation}" >&2; exit 1
