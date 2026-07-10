#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
extractor="$repo_root/.github/scripts/extract-update-branch-comment.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

assert_fails() {
  local transcript=$1
  local comment_file="$tmp/fail-comment-$RANDOM.md"
  if bash "$extractor" "$transcript" "$comment_file" >/dev/null 2>&1; then
    echo "expected update-branch comment extraction to fail" >&2
    exit 1
  fi
  if [ -f "$comment_file" ]; then
    echo "failed extraction must not write a comment file" >&2
    exit 1
  fi
}

valid="$tmp/valid.txt"
cat > "$valid" <<'EOF'
Merge resolved.
<output>
{
  "comment": "Resolved conflicts in src/billing.ts and ran npm test."
}
</output>
EOF

bash "$extractor" "$valid" "$tmp/comment.md"
grep -q 'Resolved conflicts in src/billing.ts' "$tmp/comment.md" || {
  echo "expected merge-resolution comment" >&2
  exit 1
}

missing_comment="$tmp/missing-comment.txt"
cat > "$missing_comment" <<'EOF'
<output>
{"summary":"Resolved conflicts."}
</output>
EOF
assert_fails "$missing_comment"

empty_comment="$tmp/empty-comment.txt"
cat > "$empty_comment" <<'EOF'
<output>
{"comment":""}
</output>
EOF
assert_fails "$empty_comment"

no_output="$tmp/no-output.txt"
printf '%s\n' 'plain merge report' > "$no_output"
assert_fails "$no_output"
