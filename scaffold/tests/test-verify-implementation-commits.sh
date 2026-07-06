#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
verifier="$repo_root/.github/scripts/verify-implementation-commits.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init -b main >/dev/null
git -C "$tmp" config user.name "pi-agent[bot]"
git -C "$tmp" config user.email "pi-agent[bot]@users.noreply.github.com"
printf '%s\n' "base" > "$tmp/file.txt"
git -C "$tmp" add file.txt
git -C "$tmp" commit -m "initial" >/dev/null
git -C "$tmp" checkout -q -b agent/issue-42-no-change

reason="$tmp/failure_reason.txt"
if (cd "$tmp" && bash "$verifier" main "$reason") >/dev/null 2>&1; then
  echo "expected no-commit implementation verification to fail" >&2
  exit 1
fi
grep -q 'Agent finished but no commits were made on the branch.' "$reason" || {
  echo "expected no-commit failure reason" >&2
  exit 1
}

printf '%s\n' "change" >> "$tmp/file.txt"
git -C "$tmp" add file.txt
git -C "$tmp" commit -m "feat: change file" >/dev/null

success_reason="$tmp/success_reason.txt"
(cd "$tmp" && bash "$verifier" main "$success_reason") > "$tmp/output.txt"
grep -q 'Implementation produced 1 commit(s).' "$tmp/output.txt" || {
  echo "expected commit count success output" >&2
  exit 1
}
if [ -f "$success_reason" ]; then
  echo "successful verification must not write a failure reason" >&2
  exit 1
fi

if (cd "$tmp" && bash "$verifier" "" "$reason") >/dev/null 2>&1; then
  echo "expected missing base ref to fail" >&2
  exit 1
fi
