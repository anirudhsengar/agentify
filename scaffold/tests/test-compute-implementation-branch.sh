#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
computer="$repo_root/.github/scripts/compute-implementation-branch.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

assert_output() {
  local issue_number=$1
  local issue_title=$2
  local expected=$3
  local output_file="$tmp/output-$issue_number.txt"

  bash "$computer" "$issue_number" "$issue_title" "$output_file"
  if ! grep -q "^name=$expected$" "$output_file"; then
    printf 'expected branch: %s\nactual output:\n' "$expected" >&2
    cat "$output_file" >&2
    exit 1
  fi
}

assert_output 42 "Implement Payments Retry" "agent/issue-42-implement-payments-retry"
assert_output 7 "!!!" "agent/issue-7-issue"
assert_output 9 $'Fix payments\nretry now' "agent/issue-9-fix-payments-retry-now"

long_title="Implement a branch slug that keeps only the first fifty normalized characters"
output_file="$tmp/long-output.txt"
bash "$computer" 123 "$long_title" "$output_file"
branch=$(sed -n 's/^name=//p' "$output_file")
slug=${branch#agent/issue-123-}
if [ "${#slug}" -ne 50 ]; then
  echo "expected slug to be truncated to 50 characters, got ${#slug}" >&2
  exit 1
fi

if bash "$computer" "not-a-number" "Title" "$tmp/bad-output.txt" >/dev/null 2>&1; then
  echo "expected non-numeric issue number to fail" >&2
  exit 1
fi
