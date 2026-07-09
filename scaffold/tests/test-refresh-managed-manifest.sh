#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
refresher="$repo_root/.github/scripts/refresh-managed-manifest.mjs"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/.pi/agentify" "$tmp/.pi/agents" "$tmp/.pi/prompts/experts/billing"
cat > "$tmp/AGENTS.md" <<'EOF'
<!-- agentify:managed -->
# AGENTS.md

Updated validation.
EOF
cat > "$tmp/.pi/agents/orders.md" <<'EOF'
<!-- agentify:managed -->
# Orders
EOF
cat > "$tmp/.pi/prompts/experts/billing/expertise.yaml" <<'EOF'
# agentify:managed
domain: "billing"
last_updated: "2026-07-07T00:00:00.000Z"
primary_paths:
  - "src/billing"
testing:
  command: "npm test -- billing"
EOF
cat > "$tmp/.pi/agentify/manifest.json" <<'EOF'
{
  "schema_version": "1",
  "agentify_version": "0.1.0",
  "generated_at": "2026-07-06T00:00:00.000Z",
  "mode": "brownfield",
  "files": [
    {
      "path": "AGENTS.md",
      "kind": "audit",
      "required": true,
      "marker": "<!-- agentify:managed -->",
      "sha256": "stale",
      "source": "managed-bundle"
    },
    {
      "path": ".pi/agents/payments.md",
      "kind": "audit",
      "required": false,
      "marker": "<!-- agentify:managed -->",
      "sha256": "removed",
      "source": "managed-bundle"
    }
  ]
}
EOF

node "$refresher" "$tmp"

expected_agents_hash=$(sha256sum "$tmp/AGENTS.md" | awk '{ print $1 }')
jq -e --arg hash "$expected_agents_hash" '.files[] | select(.path == "AGENTS.md" and .sha256 == $hash)' "$tmp/.pi/agentify/manifest.json" >/dev/null
jq -e '.files[] | select(.path == ".pi/agents/orders.md" and .source == "refresh-surface")' "$tmp/.pi/agentify/manifest.json" >/dev/null
jq -e '.files[] | select(.path == ".pi/prompts/experts/billing/expertise.yaml" and .kind == "expert")' "$tmp/.pi/agentify/manifest.json" >/dev/null
if jq -e '.files[] | select(.path == ".pi/agents/payments.md")' "$tmp/.pi/agentify/manifest.json" >/dev/null; then
  echo "removed optional refresh-managed file should be dropped from manifest" >&2
  exit 1
fi
