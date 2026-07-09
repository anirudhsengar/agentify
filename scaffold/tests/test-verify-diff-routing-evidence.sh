#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script="$repo_root/.github/scripts/verify-diff-routing-evidence.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

repo="$tmp/repo"
mkdir -p "$repo/src/payments" "$repo/src/billing" "$repo/tests"
cd "$repo"
git init -q
git config user.email test@example.com
git config user.name Test
printf 'base\n' > src/payments/processor.ts
printf 'base\n' > src/billing/index.ts
git add .
git commit -qm base
base_ref=$(git rev-parse HEAD)
git checkout -qb agent/test
printf 'changed\n' > src/payments/processor.ts
printf 'changed\n' > src/billing/index.ts
git add .
git commit -qm change

specialists="$tmp/specialist-context.md"
experts="$tmp/expert-context.md"
transcript="$tmp/transcript.txt"
failure_reason="$tmp/failure-reason.txt"

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
- Primary paths:
  - `src/billing`
- Entry points:
  - `src/billing/index.ts`
EOF

cat > "$transcript" <<'EOF'
Review complete.

## Routing evidence

- Matching specialist `payments`: read `.pi/agents/payments.md`.
- Matching expert `billing`: read `.pi/prompts/experts/billing/expertise.yaml`.
EOF

bash "$script" "$transcript" "$base_ref" "$specialists" "$experts" "$failure_reason"

cat > "$transcript" <<'EOF'
Review complete.

## Routing evidence

- Matching specialist `payments`: read `.pi/agents/payments.md`.
EOF

if bash "$script" "$transcript" "$base_ref" "$specialists" "$experts" "$failure_reason" >/dev/null 2>&1; then
  echo "expected missing matching expert evidence to fail" >&2
  exit 1
fi
grep -q 'missing matching expert `billing` evidence' "$failure_reason" || {
  echo "expected trusted failure reason for missing matching expert evidence" >&2
  exit 1
}
grep -q '.pi/prompts/experts/billing/expertise.yaml' "$failure_reason" || {
  echo "expected failure reason to name missing expertise file" >&2
  exit 1
}

cat > "$transcript" <<'EOF'
Review complete. I read `.pi/agents/payments.md` and `.pi/prompts/experts/billing/expertise.yaml`.
EOF

if bash "$script" "$transcript" "$base_ref" "$specialists" "$experts" "$failure_reason" >/dev/null 2>&1; then
  echo "expected missing routing evidence section to fail" >&2
  exit 1
fi
grep -q 'missing routing evidence section' "$failure_reason" || {
  echo "expected trusted failure reason for missing routing evidence section" >&2
  exit 1
}

git checkout -qb docs-only "$base_ref"
mkdir -p docs
printf 'docs\n' > docs/readme.md
git add .
git commit -qm docs
printf 'No relevant generated route.\n' > "$transcript"
bash "$script" "$transcript" "$base_ref" "$specialists" "$experts" "$failure_reason"

echo "verify-diff-routing-evidence tests passed."
