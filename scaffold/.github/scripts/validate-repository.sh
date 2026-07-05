#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
shopt -s nullglob

failures=0

fail() {
  echo "ERROR: $*" >&2
  failures=$((failures + 1))
}

require_text() {
  local file=$1
  local pattern=$2
  local description=$3
  if ! grep -Eq "$pattern" "$file"; then
    fail "$description ($file)"
  fi
}

skill_files=(.agents/skills/*/SKILL.md)
for skill_file in "${skill_files[@]}"; do
  directory_name=$(basename "$(dirname "$skill_file")")
  declared_name=$(sed -n 's/^name:[[:space:]]*//p' "$skill_file" | head -n1)
  if [ "$directory_name" != "$declared_name" ]; then
    fail "$skill_file declares '$declared_name', expected '$directory_name'"
  fi
done

if [ -f skills-lock.json ]; then
  while IFS= read -r skill_name; do
    if [ ! -f ".agents/skills/$skill_name/SKILL.md" ]; then
      fail "skills-lock.json references missing skill '$skill_name'"
    fi
  done < <(jq -r '.skills | keys[]' skills-lock.json)
fi

runtime_docs_candidates=(
  CONTEXT.md
  .agents/skills/to-goals/SKILL.md
  .agents/skills/to-goals/GOALS-FORMAT.md
  .github/agent-prompts/drill-me-issue.md
)
runtime_docs=()
for candidate in "${runtime_docs_candidates[@]}"; do
  [ -f "$candidate" ] && runtime_docs+=("$candidate")
done
if [ "${#runtime_docs[@]}" -gt 0 ] && grep -En '(/drill-with-docs|/drill-goal|/drill-subgoal|skills/drill-goal|skills/drill-subgoal)' "${runtime_docs[@]}"; then
  fail "runtime documentation references retired drill skills"
fi

if [ -e .agents/skills/grill ] || [ -e .agents/skills/grilling ] || \
   [ -e .claude/skills/grill ] || [ -e .claude/skills/grilling ]; then
  fail "old grill/grilling skills must not exist; use the unified /drill-me skill"
fi
legacy_reference_files=(docs/adr/*.md)
[ -f skills-lock.json ] && legacy_reference_files+=(skills-lock.json)
if [ "${#legacy_reference_files[@]}" -gt 0 ] && grep -En '/grill|/grilling|skills/grill|skills/grilling' "${legacy_reference_files[@]}"; then
  fail "repository still references deleted grill/grilling skills"
fi

if [ -e .agents/skills/setup-matt-pocock-skills ] || [ -e .claude/skills/setup-matt-pocock-skills ]; then
  fail "setup-matt-pocock-skills must not exist; agentify setup lives in SETUP.md and .github/scripts/setup-agentify.sh"
fi
setup_reference_files=(SETUP.md docs/adr/*.md .agents/skills/*/SKILL.md)
[ -f skills-lock.json ] && setup_reference_files+=(skills-lock.json)
if [ "${#setup_reference_files[@]}" -gt 0 ] && grep -En 'setup-matt-pocock-skills|Matt Pocock|matt-pocock|matt pocock' "${setup_reference_files[@]}"; then
  fail "repository still references deleted setup-matt-pocock-skills surface"
fi
if [ -f .agents/skills/to-issues/SKILL.md ]; then
  require_text \
    .agents/skills/to-issues/SKILL.md \
    'agent:queued' \
    "implementation slices must be created with agent:queued"
fi
if [ -f .agents/skills/to-prd/SKILL.md ]; then
  require_text \
    .agents/skills/to-prd/SKILL.md \
    'artifact:prd' \
    "PRDs must use the artifact:prd label"
fi

for workflow in \
  .github/workflows/agent-implement-pr.yml \
  .github/workflows/agent-review.yml \
  .github/workflows/agent-update-branch.yml
do
  require_text "$workflow" 'head\.repo\.full_name == github\.repository' \
    "privileged PR workflows must reject fork heads"
  require_text "$workflow" "startsWith\\(github\\.event\\.pull_request\\.head\\.ref, 'agent/'\\)" \
    "privileged PR workflows must only mutate agent-owned branches"
  require_text "$workflow" 'path: \.agentify-runtime' \
    "privileged PR workflows must checkout trusted runtime files from the base"
  require_text "$workflow" 'uses: \./\.agentify-runtime/\.github/actions/setup-pi' \
    "privileged PR workflows must execute the base branch Pi setup action"
done

require_text .github/workflows/agent-implement.yml 'path: \.agentify-runtime' \
  "issue implementation must use a trusted default-branch runtime checkout"
require_text .github/workflows/agent-implement.yml 'uses: \./\.agentify-runtime/\.github/actions/run-pi' \
  "both issue implementation agent runs must use trusted runtime actions"
require_text .github/workflows/agent-drill-me-issue.yml 'uses: \./\.agentify-runtime/\.github/actions/run-pi' \
  "drill runs must use trusted default-branch runtime actions"
require_text .github/workflows/agent-refresh-surface.yml 'path: \.agentify-runtime' \
  "surface refresh must use a trusted default-branch runtime checkout"
require_text .github/workflows/agent-refresh-surface.yml 'uses: \./\.agentify-runtime/\.github/actions/run-pi' \
  "surface refresh must use trusted runtime actions"

for workflow in \
  .github/workflows/agent-implement.yml \
  .github/workflows/agent-implement-pr.yml \
  .github/workflows/agent-review.yml \
  .github/workflows/agent-update-branch.yml \
  .github/workflows/agent-refresh-surface.yml
do
  if awk '
    /^    env:/ { in_job_env = 1; next }
    in_job_env && /^    steps:/ { exit }
    in_job_env && /GH_TOKEN:/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$workflow"
  then
    fail "write-capable GH_TOKEN must be scoped to individual steps ($workflow)"
  fi
  require_text "$workflow" 'persist-credentials: false' \
    "coding agents must not inherit persisted git credentials"
done

require_text .github/workflows/agent-drill-me-issue.yml '^[[:space:]]+issues:' \
  "issue creation/label-add must trigger drilling"
require_text .github/workflows/agent-drill-me-issue.yml '^[[:space:]]+issue_comment:' \
  "issue comments must trigger drilling"
require_text .github/workflows/agent-drill-me-issue.yml 'AUTHOR_ASSOCIATION' \
  "drill workflow must authorize the initiating actor"
require_text .github/workflows/agent-drill-me-issue.yml 'OWNER.*MEMBER.*COLLABORATOR' \
  "drill workflow must limit mutation to trusted repository roles"
require_text .github/workflows/agent-drill-me-issue.yml "contains\\(github\\.event\\.issue\\.labels\\.\\*\\.name, 'agent:drill-me'\\)" \
  "drill workflow must gate on the agent:drill-me label"
require_text .github/workflows/agent-drill-me-issue.yml 'agent/drill-me-' \
  "drill workflow must use the agent/drill-me- branch prefix"

require_text .github/agent-state-machine.json '"agent:queued"' \
  "agent state machine contract must document agent labels"
jq -e . .github/agent-state-machine.json >/dev/null \
  || fail ".github/agent-state-machine.json is not valid JSON"
require_text .github/workflows/agent-command.yml 'issue_comment:' \
  "agent command router must listen to issue comments"
require_text .github/workflows/agent-command.yml 'AUTHOR_ASSOCIATION' \
  "agent command router must authorize actors"
require_text .github/workflows/agent-command.yml 'route-agent-command\.sh' \
  "agent command workflow must delegate to the router script"
require_text .github/scripts/route-agent-command.sh '/agent retry|retry\)' \
  "agent command router must support retry"
require_text .github/scripts/route-agent-command.sh 'update-branch' \
  "agent command router must support update-branch"

require_text .github/actions/setup-pi/action.yml 'version:' \
  "Pi setup must accept an exact version"
require_text .github/actions/run-pi/action.yml 'run-pi-safe\.sh' \
  "Pi runs must go through the agentify safety wrapper"
if grep -Eq '^[[:space:]]+pi --print' .github/actions/run-pi/action.yml; then
  fail "run-pi action must not invoke pi directly; use run-pi-safe.sh"
fi
require_text .github/scripts/run-pi-safe.sh 'unset AGENT_PAT' \
  "Pi safety wrapper must remove AGENT_PAT from the model process"
require_text .github/scripts/run-pi-safe.sh 'AGENTIFY_CI_DEFENSE=1' \
  "Pi safety wrapper must enable the CI defense floor"
require_text SETUP.md 'PI_VERSION' \
  "Setup must require a pinned Pi version"

if [ -d docs/adr ]; then
  duplicate_adr_ids=$(
    find docs/adr -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]-*.md' -printf '%f\n' |
      cut -d- -f1 |
      sort |
      uniq -d
  )
  if [ -n "$duplicate_adr_ids" ]; then
    fail "duplicate ADR identifiers: $duplicate_adr_ids"
  fi
fi

for script in .github/scripts/*.sh tests/*.sh; do
  bash -n "$script" || fail "shell syntax failed: $script"
done

if command -v ruby >/dev/null 2>&1; then
  for yaml_file in .github/workflows/*.yml .github/actions/*/action.yml; do
    ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0))' "$yaml_file" ||
      fail "YAML syntax failed: $yaml_file"
  done
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures repository validation error(s)." >&2
  exit 1
fi

echo "Repository validation passed."
