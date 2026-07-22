#!/usr/bin/env bash
# agentify:managed
set -euo pipefail

: "${PI_API_KEY:?PI_API_KEY is required - see SETUP.md}"
: "${PI_MODEL:?PI_MODEL repository variable is required - see SETUP.md}"
: "${PROMPT_FILE:?PROMPT_FILE is required}"
: "${AGENTIFY_DRAFT_STATE_FILE:?AGENTIFY_DRAFT_STATE_FILE is required}"
: "${AGENTIFY_DRAFT_CONFIG_FILE:?AGENTIFY_DRAFT_CONFIG_FILE is required}"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "run-pi-safe: prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

# AGENT_PAT is for workflow shell steps that push branches, labels, and PRs.
# The model process does not need it; do not expose it as ambient env.
unset AGENT_PAT
unset GH_TOKEN
unset GITHUB_TOKEN

export AGENTIFY_CI_DEFENSE=1
export AGENTIFY_REPO_JAIL=1
export AGENTIFY_NO_PROJECT_EXTENSIONS="${AGENTIFY_NO_PROJECT_EXTENSIONS:-1}"

# --approve trusts only the checked-out runtime action for this one-shot job.
# Workflows call this script from .agentify-runtime, checked out from the
# protected base/default branch, not from mutable PR branch files.
control="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/draft-run-control.mjs"
exec node "$control" run "$AGENTIFY_DRAFT_STATE_FILE" "$AGENTIFY_DRAFT_STEP" -- \
  pi --print --no-session --approve \
  --extension "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/extensions/draft-budget.ts" \
  --provider "${PI_PROVIDER:-anthropic}" \
  --model "$PI_MODEL" \
  --api-key "$PI_API_KEY" \
  --thinking "${PI_THINKING:-high}" \
  "$(cat "$PROMPT_FILE")"
