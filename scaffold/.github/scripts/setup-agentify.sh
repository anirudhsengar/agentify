#!/usr/bin/env bash
set -euo pipefail

repo=${GH_REPO:-}
repo_args=()
repo_view_args=()
if [ -n "$repo" ]; then
  repo_args=(--repo "$repo")
  repo_view_args=("$repo")
fi

command -v gh >/dev/null || {
  echo "gh is required." >&2
  exit 1
}
gh auth status >/dev/null

create_label() {
  local name=$1
  local color=$2
  local description=$3
  gh label create "$name" \
    --force \
    --color "$color" \
    --description "$description" \
    "${repo_args[@]}"
}

create_label "agent:queued" "5319E7" "Through drilling and planning; not yet picked up"
create_label "agent:implement" "FBCA04" "Explicit go signal for an agent to start implementing"
create_label "agent:in-progress" "F9D0C4" "An agent is currently working on this item"
create_label "agent:blocked" "D93F0B" "An agent run failed and needs intervention or retry"
create_label "agent:review" "1D76DB" "Request automated review of an agent-owned PR"
create_label "agent:update-branch" "0E8A16" "Merge the PR base branch into an agent-owned PR branch"
create_label "agent:approved" "0E8A16" "Automated review found no blocking changes; human merge approval remains"
create_label "agent:drill-me" "D4C5F9" "Async drilling intake via agent-drill-me-issue.yml; the agent interviews on issue comments and eventually publishes GOALS / PRDs / queued slices"
create_label "agent:shadow" "6E7781" "Run an analysis-only FDE shadow recommendation when explicitly enabled"
create_label "agentify:draft" "BFDADC" "Human-approved Agentify draft PR; never automatically merged"
create_label "artifact:prd" "C5DEF5" "Planning artifact; not directly executable by an agent"

set_variable_if_present() {
  local name=$1
  local value=${!name:-}
  if [ -n "$value" ]; then
    gh variable set "$name" --body "$value" "${repo_args[@]}"
  fi
}

set_variable_if_present PI_VERSION
set_variable_if_present PI_MODEL
set_variable_if_present PI_PROVIDER
set_variable_if_present PI_THINKING
set_variable_if_present AGENT_BOT_LOGIN

missing=0
secret_names=$(gh secret list "${repo_args[@]}" --json name --jq '.[].name')
variable_names=$(gh variable list "${repo_args[@]}" --json name --jq '.[].name')

for secret in PI_API_KEY AGENT_PAT; do
  if ! grep -Fxq "$secret" <<<"$secret_names"; then
    echo "Missing Actions secret: $secret" >&2
    missing=1
  fi
done

for variable in PI_VERSION PI_MODEL AGENT_BOT_LOGIN; do
  if ! grep -Fxq "$variable" <<<"$variable_names"; then
    echo "Missing Actions variable: $variable" >&2
    missing=1
  fi
done

bash "$(dirname "${BASH_SOURCE[0]}")/validate-repository.sh"

if [ "$missing" -ne 0 ]; then
  echo "agentify setup is incomplete; fix the items above and rerun." >&2
  exit 1
fi

echo "agentify labels, runtime configuration, and repository validation are ready."
