#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
smoke="$repo_root/.github/scripts/smoke-retry-github-runtime.sh"
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
    if [ "$*" != "workflow view agent-command.yml --repo owner/repo" ]; then
      echo "unexpected workflow view call: $*" >&2
      exit 1
    fi
    ;;
  "label list")
    printf '%s\n' "${LABELS_OUTPUT:-agent:blocked
agent:implement
agent:in-progress}"
    ;;
  "secret list")
    if [ "${SECRETS_OUTPUT+x}" = x ]; then
      printf '%s\n' "$SECRETS_OUTPUT"
    else
      printf 'AGENT_PAT\n'
    fi
    ;;
  "issue create")
    if [ "$*" != "issue create --repo owner/repo --title agentify retry smoke: blocked issue retry --body-file $BODY_FILE" ]; then
      echo "unexpected issue create call: $*" >&2
      exit 1
    fi
    grep -q 'agentify-retry-smoke' "$BODY_FILE"
    printf 'https://github.com/owner/repo/issues/888\n'
    ;;
  "issue edit")
    case "$*" in
      "issue edit 888 --repo owner/repo --add-label agent:blocked") ;;
      "issue edit 888 --repo owner/repo --add-label agent:in-progress") ;;
      *)
        echo "unexpected issue edit call: $*" >&2
        exit 1
        ;;
    esac
    ;;
  "issue comment")
    case "$*" in
      "issue comment 888 --repo owner/repo --body /agent retry") ;;
      *)
        echo "unexpected issue comment call: $*" >&2
        exit 1
        ;;
    esac
    ;;
  "issue view")
    if [ "$3" = "888" ] && [ "$4" = "--repo" ] && [ "$5" = "owner/repo" ] && [ "$6" = "--json" ] && [ "$7" = "comments" ]; then
      printf 'true\n'
    elif [ "$3" = "888" ] && [ "$4" = "--repo" ] && [ "$5" = "owner/repo" ] && [ "$6" = "--json" ] && [ "$7" = "labels" ]; then
      printf 'false\n'
    else
      echo "unexpected issue view call: $*" >&2
      exit 1
    fi
    ;;
  "issue close")
    if [ "$*" != "issue close 888 --repo owner/repo --comment agentify retry smoke completed." ]; then
      echo "unexpected issue close call: $*" >&2
      exit 1
    fi
    ;;
  "run list")
    if [ "$3" != "--repo" ] || [ "$4" != "owner/repo" ] \
      || [ "$5" != "--workflow" ] || [ "$6" != "agent-command.yml" ] \
      || [ "$7" != "--event" ] || [ "$8" != "issue_comment" ] \
      || [ "${9:-}" != "--limit" ] || [ "${10:-}" != "20" ] \
      || [ "${11:-}" != "--json" ] || [ "${12:-}" != "url,createdAt" ] \
      || [ "${13:-}" != "--jq" ] || [[ "${14:-}" != *'createdAt >='* ]]; then
      echo "unexpected run list call: $*" >&2
      exit 1
    fi
    printf 'https://github.com/owner/repo/actions/runs/888\n'
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
grep -q 'gh workflow view agent-command.yml --repo owner/repo' "$calls"
grep -q 'gh issue edit 888 --repo owner/repo --add-label agent:blocked' "$calls"
grep -q 'gh issue edit 888 --repo owner/repo --add-label agent:in-progress' "$calls"
grep -q 'gh issue comment 888 --repo owner/repo --body /agent retry' "$calls"
grep -q 'gh run list --repo owner/repo --workflow agent-command.yml --event issue_comment --limit 20 --json url,createdAt --jq' "$calls"
grep -q 'createdAt >=' "$calls"
grep -q 'gh issue close 888 --repo owner/repo --comment agentify retry smoke completed.' "$calls"
jq -e '
  .schema == "agentify.smoke-evidence.v1" and
  .gate == "retry_command" and
  .repo == "owner/repo" and
  .result == "passed" and
  (.commit_sha | test("^[0-9a-f]{40}$")) and
  .issue_url == "https://github.com/owner/repo/issues/888" and
  .workflow_url == "https://github.com/owner/repo/actions/runs/888"
' "$evidence_file" >/dev/null

export LABELS_OUTPUT="agent:blocked"
if CALLS_LOG="$calls" BODY_FILE="$tmp/missing-label-body.md" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/missing-label-body.md" >/dev/null 2>&1; then
  echo "missing agent:implement label should fail" >&2
  exit 1
fi

unset LABELS_OUTPUT
export SECRETS_OUTPUT=""
if CALLS_LOG="$calls" BODY_FILE="$tmp/missing-secret-body.md" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/missing-secret-body.md" >/dev/null 2>&1; then
  echo "missing AGENT_PAT secret should fail" >&2
  exit 1
fi

echo "GitHub retry smoke script passed."
