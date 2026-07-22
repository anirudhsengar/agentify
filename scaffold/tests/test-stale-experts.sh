#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
detector="$repo_root/.github/scripts/detect-stale-experts.mjs"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
state_dir=".pi/agentify"

mkdir -p "$tmp/$state_dir"
cat > "$tmp/$state_dir/manifest.json" <<'JSON'
{"schema_version":"2","state_dir":".pi/agentify","files":[]}
JSON

setup_expert() {
  local domain=$1
  local updated=$2
  local primary=$3
  local dir="$tmp/$state_dir/prompts/experts/$domain"
  mkdir -p "$dir"
  cat > "$dir/expertise.yaml" <<EOF
domain: $domain
last_updated: $updated
primary_paths:
  - $primary
overview:
  description: $domain expert
  key_files:
    - path: $primary/main.ts
      purpose: primary file
EOF
  printf -- '---\ndescription: %s expert\n---\n' "$domain" > "$dir/question.md"
  printf '# self improve\n' > "$dir/self-improve.md"
}

setup_expert "billing" "2026-07-01T00:00:00Z" "src/billing/"
setup_expert "auth" "2026-07-05T00:00:00Z" "src/auth/"

mkdir -p "$tmp/src/billing" "$tmp/src/auth"
printf 'export const billing = true;\n' > "$tmp/src/billing/main.ts"
printf 'export const auth = true;\n' > "$tmp/src/auth/main.ts"
node -e '
  const fs = require("node:fs");
  fs.utimesSync(process.argv[1], new Date("2026-07-03T00:00:00Z"), new Date("2026-07-03T00:00:00Z"));
  fs.utimesSync(process.argv[2], new Date("2026-07-03T00:00:00Z"), new Date("2026-07-03T00:00:00Z"));
' "$tmp/src/billing/main.ts" "$tmp/src/auth/main.ts"

out="$tmp/stale-experts.json"
node "$detector" "$tmp" > "$out"

jq -e '.checked == 2' "$out" >/dev/null
jq -e '.stale | length == 1' "$out" >/dev/null
jq -e '.stale[0].domain == "billing"' "$out" >/dev/null
jq -e '.stale[0].latestChangedPath == "src/billing/main.ts"' "$out" >/dev/null
