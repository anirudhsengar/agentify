#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
checker="$repo_root/.github/scripts/check-existing-issue-pr.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

expected='pr list --state open --search in:body "#42" --json number,url,body'
if [ "$*" != "$expected" ]; then
  printf 'unexpected gh invocation: %s\n' "$*" >&2
  exit 1
fi

printf '%s\n' "$PRS_JSON"
SH
chmod +x "$tmp/bin/gh"

export PATH="$tmp/bin:$PATH"
output="$tmp/output.txt"

export PRS_JSON='[
  {"number": 10, "url": "https://github.com/owner/repo/pull/10", "body": "References #42 but does not close it."},
  {"number": 11, "url": "https://github.com/owner/repo/pull/11", "body": "Fixes #42"}
]'
bash "$checker" 42 "$output"
grep -q '^existing_pr_url=https://github.com/owner/repo/pull/11$' "$output"
grep -q '^refused=true$' "$output"

: > "$output"
export PRS_JSON='[
  {"number": 12, "url": "https://github.com/owner/repo/pull/12", "body": "Closes #420"},
  {"number": 13, "url": "https://github.com/owner/repo/pull/13", "body": "Relates to #42"}
]'
bash "$checker" 42 "$output"
grep -q '^refused=false$' "$output"
if grep -q '^existing_pr_url=' "$output"; then
  echo "unexpected existing PR URL for non-closing PRs" >&2
  exit 1
fi

if bash "$checker" not-a-number "$tmp/bad-output.txt" >/dev/null 2>&1; then
  echo "expected non-numeric issue number to fail" >&2
  exit 1
fi

export PRS_JSON='{not json'
if bash "$checker" 42 "$tmp/invalid-json-output.txt" >/dev/null 2>&1; then
  echo "expected invalid PR JSON to fail" >&2
  exit 1
fi

echo "existing issue PR preflight passed."
