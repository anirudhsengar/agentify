#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
publisher="$repo_root/.github/scripts/publish-implementation-pr.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

calls="$tmp/calls.log"
bin_dir="$tmp/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$CALLS_LOG"
EOF
chmod +x "$bin_dir/git"

cat > "$bin_dir/gh" <<'EOF'
#!/usr/bin/env bash
if [ "${GH_TOKEN:-}" != "secret-token" ]; then
  echo "expected GH_TOKEN to be set from AGENT_PAT" >&2
  exit 1
fi
printf 'gh %s\n' "$*" >> "$CALLS_LOG"
if [ "$1 $2" = "pr create" ]; then
  echo "${GH_PR_CREATE_OUTPUT:-https://github.com/example/repo/pull/123}"
fi
EOF
chmod +x "$bin_dir/gh"

title_file="$tmp/title.txt"
description_file="$tmp/description.md"
output_file="$tmp/github-output.txt"
printf '%s\n' 'feat: add billing export' > "$title_file"
printf '%s\n' '## Summary' '' 'Closes #42' > "$description_file"

CALLS_LOG="$calls" \
PATH="$bin_dir:$PATH" \
AGENT_PAT="secret-token" \
  bash "$publisher" \
    "agent/issue-42-billing-export" \
    "main" \
    "$title_file" \
    "$description_file" \
    "$output_file"

grep -q 'git push --force origin agent/issue-42-billing-export' "$calls" || {
  echo "expected agent branch to be force-pushed" >&2
  exit 1
}
grep -q 'gh auth setup-git' "$calls" || {
  echo "expected gh auth setup-git to run" >&2
  exit 1
}
grep -q 'gh pr create --draft --base main --head agent/issue-42-billing-export --title feat: add billing export --body-file '"$description_file" "$calls" || {
  echo "expected draft PR creation with rendered title/body" >&2
  exit 1
}
grep -q '^pr_number=123$' "$output_file" || {
  echo "expected PR number output" >&2
  exit 1
}

if CALLS_LOG="$calls" PATH="$bin_dir:$PATH" AGENT_PAT="secret-token" \
  bash "$publisher" "main" "main" "$title_file" "$description_file" "$output_file" >/dev/null 2>&1; then
  echo "expected non-agent branch publication to fail" >&2
  exit 1
fi

if CALLS_LOG="$calls" PATH="$bin_dir:$PATH" \
  bash "$publisher" "agent/issue-42-billing-export" "main" "$title_file" "$description_file" "$output_file" >/dev/null 2>&1; then
  echo "expected missing AGENT_PAT to fail" >&2
  exit 1
fi

bad_output_file="$tmp/bad-github-output.txt"
if CALLS_LOG="$calls" \
  PATH="$bin_dir:$PATH" \
  AGENT_PAT="secret-token" \
  GH_PR_CREATE_OUTPUT="not a pr url" \
  bash "$publisher" \
    "agent/issue-42-billing-export" \
    "main" \
    "$title_file" \
    "$description_file" \
    "$bad_output_file" >/dev/null 2>&1; then
  echo "expected malformed gh pr create output to fail" >&2
  exit 1
fi
if [ -f "$bad_output_file" ] && grep -q '^pr_number=' "$bad_output_file"; then
  echo "malformed gh output must not write a PR number" >&2
  exit 1
fi
