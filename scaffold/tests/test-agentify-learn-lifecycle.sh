#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$root/.github/workflows/agentify-learn.yml"

grep -q 'pull_request_target:' "$workflow"
grep -q 'learning-runtime.mjs process' "$workflow"
grep -q 'learning-runtime.mjs reconcile' "$workflow"
grep -q 'learning-runtime.mjs verify-diff' "$workflow"
grep -q 'knowledge-maintenance' "$workflow"
! grep -q 'npm install' "$workflow"

echo 'focused Agentify learning workflow passed'
