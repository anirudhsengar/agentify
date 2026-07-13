#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
resolver="$repo_root/.github/scripts/resolve-state-dir.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/.pi/agentify"
cat > "$tmp/.pi/agentify/manifest.json" <<'JSON'
{"schema_version":"1","files":[]}
JSON
[ "$("$resolver" "$tmp")" = ".pi/agentify" ]

mkdir -p "$tmp/.claude/agentify"
cp "$tmp/.pi/agentify/manifest.json" "$tmp/.claude/agentify/manifest.json"
if "$resolver" "$tmp" >"$tmp/out" 2>"$tmp/err"; then
  echo "multiple unstamped manifests must fail" >&2
  exit 1
fi
grep -q "multiple unstamped" "$tmp/err"

cat > "$tmp/.claude/agentify/manifest.json" <<'JSON'
{"schema_version":"2","state_dir":".claude/agentify","files":[]}
JSON
[ "$("$resolver" "$tmp")" = ".claude/agentify" ]

cat > "$tmp/.claude/agentify/manifest.json" <<'JSON'
{"schema_version":"2","state_dir":".agents/agentify","files":[]}
JSON
if "$resolver" "$tmp" >"$tmp/out" 2>"$tmp/err"; then
  echo "mismatched state_dir must fail" >&2
  exit 1
fi
grep -q "state_dir mismatch" "$tmp/err"

rm -rf "$tmp/.pi" "$tmp/.claude"
if "$resolver" "$tmp" >"$tmp/out" 2>"$tmp/err"; then
  echo "missing manifest must fail" >&2
  exit 1
fi
grep -q "no Agentify manifest" "$tmp/err"
