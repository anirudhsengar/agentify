#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
validator="$repo_root/.github/scripts/validate-refresh-surface.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init -b main >/dev/null
git -C "$tmp" config user.name "pi-agent[bot]"
git -C "$tmp" config user.email "pi-agent[bot]@users.noreply.github.com"
mkdir -p "$tmp/.pi/agentify" "$tmp/.pi/agents" "$tmp/.pi/prompts/experts/billing" "$tmp/src"
cat > "$tmp/.pi/agentify/manifest.json" <<'EOF'
{"schema_version":"1","files":[]}
EOF
cat > "$tmp/AGENTS.md" <<'EOF'
<!-- agentify:managed -->
# AGENTS.md
EOF
cat > "$tmp/.pi/agents/billing.md" <<'EOF'
<!-- agentify:managed -->
# Billing
EOF
cat > "$tmp/.pi/prompts/experts/billing/expertise.yaml" <<'EOF'
# agentify:managed
domain: "billing"
last_updated: "2026-07-07T00:00:00.000Z"
primary_paths:
  - "src/billing"
overview:
  description: "Billing expert."
testing:
  command: "npm test -- billing"
  test_paths:
    - "tests/billing.test.ts"
EOF
printf '%s\n' 'console.log("base");' > "$tmp/src/app.ts"
git -C "$tmp" add .
git -C "$tmp" commit -m "initial" >/dev/null
git -C "$tmp" checkout -q -b agent/refresh-surface-test

printf '%s\n' '<!-- agentify:managed -->' '# Billing' 'Updated billing routing.' > "$tmp/.pi/agents/billing.md"
(cd "$tmp" && bash "$validator" main) >/dev/null

printf '%s\n' 'console.log("product change");' > "$tmp/src/app.ts"
if (cd "$tmp" && bash "$validator" main) >/dev/null 2>&1; then
  echo "expected product file refresh change to fail" >&2
  exit 1
fi
git -C "$tmp" checkout -- src/app.ts

{
  printf '%s\n' '<!-- agentify:managed -->'
  for i in $(seq 1 201); do printf 'line %s\n' "$i"; done
} > "$tmp/AGENTS.md"
if (cd "$tmp" && bash "$validator" main) >/dev/null 2>&1; then
  echo "expected oversized AGENTS.md to fail" >&2
  exit 1
fi
git -C "$tmp" checkout -- AGENTS.md

cat > "$tmp/.pi/prompts/experts/billing/expertise.yaml" <<'EOF'
# agentify:managed
domain: "billing"
primary_paths:
  - "src/billing"
testing:
  command: "npm test -- billing"
EOF
if (cd "$tmp" && bash "$validator" main) >/dev/null 2>&1; then
  echo "expected malformed expert YAML to fail" >&2
  exit 1
fi
