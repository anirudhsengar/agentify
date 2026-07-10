#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
extractor="$repo_root/.github/scripts/extract-review-verdict.sh"
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
  local out_dir="$tmp/fail-$RANDOM"
  local github_output="$tmp/fail-output-$RANDOM.txt"
  if bash "$extractor" "$transcript" "$out_dir" "$github_output" >/dev/null 2>&1; then
    echo "expected review verdict extraction to fail" >&2
    exit 1
  fi
  if [ -f "$github_output" ] && grep -q '^value=' "$github_output"; then
    echo "failed extraction must not write a verdict output" >&2
    exit 1
  fi
}

valid="$tmp/valid.txt"
cat > "$valid" <<'EOF'
Review complete.
<output>
{
  "verdict": "approve",
  "summary": "Checked tests and domain invariants."
}
</output>
EOF

bash "$extractor" "$valid" "$tmp/out" "$tmp/github-output.txt"
assert_equals "approve" "$(cat "$tmp/out/verdict.txt")"
grep -q 'Checked tests and domain invariants.' "$tmp/out/summary.md" || {
  echo "expected summary markdown" >&2
  exit 1
}
grep -q '^value=approve$' "$tmp/github-output.txt" || {
  echo "expected GitHub output verdict" >&2
  exit 1
}

request_changes="$tmp/request-changes.txt"
cat > "$request_changes" <<'EOF'
<output>
{"verdict":"request_changes","summary":"Missing required test coverage."}
</output>
EOF
bash "$extractor" "$request_changes" "$tmp/request-out" "$tmp/request-github-output.txt"
assert_equals "request_changes" "$(cat "$tmp/request-out/verdict.txt")"
grep -q '^value=request_changes$' "$tmp/request-github-output.txt" || {
  echo "expected request_changes GitHub output verdict" >&2
  exit 1
}

bad_verdict="$tmp/bad-verdict.txt"
cat > "$bad_verdict" <<'EOF'
<output>
{"verdict":"looks_good","summary":"Not a supported verdict."}
</output>
EOF
assert_fails "$bad_verdict"

missing_summary="$tmp/missing-summary.txt"
cat > "$missing_summary" <<'EOF'
<output>
{"verdict":"approve"}
</output>
EOF
assert_fails "$missing_summary"

no_output="$tmp/no-output.txt"
printf '%s\n' 'plain review text' > "$no_output"
assert_fails "$no_output"
