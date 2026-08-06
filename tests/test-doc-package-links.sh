#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

failures=0
fail() {
  echo "ERROR: $*" >&2
  failures=$((failures + 1))
}

while IFS= read -r link; do
  case "$link" in
    http://*|https://*|mailto:*|\#*) continue ;;
  esac
  target=${link%%#*}
  [ -e "$target" ] || fail "README.md link target is missing: $link"
  if [[ "$target" == docs/* ]]; then
    jq --arg target "$target" -e '.files | index($target)' package.json >/dev/null \
      || fail "README-linked document is absent from the package allowlist: $target"
  fi
done < <(
  grep -hoE '\[[^]]+\]\([^)]+\)' README.md |
    sed -E 's/.*\(([^)]+)\).*/\1/' |
    sort -u
)

if grep -Eq '\]\((docs/|https://github\.com/[^)]*/docs/)' scaffold/SETUP.md; then
  fail "stamped SETUP.md must remain self-contained instead of linking to source-only docs"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures doc/package link error(s)." >&2
  exit 1
fi

echo "Doc/package link checks passed."
