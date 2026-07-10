#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
router="$repo_root/.github/scripts/route-agent-command.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CAPTURE"
EOF
chmod +x "$tmp/bin/gh"

export PATH="$tmp/bin:$PATH"
export GH_TOKEN=gh-test
export GITHUB_REPOSITORY=owner/repo
export GH_CAPTURE="$tmp/gh-capture.txt"

bash "$router" "/agent retry" "42" "false"
grep -q 'issue edit 42 --repo owner/repo --remove-label agent:blocked' "$GH_CAPTURE"
grep -q 'issue edit 42 --repo owner/repo --remove-label agent:in-progress' "$GH_CAPTURE"
grep -q 'issue edit 42 --repo owner/repo --add-label agent:implement' "$GH_CAPTURE"
grep -q 'issue comment 42 --repo owner/repo --body Queued retry with `agent:implement`.' "$GH_CAPTURE"

: > "$GH_CAPTURE"
bash "$router" "/agent retry" "9" "true"
grep -q 'pr edit 9 --repo owner/repo --remove-label agent:blocked' "$GH_CAPTURE"
grep -q 'pr edit 9 --repo owner/repo --remove-label agent:in-progress' "$GH_CAPTURE"
grep -q 'pr edit 9 --repo owner/repo --add-label agent:review' "$GH_CAPTURE"
grep -q 'issue comment 9 --repo owner/repo --body Queued retry with `agent:review`.' "$GH_CAPTURE"
