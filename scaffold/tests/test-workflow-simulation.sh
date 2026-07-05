#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"

cat > "$tmp/bin/pi" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'AGENT_PAT=%s\n' "${AGENT_PAT-}"
  printf 'GH_TOKEN=%s\n' "${GH_TOKEN-}"
  printf 'ARGS=%s\n' "$*"
} > "$PI_CAPTURE"
printf 'fake pi output\n'
SH
chmod +x "$tmp/bin/pi"

cat > "$tmp/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_CAPTURE"
SH
chmod +x "$tmp/bin/gh"

export PATH="$tmp/bin:$PATH"

prompt="$tmp/prompt.md"
printf 'Implement issue without reading .env\n' > "$prompt"

export PI_API_KEY=sk-test
export PI_MODEL=test-model
export PI_PROVIDER=openai
export PI_THINKING=low
export PROMPT_FILE="$prompt"
export PI_CAPTURE="$tmp/pi-capture.txt"
export AGENT_PAT=must-not-leak
export GH_TOKEN=must-not-leak
export GITHUB_TOKEN=must-not-leak

bash "$repo_root/.github/scripts/run-pi-safe.sh" > "$tmp/pi-output.txt"
grep -q 'fake pi output' "$tmp/pi-output.txt"
grep -q '^AGENT_PAT=$' "$PI_CAPTURE"
grep -q '^GH_TOKEN=$' "$PI_CAPTURE"
grep -q -- '--model test-model' "$PI_CAPTURE"

export GH_CAPTURE="$tmp/gh-capture.txt"
export GH_TOKEN=gh-test
export GITHUB_REPOSITORY=owner/repo

bash "$repo_root/.github/scripts/route-agent-command.sh" "/agent implement" "42" "false"
grep -q 'issue edit 42 --repo owner/repo --add-label agent:implement' "$GH_CAPTURE"
grep -q 'issue comment 42 --repo owner/repo --body Queued implementation' "$GH_CAPTURE"

: > "$GH_CAPTURE"
bash "$repo_root/.github/scripts/route-agent-command.sh" "/agent update-branch" "7" "true"
grep -q 'pr edit 7 --repo owner/repo --add-label agent:update-branch' "$GH_CAPTURE"

echo "workflow simulation passed."
