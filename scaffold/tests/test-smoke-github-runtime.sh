#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
smoke="$repo_root/.github/scripts/smoke-github-runtime.sh"
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
    if [ "$*" != "workflow view agent-implement.yml --repo owner/repo" ]; then
      echo "unexpected workflow view call: $*" >&2
      exit 1
    fi
    if [ "${WORKFLOW_MISSING:-0}" = "1" ]; then
      exit 1
    fi
    ;;
  "label list")
    printf '%s\n' "${LABELS_OUTPUT:-agent:implement}"
    ;;
  "issue create")
    if [ "$*" != "issue create --repo owner/repo --title agentify live smoke: implement preflight refusal --body-file $BODY_FILE" ]; then
      echo "unexpected issue create call: $*" >&2
      exit 1
    fi
    grep -q 'agentify-live-smoke' "$BODY_FILE"
    printf 'https://github.com/owner/repo/issues/777\n'
    ;;
  "issue edit")
    if [ "$*" != "issue edit 777 --repo owner/repo --add-label agent:implement" ]; then
      echo "unexpected issue edit call: $*" >&2
      exit 1
    fi
    ;;
  "issue view")
    if [ "$3" = "777" ] && [ "$4" = "--repo" ] && [ "$5" = "owner/repo" ] && [ "$6" = "--json" ] && [ "$7" = "comments" ]; then
      printf 'true\n'
    elif [ "$3" = "777" ] && [ "$4" = "--repo" ] && [ "$5" = "owner/repo" ] && [ "$6" = "--json" ] && [ "$7" = "labels" ]; then
      printf 'false\n'
    else
      echo "unexpected issue view call: $*" >&2
      exit 1
    fi
    ;;
  "issue close")
    if [ "$*" != "issue close 777 --repo owner/repo --comment agentify live smoke completed." ]; then
      echo "unexpected issue close call: $*" >&2
      exit 1
    fi
    ;;
  "run list")
    if [ "$3" != "--repo" ] || [ "$4" != "owner/repo" ] \
      || [ "$5" != "--workflow" ] || [ "$6" != "agent-implement.yml" ] \
      || [ "$7" != "--event" ] || [ "$8" != "issues" ] \
      || [ "${9:-}" != "--limit" ] || [ "${10:-}" != "20" ] \
      || [ "${11:-}" != "--json" ] || [ "${12:-}" != "url,createdAt" ] \
      || [ "${13:-}" != "--jq" ] || [[ "${14:-}" != *'createdAt >='* ]]; then
      echo "unexpected run list call: $*" >&2
      exit 1
    fi
    printf 'https://github.com/owner/repo/actions/runs/999\n'
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
grep -q 'gh workflow view agent-implement.yml --repo owner/repo' "$calls"
grep -q 'gh label list --repo owner/repo --json name --jq .\[\]\.name' "$calls"
grep -q 'gh issue edit 777 --repo owner/repo --add-label agent:implement' "$calls"
grep -q 'gh run list --repo owner/repo --workflow agent-implement.yml --event issues --limit 20 --json url,createdAt --jq' "$calls"
grep -q 'createdAt >=' "$calls"
grep -q 'gh issue close 777 --repo owner/repo --comment agentify live smoke completed.' "$calls"
jq -e '
  .schema == "agentify.smoke-evidence.v1" and
  .gate == "implement_preflight" and
  .repo == "owner/repo" and
  .result == "passed" and
  (.commit_sha | test("^[0-9a-f]{40}$")) and
  .issue_url == "https://github.com/owner/repo/issues/777" and
  .workflow_url == "https://github.com/owner/repo/actions/runs/999"
' "$evidence_file" >/dev/null

missing_workflow_calls="$tmp/missing-workflow-calls.log"
if WORKFLOW_MISSING=1 CALLS_LOG="$missing_workflow_calls" BODY_FILE="$tmp/missing-workflow-body.md" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/missing-workflow-body.md" >/dev/null 2>&1; then
  echo "missing agent-implement.yml workflow should fail" >&2
  exit 1
fi
grep -q 'gh workflow view agent-implement.yml --repo owner/repo' "$missing_workflow_calls"
if grep -q 'gh issue create' "$missing_workflow_calls"; then
  echo "missing workflow preflight should fail before creating a smoke issue" >&2
  exit 1
fi

export LABELS_OUTPUT="agent:queued"
if CALLS_LOG="$calls" BODY_FILE="$tmp/missing-label-body.md" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/missing-label-body.md" >/dev/null 2>&1; then
  echo "missing agent:implement label should fail" >&2
  exit 1
fi

echo "GitHub runtime smoke script passed."
