#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
smoke="$repo_root/.github/scripts/smoke-drill-github-runtime.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

calls="$tmp/calls.log"
bin_dir="$tmp/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf 'gh %s\n' "$*" >> "$CALLS_LOG"

case "$1 $2" in
  "auth status")
    exit 0
    ;;
  "repo view")
    printf 'owner/repo\n'
    ;;
  "workflow view")
    if [ "$*" != "workflow view agent-drill-me-issue.yml --repo owner/repo" ]; then
      echo "unexpected workflow view call: $*" >&2
      exit 1
    fi
    ;;
  "label list")
    printf '%s\n' "${LABELS_OUTPUT:-agent:drill-me}"
    ;;
  "secret list")
    if [ "${SECRETS_OUTPUT+x}" = x ]; then
      printf '%s\n' "$SECRETS_OUTPUT"
    else
      printf 'AGENT_PAT\n'
    fi
    ;;
  "variable list")
    if [ "${VARIABLES_OUTPUT+x}" = x ]; then
      printf '%s\n' "$VARIABLES_OUTPUT"
    else
      printf 'AGENT_BOT_LOGIN\n'
    fi
    ;;
  "issue create")
    if [ "$*" != "issue create --repo owner/repo --title agentify drill smoke: no-model preflight --body-file $BODY_FILE" ]; then
      echo "unexpected issue create call: $*" >&2
      exit 1
    fi
    grep -q 'agentify-drill-smoke-no-model' "$BODY_FILE"
    printf 'https://github.com/owner/repo/issues/889\n'
    ;;
  "issue edit")
    if [ "$*" != "issue edit 889 --repo owner/repo --add-label agent:drill-me" ]; then
      echo "unexpected issue edit call: $*" >&2
      exit 1
    fi
    ;;
  "issue view")
    if [ "$3" = "889" ] && [ "$4" = "--repo" ] && [ "$5" = "owner/repo" ] && [ "$6" = "--json" ] && [ "$7" = "comments" ]; then
      printf 'true\n'
    elif [ "$3" = "889" ] && [ "$4" = "--repo" ] && [ "$5" = "owner/repo" ] && [ "$6" = "--json" ] && [ "$7" = "labels" ]; then
      printf 'false\n'
    else
      echo "unexpected issue view call: $*" >&2
      exit 1
    fi
    ;;
  "issue close")
    if [ "$*" != "issue close 889 --repo owner/repo --comment agentify drill smoke completed." ]; then
      echo "unexpected issue close call: $*" >&2
      exit 1
    fi
    ;;
  "run list")
    if [ "$3" != "--repo" ] || [ "$4" != "owner/repo" ] \
      || [ "$5" != "--workflow" ] || [ "$6" != "agent-drill-me-issue.yml" ] \
      || [ "$7" != "--event" ] || [ "$8" != "issues" ] \
      || [ "${9:-}" != "--limit" ] || [ "${10:-}" != "20" ] \
      || [ "${11:-}" != "--json" ] || [ "${12:-}" != "url,createdAt" ] \
      || [ "${13:-}" != "--jq" ] || [[ "${14:-}" != *'createdAt >='* ]]; then
      echo "unexpected run list call: $*" >&2
      exit 1
    fi
    printf 'https://github.com/owner/repo/actions/runs/889\n'
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$bin_dir/gh"

export CALLS_LOG="$calls"
export BODY_FILE="$tmp/body.md"
evidence_file="$tmp/evidence.json"
PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$BODY_FILE" --evidence-file "$evidence_file"

grep -q 'gh auth status' "$calls"
grep -q 'gh workflow view agent-drill-me-issue.yml --repo owner/repo' "$calls"
grep -q 'gh label list --repo owner/repo --json name --jq .\[\]\.name' "$calls"
grep -q 'gh variable list --repo owner/repo --json name --jq .\[\]\.name' "$calls"
grep -q 'gh issue edit 889 --repo owner/repo --add-label agent:drill-me' "$calls"
grep -q 'gh run list --repo owner/repo --workflow agent-drill-me-issue.yml --event issues --limit 20 --json url,createdAt --jq' "$calls"
grep -q 'createdAt >=' "$calls"
grep -q 'gh issue close 889 --repo owner/repo --comment agentify drill smoke completed.' "$calls"
jq -e '
  .schema == "agentify.smoke-evidence.v1" and
  .gate == "drill_preflight" and
  .repo == "owner/repo" and
  .result == "passed" and
  (.commit_sha | test("^[0-9a-f]{40}$")) and
  .issue_url == "https://github.com/owner/repo/issues/889" and
  .workflow_url == "https://github.com/owner/repo/actions/runs/889"
' "$evidence_file" >/dev/null

export LABELS_OUTPUT="agent:implement"
if CALLS_LOG="$calls" BODY_FILE="$tmp/missing-label-body.md" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/missing-label-body.md" >/dev/null 2>&1; then
  echo "missing agent:drill-me label should fail" >&2
  exit 1
fi

unset LABELS_OUTPUT
export SECRETS_OUTPUT=""
if CALLS_LOG="$calls" BODY_FILE="$tmp/missing-secret-body.md" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/missing-secret-body.md" >/dev/null 2>&1; then
  echo "missing AGENT_PAT secret should fail" >&2
  exit 1
fi

unset SECRETS_OUTPUT
export VARIABLES_OUTPUT=""
if CALLS_LOG="$calls" BODY_FILE="$tmp/missing-variable-body.md" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/missing-variable-body.md" >/dev/null 2>&1; then
  echo "missing AGENT_BOT_LOGIN variable should fail" >&2
  exit 1
fi

echo "GitHub drill smoke script passed."
