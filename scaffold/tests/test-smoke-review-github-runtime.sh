#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
smoke="$repo_root/.github/scripts/smoke-review-github-runtime.sh"
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
    if [ "$*" != "workflow view agent-review.yml --repo owner/repo" ]; then
      echo "unexpected workflow view call: $*" >&2
      exit 1
    fi
    if [ "${WORKFLOW_MISSING:-0}" = "1" ]; then
      exit 1
    fi
    ;;
  "label list")
    printf '%s\n' "${LABELS_OUTPUT:-agent:review
agent:approved
agent:implement
agent:blocked}"
    ;;
  "secret list")
    printf '%s\n' "${SECRETS_OUTPUT:-PI_API_KEY
AGENT_PAT}"
    ;;
  "variable list")
    printf '%s\n' "${VARIABLES_OUTPUT:-PI_VERSION
PI_MODEL}"
    ;;
  "pr view")
    if [ "$3" != "777" ] || [ "$4" != "--repo" ] || [ "$5" != "owner/repo" ]; then
      echo "unexpected pr view call: $*" >&2
      exit 1
    fi
    if [ "$6" = "--json" ] && [ "$7" = "headRefName" ]; then
      printf '%s\n' "${HEAD_REF:-agent/issue-888-smoke}"
    elif [ "$6" = "--json" ] && [ "$7" = "labels" ]; then
      case "${REVIEW_RESULT:-approved}" in
        approved) printf 'approved\n' ;;
        requeued) printf 'requeued\n' ;;
        blocked) printf 'blocked\n' ;;
        pending) printf 'pending\n' ;;
        *) echo "unexpected REVIEW_RESULT: $REVIEW_RESULT" >&2; exit 1 ;;
      esac
    else
      echo "unexpected pr view args: $*" >&2
      exit 1
    fi
    ;;
  "pr edit")
    case "$*" in
      "pr edit 777 --repo owner/repo --remove-label agent:approved") ;;
      "pr edit 777 --repo owner/repo --remove-label agent:blocked") ;;
      "pr edit 777 --repo owner/repo --add-label agent:review") ;;
      *)
        echo "unexpected pr edit call: $*" >&2
        exit 1
        ;;
    esac
    ;;
  "run list")
    if [ "$3" != "--repo" ] || [ "$4" != "owner/repo" ] \
      || [ "$5" != "--workflow" ] || [ "$6" != "agent-review.yml" ] \
      || [ "$7" != "--event" ] || [ "$8" != "pull_request_target" ] \
      || [ "${9:-}" != "--limit" ] || [ "${10:-}" != "20" ] \
      || [ "${11:-}" != "--json" ] || [ "${12:-}" != "url,createdAt" ] \
      || [ "${13:-}" != "--jq" ] || [[ "${14:-}" != *'createdAt >='* ]]; then
      echo "unexpected run list call: $*" >&2
      exit 1
    fi
    printf 'https://github.com/owner/repo/actions/runs/777\n'
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$bin_dir/gh"

export CALLS_LOG="$calls"
evidence_file="$tmp/evidence.json"

if PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --pr 777 --timeout 5 --poll 0 >/dev/null 2>&1; then
  echo "review smoke should require explicit confirmation" >&2
  exit 1
fi

PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --pr 777 --timeout 5 --poll 0 --confirm-model-run --evidence-file "$evidence_file"

grep -q 'gh workflow view agent-review.yml --repo owner/repo' "$calls"
grep -q 'gh pr view 777 --repo owner/repo --json headRefName --jq .headRefName' "$calls"
grep -q 'gh pr edit 777 --repo owner/repo --add-label agent:review' "$calls"
grep -q 'gh pr view 777 --repo owner/repo --json labels --jq' "$calls"
grep -q 'gh run list --repo owner/repo --workflow agent-review.yml --event pull_request_target --limit 20 --json url,createdAt --jq' "$calls"
grep -q 'createdAt >=' "$calls"
jq -e '
  .schema == "agentify.smoke-evidence.v1" and
  .gate == "model_review" and
  .repo == "owner/repo" and
  .result == "passed" and
  (.commit_sha | test("^[0-9a-f]{40}$")) and
  .pr_url == "https://github.com/owner/repo/pull/777" and
  .workflow_url == "https://github.com/owner/repo/actions/runs/777"
' "$evidence_file" >/dev/null

missing_workflow_calls="$tmp/missing-workflow-calls.log"
if WORKFLOW_MISSING=1 CALLS_LOG="$missing_workflow_calls" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --pr 777 --timeout 5 --poll 0 --confirm-model-run >/dev/null 2>&1; then
  echo "missing agent-review.yml workflow should fail" >&2
  exit 1
fi
grep -q 'gh workflow view agent-review.yml --repo owner/repo' "$missing_workflow_calls"
if grep -q 'gh pr edit' "$missing_workflow_calls"; then
  echo "missing workflow preflight should fail before editing review labels" >&2
  exit 1
fi

if CALLS_LOG="$calls" HEAD_REF="feature/smoke" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --pr 777 --timeout 5 --poll 0 --confirm-model-run >/dev/null 2>&1; then
  echo "non-agent branch should fail" >&2
  exit 1
fi

if CALLS_LOG="$calls" SECRETS_OUTPUT="PI_API_KEY" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --pr 777 --timeout 5 --poll 0 --confirm-model-run >/dev/null 2>&1; then
  echo "missing AGENT_PAT should fail" >&2
  exit 1
fi

if CALLS_LOG="$calls" REVIEW_RESULT="blocked" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --pr 777 --timeout 5 --poll 0 --confirm-model-run >/dev/null 2>&1; then
  echo "blocked review should fail" >&2
  exit 1
fi

echo "model-backed review smoke script passed."
