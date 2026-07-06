#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
extractor="$repo_root/.github/scripts/extract-pr-meta.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

assert_equals() {
  local expected=$1
  local actual=$2
  if [ "$actual" != "$expected" ]; then
    printf 'expected: %s\nactual:   %s\n' "$expected" "$actual" >&2
    exit 1
  fi
}

assert_fails() {
  local transcript=$1
  local issue_number=${2:-42}
  local out_dir
  out_dir="$tmp/fail-$RANDOM"
  if bash "$extractor" "$transcript" "$issue_number" "$out_dir" >/dev/null 2>&1; then
    echo "expected PR metadata extraction to fail" >&2
    exit 1
  fi
}

valid="$tmp/valid.txt"
printf '%s\n' \
  'prefix' \
  '<output>' \
  '{"prTitle":"feat: add billing export","prDescription":"## Summary\n\n- Added billing export.\n\nCloses #42"}' \
  '</output>' \
  > "$valid"

bash "$extractor" "$valid" 42 "$tmp/out"
assert_equals "feat: add billing export" "$(cat "$tmp/out/pr_title.txt")"
grep -q 'Closes #42' "$tmp/out/pr_description.txt" || {
  echo "expected PR description to close issue #42" >&2
  exit 1
}
jq -e '.prTitle == "feat: add billing export"' "$tmp/out/pr_meta.json" >/dev/null

missing_closer="$tmp/missing-closer.txt"
printf '%s\n' \
  '<output>' \
  '{"prTitle":"feat: add billing export","prDescription":"## Summary\n\n- Added billing export."}' \
  '</output>' \
  > "$missing_closer"
assert_fails "$missing_closer"

multiline_title="$tmp/multiline-title.txt"
printf '%s\n' \
  '<output>' \
  '{"prTitle":"feat: add\nbilling export","prDescription":"Closes #42"}' \
  '</output>' \
  > "$multiline_title"
assert_fails "$multiline_title"

long_title="$tmp/long-title.txt"
printf '%s\n' \
  '<output>' \
  '{"prTitle":"feat: add a billing export with enough extra detail that the title is too long","prDescription":"Closes #42"}' \
  '</output>' \
  > "$long_title"
assert_fails "$long_title"

assert_fails "$valid" "not-a-number"
