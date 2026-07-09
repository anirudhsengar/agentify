#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script="$repo_root/.github/scripts/verify-routing-evidence.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

plan="$tmp/orchestration-plan.md"
specialists="$tmp/specialist-context.md"
experts="$tmp/expert-context.md"
transcript="$tmp/transcript.txt"
failure_reason="$tmp/failure-reason.txt"

cat > "$plan" <<'EOF'
## Orchestration Plan

Use payments and billing.

### Selected Workflows
- `payments-plan-build-review-fix`

### Selected Specialists
- `payments`

### Selected Experts
- `billing`

### Validation Focus
- `npm test -- payments`
EOF

cat > "$specialists" <<'EOF'
## Specialist Routing Context

### `payments`

- Path: `.pi/agents/payments.md`
- Globs:
  - `src/payments/**`
EOF

cat > "$experts" <<'EOF'
## Expert Routing Context

### `billing`

- Path: `.pi/prompts/experts/billing/expertise.yaml`
- Test command: `npm test -- payments`
EOF

cat > "$transcript" <<'EOF'
Implementation complete.

## Routing evidence

- Selected specialist `payments`: read `.pi/agents/payments.md`.
- Selected expert `billing`: read `.pi/prompts/experts/billing/expertise.yaml`.
EOF

bash "$script" "$transcript" "$plan" "$specialists" "$experts" "$failure_reason"

cat > "$transcript" <<'EOF'
Implementation complete.

## Routing evidence

- Selected specialist `payments`: read `.pi/agents/payments.md`.
EOF

if bash "$script" "$transcript" "$plan" "$specialists" "$experts" "$failure_reason" >/dev/null 2>&1; then
  echo "expected missing selected expert evidence to fail" >&2
  exit 1
fi
grep -q 'missing selected expert evidence' "$failure_reason" || {
  echo "expected trusted failure reason for missing expert evidence" >&2
  exit 1
}
grep -q '.pi/prompts/experts/billing/expertise.yaml' "$failure_reason" || {
  echo "expected failure reason to name missing expertise file" >&2
  exit 1
}

cat > "$transcript" <<'EOF'
Implementation complete. I read `.pi/agents/payments.md` and `.pi/prompts/experts/billing/expertise.yaml`.
EOF

if bash "$script" "$transcript" "$plan" "$specialists" "$experts" "$failure_reason" >/dev/null 2>&1; then
  echo "expected missing routing evidence section to fail" >&2
  exit 1
fi
grep -q 'missing routing evidence section' "$failure_reason" || {
  echo "expected trusted failure reason for missing routing evidence section" >&2
  exit 1
}

empty_plan="$tmp/empty-plan.md"
cat > "$empty_plan" <<'EOF'
## Orchestration Plan

Use repository defaults.

### Selected Workflows
- none

### Selected Specialists
- none

### Selected Experts
- none

### Validation Focus
- Use the repository validation surface from AGENTS.md.
EOF

printf 'Implementation complete.\n' > "$transcript"
bash "$script" "$transcript" "$empty_plan" "$specialists" "$experts" "$failure_reason"

echo "verify-routing-evidence tests passed."
