#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

bash "$root/tests/test-agentify-issue-lifecycle.sh"
bash "$root/tests/test-agentify-learn-lifecycle.sh"

expected=$(cat <<'EOF'
.github/agentify-task-policy.json
.github/agentify/validation-smoke.mjs
.github/scripts/complete-accepted-task-merge.mjs
.github/scripts/publish-task-draft.mjs
.github/scripts/run-task-lifecycle.mjs
.github/scripts/task-state-github.mjs
.github/workflows/agentify-issue.yml
.github/workflows/agentify-learn.yml
AGENTS.md
SETUP.md
EOF
)
actual=$(find "$root" -type f ! -path "$root/tests/*" -printf '%P\n' | sort)
test "$actual" = "$expected"

echo 'focused scaffold inventory passed'
