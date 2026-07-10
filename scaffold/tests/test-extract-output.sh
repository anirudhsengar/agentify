#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
extractor="$repo_root/.github/scripts/extract-output.sh"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

assert_equals() {
  local expected=$1
  local actual=$2
  if [ "$actual" != "$expected" ]; then
    printf 'expected: %s\nactual:   %s\n' "$expected" "$actual" >&2
    exit 1
  fi
}

printf 'before\n<output>\n{"verdict":"approve"}\n</output>\nafter\n' > "$tmp"
assert_equals '{"verdict":"approve"}' "$(bash "$extractor" "$tmp")"

printf '<output>{"verdict":"approve"}</output>\n' > "$tmp"
assert_equals '{"verdict":"approve"}' "$(bash "$extractor" "$tmp")"

printf '<output>{"value":1}</output>\nnoise\n<output>\n{"value":2}\n</output>\n' > "$tmp"
assert_equals '{"value":2}' "$(bash "$extractor" "$tmp")"

printf 'no structured output\n' > "$tmp"
if bash "$extractor" "$tmp" >/dev/null 2>&1; then
  echo "expected missing output block to fail" >&2
  exit 1
fi
