#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
node "$root/tests/draft-run-control.test.mjs"
grep -q 'timeout-minutes: 60' "$root/.github/workflows/agent-implement.yml"
grep -q 'draft-run-control.mjs init' "$root/.github/workflows/agent-implement.yml"
grep -q 'outer_workflow_timeout_is_emergency_only' "$root/.github/scripts/draft-run-control.mjs"
grep -q 'finalize-draft-validation.mjs' "$root/.github/workflows/agent-implement.yml"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf '{"maximum_runtime_ms":60000,"maximum_cost_usd":1,"require_measured_cost":true,"pricing_policy":{"version":"v1","models":[]}}\n' > "$tmp/config"
node "$root/.github/scripts/draft-run-control.mjs" init "$tmp/state" "$tmp/config"
jq '.cost_measurement_status="estimated" | .cost_limit_status="measurement_required" | .estimated_cost_usd=.budget_usd' "$tmp/state" > "$tmp/state.x"; mv "$tmp/state.x" "$tmp/state"
printf '{"diff_policy":{"cost":true,"runtime":true},"passed":true,"publication_allowed":true,"failed_draft_policy_used":true}\n' > "$tmp/validation"
if node "$root/.github/scripts/finalize-draft-validation.mjs" "$tmp/state" "$tmp/validation"; then exit 1; fi
jq -e '.diff_policy.cost==false and .publication_allowed==false and .failed_draft_policy_used==false and .budget_usd==1 and .estimated_cost_usd==1' "$tmp/validation" >/dev/null
