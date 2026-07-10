#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
renderer="$repo_root/.github/scripts/render-workflow-context.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

output=$(bash "$renderer" "$tmp")
grep -Fq 'No `.pi/workflows/*.json` specs were found' <<<"$output"

mkdir -p "$tmp/.pi/workflows"
cat > "$tmp/.pi/workflows/payments-plan-build-review-fix.json" <<'JSON'
{
  "name": "payments_plan_build_review_fix",
  "description": "Scout with the Payments specialist, then run the canonical plan-build-review-fix AIW loop.",
  "tags": ["agentify", "specialist", "payments"],
  "inputs": {
    "prompt": {
      "type": "string",
      "description": "The Payments work request."
    }
  },
  "parallelism": "sequential",
  "steps": [
    {
      "id": "scout",
      "handler": "subagent",
      "subagent_template": "payments",
      "domain": ["payments"]
    },
    {
      "id": "implement",
      "handler": "aiw",
      "workflow_type": "plan_build_review_fix",
      "depends_on": ["scout"]
    }
  ]
}
JSON

output=$(bash "$renderer" "$tmp")
grep -Fq '### `payments_plan_build_review_fix`' <<<"$output"
grep -Fq 'Scout with the Payments specialist' <<<"$output"
grep -Fq 'Tags: agentify, specialist, payments' <<<"$output"
grep -Fq 'Inputs: prompt' <<<"$output"
grep -Fq '`scout`: handler `subagent`, specialist `payments`, domain `payments`' <<<"$output"
grep -Fq '`implement`: handler `aiw`, AIW `plan_build_review_fix`' <<<"$output"

printf '{not json' > "$tmp/.pi/workflows/broken.json"
output=$(bash "$renderer" "$tmp")
grep -Fq '### Skipped `.pi/workflows/broken.json`' <<<"$output"
grep -Fq 'invalid workflow JSON or missing required name, description, or steps' <<<"$output"
grep -Fq '### `payments_plan_build_review_fix`' <<<"$output"

rm -f "$tmp/.pi/workflows/broken.json"
for index in 1 2; do
  cp "$tmp/.pi/workflows/payments-plan-build-review-fix.json" "$tmp/.pi/workflows/extra-$index.json"
done
output=$(
  AGENTIFY_WORKFLOW_CONTEXT_MAX_WORKFLOWS=1 \
  AGENTIFY_WORKFLOW_CONTEXT_MAX_STEPS=1 \
  bash "$renderer" "$tmp"
)
grep -Fq 'Additional workflow specs omitted after 1 entries.' <<<"$output"
grep -Fq 'Additional steps omitted after 1 entries.' <<<"$output"

echo "workflow context rendering passed."
