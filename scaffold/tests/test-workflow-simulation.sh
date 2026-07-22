#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"

cat > "$tmp/bin/pi" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'AGENT_PAT=%s\n' "${AGENT_PAT-}"
  printf 'GH_TOKEN=%s\n' "${GH_TOKEN-}"
  printf 'ARGS=%s\n' "$*"
} > "$PI_CAPTURE"
printf 'fake pi output\n'
SH
chmod +x "$tmp/bin/pi"

cat > "$tmp/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_CAPTURE"
SH
chmod +x "$tmp/bin/gh"

export PATH="$tmp/bin:$PATH"

prompt="$tmp/prompt.md"
printf 'Implement issue without reading .env\n' > "$prompt"

export PI_API_KEY=sk-test
export PI_MODEL=test-model
export PI_PROVIDER=openai
export PI_THINKING=low
export PROMPT_FILE="$prompt"
printf '{"maximum_runtime_ms":60000,"maximum_cost_usd":5,"pricing_policy":{"version":"v1","models":[]}}\n' > "$tmp/draft-config.json"
node "$repo_root/.github/scripts/draft-run-control.mjs" init "$tmp/draft-state.json" "$tmp/draft-config.json"
export AGENTIFY_DRAFT_STATE_FILE="$tmp/draft-state.json"
export AGENTIFY_DRAFT_CONFIG_FILE="$tmp/draft-config.json"
export AGENTIFY_DRAFT_STEP="test model"
export PI_CAPTURE="$tmp/pi-capture.txt"
export AGENT_PAT=must-not-leak
export GH_TOKEN=must-not-leak
export GITHUB_TOKEN=must-not-leak

bash "$repo_root/.github/scripts/run-pi-safe.sh" > "$tmp/pi-output.txt"
grep -q 'fake pi output' "$tmp/pi-output.txt"
grep -q '^AGENT_PAT=$' "$PI_CAPTURE"
grep -q '^GH_TOKEN=$' "$PI_CAPTURE"
grep -q -- '--model test-model' "$PI_CAPTURE"

export GH_CAPTURE="$tmp/gh-capture.txt"
export GH_TOKEN=gh-test
export GITHUB_REPOSITORY=owner/repo

bash "$repo_root/.github/scripts/route-agent-command.sh" "/agent implement" "42" "false"
grep -q 'issue edit 42 --repo owner/repo --add-label agent:implement' "$GH_CAPTURE"
grep -q 'issue comment 42 --repo owner/repo --body Queued implementation' "$GH_CAPTURE"

: > "$GH_CAPTURE"
bash "$repo_root/.github/scripts/route-agent-command.sh" "/agent update-branch" "7" "true"
grep -q 'pr edit 7 --repo owner/repo --add-label agent:update-branch' "$GH_CAPTURE"

export ISSUE_NUMBER=42
export ISSUE_TITLE="Implement payments retry"
export BRANCH="agent/issue-42-implement-payments-retry"
export ISSUE_CONTEXT_DIR="$tmp/issue-context"
export WORKFLOW_CONTEXT=$'## Project Workflow Context\n\n### `payments_plan_build_review_fix`\n\n- Steps:\n- `scout`: handler `subagent`, specialist `payments`\n- `implement`: handler `aiw`, AIW `plan_build_review_fix`'
export SPECIALIST_CONTEXT=$'## Specialist Routing Context\n\n### `payments`\n\n- Path: `.pi/agents/payments.md`\n- Globs:\n  - `src/payments/**`'
export EXPERT_CONTEXT=$'## Expert Routing Context\n\n### `billing`\n\n- Path: `.pi/prompts/experts/billing/expertise.yaml`\n- Pattern knowledge:\n  - authorization-before-capture: Invoices cannot be captured before authorization. (src/billing/index.ts:42)\n- Primary paths:\n  - `src/billing`'
export ORCHESTRATION_PLAN=$'## Orchestration Plan\n\nUse payments specialist and billing expert.\n\n### Selected Specialists\n- `payments`'
export FORMATION_RESUME_CONTEXT=$'## Formation Resume Context\n\n### Structured GitHub Handoff\n\n- Action: `open_implementation_issue`\n- Title: Implement Process invoices end to end\n\n#### Labels\n- `agent:queued`\n- `agent:implement`\n\n#### Handoff Body\n\n## What to build\n\nBuild the invoice import slice.\n\n## Acceptance criteria\n\n- The importer accepts one fixture file.\n\n## Blocked by\n\nNone - can start immediately.'
envsubst < "$repo_root/.github/agent-prompts/implement.md" > "$tmp/implement-rendered.md"
grep -q '### `payments_plan_build_review_fix`' "$tmp/implement-rendered.md"
grep -q 'specialist `payments`' "$tmp/implement-rendered.md"
grep -q 'Path: `.pi/agents/payments.md`' "$tmp/implement-rendered.md"
grep -q 'Path: `.pi/prompts/experts/billing/expertise.yaml`' "$tmp/implement-rendered.md"
grep -q 'Invoices cannot be captured before authorization.' "$tmp/implement-rendered.md"
grep -q '## Orchestration Plan' "$tmp/implement-rendered.md"
grep -q 'Use payments specialist and billing expert.' "$tmp/implement-rendered.md"
grep -q '## Routing evidence' "$tmp/implement-rendered.md"
grep -q 'trusted workflow checks this transcript' "$tmp/implement-rendered.md"
if grep -q 'WORKFLOW_CONTEXT' "$tmp/implement-rendered.md"; then
  echo "implement prompt left WORKFLOW_CONTEXT unsubstituted" >&2
  exit 1
fi
if grep -q 'SPECIALIST_CONTEXT' "$tmp/implement-rendered.md"; then
  echo "implement prompt left SPECIALIST_CONTEXT unsubstituted" >&2
  exit 1
fi
if grep -q 'EXPERT_CONTEXT' "$tmp/implement-rendered.md"; then
  echo "implement prompt left EXPERT_CONTEXT unsubstituted" >&2
  exit 1
fi
if grep -q 'ORCHESTRATION_PLAN' "$tmp/implement-rendered.md"; then
  echo "implement prompt left ORCHESTRATION_PLAN unsubstituted" >&2
  exit 1
fi

export EVENT_NAME=issues
export EVENT_ID=event-123
export BRANCH=agent/issue-42-drill
envsubst < "$repo_root/.github/agent-prompts/drill-me-issue.md" > "$tmp/drill-rendered.md"
grep -q '### Structured GitHub Handoff' "$tmp/drill-rendered.md"
grep -q 'open_implementation_issue' "$tmp/drill-rendered.md"
grep -q 'Use the Structured GitHub Handoff' "$tmp/drill-rendered.md"
grep -q '"activate": true' "$tmp/drill-rendered.md"
grep -q 'implementationIssues' "$tmp/drill-rendered.md"
if grep -q 'FORMATION_RESUME_CONTEXT' "$tmp/drill-rendered.md"; then
  echo "drill prompt left FORMATION_RESUME_CONTEXT unsubstituted" >&2
  exit 1
fi

export PR_NUMBER=9
export BASE_REF=main
export PR_CONTEXT_DIR="$tmp/pr-context"
envsubst < "$repo_root/.github/agent-prompts/implement-pr.md" > "$tmp/implement-pr-rendered.md"
grep -q '### `payments_plan_build_review_fix`' "$tmp/implement-pr-rendered.md"
grep -q 'specialist `payments`' "$tmp/implement-pr-rendered.md"
grep -q 'Path: `.pi/agents/payments.md`' "$tmp/implement-pr-rendered.md"
grep -q 'Path: `.pi/prompts/experts/billing/expertise.yaml`' "$tmp/implement-pr-rendered.md"
grep -q 'Invoices cannot be captured before authorization.' "$tmp/implement-pr-rendered.md"
grep -q '## Routing evidence' "$tmp/implement-pr-rendered.md"
if grep -q 'WORKFLOW_CONTEXT' "$tmp/implement-pr-rendered.md"; then
  echo "implement-pr prompt left WORKFLOW_CONTEXT unsubstituted" >&2
  exit 1
fi
if grep -q 'SPECIALIST_CONTEXT' "$tmp/implement-pr-rendered.md"; then
  echo "implement-pr prompt left SPECIALIST_CONTEXT unsubstituted" >&2
  exit 1
fi
if grep -q 'EXPERT_CONTEXT' "$tmp/implement-pr-rendered.md"; then
  echo "implement-pr prompt left EXPERT_CONTEXT unsubstituted" >&2
  exit 1
fi

envsubst < "$repo_root/.github/agent-prompts/review.md" > "$tmp/review-rendered.md"
grep -q 'Path: `.pi/agents/payments.md`' "$tmp/review-rendered.md"
grep -q 'Path: `.pi/prompts/experts/billing/expertise.yaml`' "$tmp/review-rendered.md"
grep -q 'Invoices cannot be captured before authorization.' "$tmp/review-rendered.md"
grep -q '## Routing evidence' "$tmp/review-rendered.md"
if grep -q 'SPECIALIST_CONTEXT' "$tmp/review-rendered.md"; then
  echo "review prompt left SPECIALIST_CONTEXT unsubstituted" >&2
  exit 1
fi
if grep -q 'EXPERT_CONTEXT' "$tmp/review-rendered.md"; then
  echo "review prompt left EXPERT_CONTEXT unsubstituted" >&2
  exit 1
fi

echo "workflow simulation passed."
