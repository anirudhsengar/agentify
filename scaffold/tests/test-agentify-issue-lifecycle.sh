#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$root/.github/workflows/agentify-issue.yml"

grep -q 'agentify:queue' "$workflow"
grep -q "vars.AGENTIFY_ENABLED == 'true'" "$workflow"
grep -q "github.event.comment.body == '/agent approve'" "$workflow"
grep -q 'Verify maintainer permission before checkout or dependency install' "$workflow"
grep -q 'needs: authorize' "$workflow"
grep -q 'node .github/scripts/run-task-lifecycle.mjs' "$workflow"
grep -q 'persist-credentials: false' "$workflow"
grep -q 'contents: write' "$workflow"
grep -q 'pull-requests: write' "$workflow"
! grep -q "github.event.sender.type == 'User'" "$workflow"
! grep -qE 'agent-(command|implement|review|update-branch)|run-task-lifecycle' "$workflow"
! grep -qE 'merge|auto-merge|deploy|force-push' "$workflow"

echo 'focused Agentify issue workflow passed'
