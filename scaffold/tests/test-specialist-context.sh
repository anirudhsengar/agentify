#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
renderer="$repo_root/.github/scripts/render-specialist-context.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

output=$(bash "$renderer" "$tmp")
grep -Fq 'No generated `.pi/agents/*.md` specialists were found' <<<"$output"

mkdir -p "$tmp/.pi/agents"
cat > "$tmp/.pi/agents/payments.md" <<'MD'
---
name: payments
description: Payment flow specialist.
globs:
  - src/payments/**
  - tests/payments/**
---

Use payment invariants.
MD

cat > "$tmp/.pi/agents/review.md" <<'MD'
---
name: review
description: Reserved review agent.
---

Reserved shipped review skill.
MD

output=$(bash "$renderer" "$tmp")
grep -Fq '### `payments`' <<<"$output"
grep -Fq 'Path: `.pi/agents/payments.md`' <<<"$output"
grep -Fq 'Payment flow specialist.' <<<"$output"
grep -Fq '`src/payments/**`' <<<"$output"
grep -Fq '`tests/payments/**`' <<<"$output"
if grep -Fq 'Reserved review agent' <<<"$output"; then
  echo "reserved agent was included in specialist context" >&2
  exit 1
fi

cat > "$tmp/.pi/agents/orders.md" <<'MD'
Use order invariants.
MD

output=$(
  AGENTIFY_SPECIALIST_CONTEXT_MAX_SPECIALISTS=1 \
  bash "$renderer" "$tmp"
)
grep -Fq 'Additional specialists omitted after 1 entries.' <<<"$output"

echo "specialist context rendering passed."
