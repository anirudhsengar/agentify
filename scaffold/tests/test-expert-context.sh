#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
renderer="$repo_root/.github/scripts/render-expert-context.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

output=$(bash "$renderer" "$tmp")
grep -Fq 'No generated `.pi/prompts/experts/*/expertise.yaml` experts were found' <<<"$output"

mkdir -p "$tmp/.pi/prompts/experts/billing"
cat > "$tmp/.pi/prompts/experts/billing/expertise.yaml" <<'YAML'
# agentify:managed
domain: "billing"
overview:
  description: "Billing carries recurring payment invariants."
  key_files:
    - path: "src/billing/index.ts"
      line_range: [1, 120]
      purpose: "Authorizes invoices before capture."
primary_paths:
  - "src/billing"
  - "tests/billing.test.ts"
entry_points:
  - "src/billing/index.ts"
key_types:
  - name: "Invoice"
    path: "src/billing/types.ts:1"
    purpose: "Invoice lifecycle state machine."
patterns:
  - name: "authorization-before-capture"
    description: "Invoices cannot be captured before authorization."
    example_ref: "src/billing/index.ts:42"
pitfalls:
  - risk: "Double charging on retry."
    consequence: "Customers can be charged twice."
    reference: "src/billing/index.ts:55"
conventions:
  - "Amounts are stored in cents."
testing:
  command: "npm test -- tests/billing.test.ts"
  test_paths:
    - "tests/billing.test.ts"
YAML

output=$(bash "$renderer" "$tmp")
grep -Fq '### `billing`' <<<"$output"
grep -Fq 'Path: `.pi/prompts/experts/billing/expertise.yaml`' <<<"$output"
grep -Fq 'Billing carries recurring payment invariants.' <<<"$output"
grep -Fq 'Authorizes invoices before capture.' <<<"$output"
grep -Fq 'Invoice lifecycle state machine.' <<<"$output"
grep -Fq 'Invoices cannot be captured before authorization.' <<<"$output"
grep -Fq 'Amounts are stored in cents.' <<<"$output"
grep -Fq 'Test command: `npm test -- tests/billing.test.ts`' <<<"$output"
grep -Fq '`tests/billing.test.ts`' <<<"$output"
grep -Fq '`src/billing`' <<<"$output"
grep -Fq '`src/billing/index.ts`' <<<"$output"
grep -Fq 'Double charging on retry.' <<<"$output"

mkdir -p "$tmp/.pi/prompts/experts/orders"
cp "$tmp/.pi/prompts/experts/billing/expertise.yaml" "$tmp/.pi/prompts/experts/orders/expertise.yaml"
output=$(
  AGENTIFY_EXPERT_CONTEXT_MAX_EXPERTS=1 \
  bash "$renderer" "$tmp"
)
grep -Fq 'Additional experts omitted after 1 entries.' <<<"$output"

echo "expert context rendering passed."
