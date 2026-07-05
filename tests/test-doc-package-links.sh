#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

failures=0
fail() {
  echo "ERROR: $*" >&2
  failures=$((failures + 1))
}

jq -e '.files | index("docs")' package.json >/dev/null \
  || fail "package.json files must include docs/ because README links to docs/"

while IFS= read -r link; do
  case "$link" in
    http://*|https://*|mailto:*|\#*) continue ;;
  esac
  target=${link%%#*}
  [ -e "$target" ] || fail "README.md link target is missing: $link"
done < <(
  grep -hoE '\[[^]]+\]\([^)]+\)' README.md |
    sed -E 's/.*\(([^)]+)\).*/\1/' |
    sort -u
)

if grep -Eq '\]\(docs/' scaffold/SETUP.md; then
  fail "stamped SETUP.md must not link to target-local docs/ paths"
fi

grep -q 'https://github.com/agentify/agentify/blob/main/docs/adr/' scaffold/SETUP.md \
  || fail "stamped SETUP.md should use public ADR URLs for source-repo docs"

if [ "$failures" -gt 0 ]; then
  echo "$failures doc/package link error(s)." >&2
  exit 1
fi

echo "Doc/package link checks passed."
