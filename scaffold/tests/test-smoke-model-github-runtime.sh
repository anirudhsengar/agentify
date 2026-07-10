#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
smoke="$repo_root/.github/scripts/smoke-model-github-runtime.sh"
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
    printf '%s\n' "${LABELS_OUTPUT:-agent:queued
agent:implement}"
    ;;
  "secret list")
    printf '%s\n' "${SECRETS_OUTPUT:-PI_API_KEY
AGENT_PAT}"
    ;;
  "variable list")
    if [ "${LONG_VARIABLE_LIST:-0}" = "1" ]; then
      printf 'PI_VERSION\n'
      for index in $(seq 1 1000); do
        printf 'NOISE_%s\n' "$index"
      done
      printf 'PI_MODEL\n'
    else
      printf '%s\n' "${VARIABLES_OUTPUT:-PI_VERSION
PI_MODEL}"
    fi
    ;;
  "issue create")
    if [ "$*" != "issue create --repo owner/repo --title agentify model smoke: issue to draft PR --body-file $BODY_FILE" ]; then
      echo "unexpected issue create call: $*" >&2
      exit 1
    fi
    grep -q 'agentify-model-smoke' "$BODY_FILE"
    grep -q '## What to build' "$BODY_FILE"
    grep -q '## Acceptance criteria' "$BODY_FILE"
    grep -q '## Blocked by' "$BODY_FILE"
    printf 'https://github.com/owner/repo/issues/888\n'
    ;;
  "issue edit")
    case "$*" in
      "issue edit 888 --repo owner/repo --add-label agent:queued") ;;
      "issue edit 888 --repo owner/repo --add-label agent:implement") ;;
      *)
        echo "unexpected issue edit call: $*" >&2
        exit 1
        ;;
    esac
    ;;
  "issue view")
    if [ "$3" = "888" ] && [ "$4" = "--repo" ] && [ "$5" = "owner/repo" ] && [ "$6" = "--json" ] && [ "$7" = "labels" ]; then
      if [ "${SMOKE_MODE:-success}" = "blocked" ]; then
        printf 'true\n'
      else
        printf 'false\n'
      fi
    else
      echo "unexpected issue view call: $*" >&2
      exit 1
    fi
    ;;
  "pr list")
    if [ "$3" = "--repo" ] && [ "$4" = "owner/repo" ] && [ "$5" = "--state" ] && [ "$6" = "open" ]; then
      printf '777 https://github.com/owner/repo/pull/777\n'
    else
      echo "unexpected pr list call: $*" >&2
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

if PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$BODY_FILE" >/dev/null 2>&1; then
  echo "model-backed smoke should require explicit confirmation" >&2
  exit 1
fi

PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$BODY_FILE" --confirm-model-run --evidence-file "$evidence_file"

grep -q 'gh secret list --repo owner/repo --json name --jq .\[\]\.name' "$calls"
grep -q 'gh variable list --repo owner/repo --json name --jq .\[\]\.name' "$calls"
grep -q 'gh workflow view agent-implement.yml --repo owner/repo' "$calls"
grep -q 'gh issue edit 888 --repo owner/repo --add-label agent:queued' "$calls"
grep -q 'gh issue edit 888 --repo owner/repo --add-label agent:implement' "$calls"
grep -q 'gh pr list --repo owner/repo --state open --search in:body "#888" --json number,url,isDraft,labels --jq' "$calls"
grep -q 'gh run list --repo owner/repo --workflow agent-implement.yml --event issues --limit 20 --json url,createdAt --jq' "$calls"
grep -q 'createdAt >=' "$calls"
jq -e '
  .schema == "agentify.smoke-evidence.v1" and
  .gate == "model_implementation" and
  .repo == "owner/repo" and
  .result == "passed" and
  (.commit_sha | test("^[0-9a-f]{40}$")) and
  .issue_url == "https://github.com/owner/repo/issues/888" and
  .pr_url == "https://github.com/owner/repo/pull/777" and
  .workflow_url == "https://github.com/owner/repo/actions/runs/888"
' "$evidence_file" >/dev/null

missing_workflow_calls="$tmp/missing-workflow-calls.log"
if WORKFLOW_MISSING=1 CALLS_LOG="$missing_workflow_calls" BODY_FILE="$tmp/missing-workflow-body.md" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/missing-workflow-body.md" --confirm-model-run >/dev/null 2>&1; then
  echo "missing agent-implement.yml workflow should fail" >&2
  exit 1
fi
grep -q 'gh workflow view agent-implement.yml --repo owner/repo' "$missing_workflow_calls"
if grep -q 'gh issue create' "$missing_workflow_calls"; then
  echo "missing workflow preflight should fail before creating a model smoke issue" >&2
  exit 1
fi

export SECRETS_OUTPUT="PI_API_KEY"
if CALLS_LOG="$calls" BODY_FILE="$tmp/missing-secret-body.md" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/missing-secret-body.md" --confirm-model-run >/dev/null 2>&1; then
  echo "missing AGENT_PAT should fail" >&2
  exit 1
fi

export SECRETS_OUTPUT="PI_API_KEY
AGENT_PAT"
export VARIABLES_OUTPUT="PI_VERSION
PI_MODEL"
CALLS_LOG="$tmp/no-bot-login-calls.log" BODY_FILE="$tmp/no-bot-login-body.md" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/no-bot-login-body.md" --confirm-model-run >/dev/null

unset VARIABLES_OUTPUT
CALLS_LOG="$tmp/long-variable-list-calls.log" BODY_FILE="$tmp/long-variable-list-body.md" LONG_VARIABLE_LIST=1 PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/long-variable-list-body.md" --confirm-model-run >/dev/null

if CALLS_LOG="$calls" BODY_FILE="$tmp/blocked-body.md" SMOKE_MODE="blocked" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --body-file "$tmp/blocked-body.md" --confirm-model-run >/dev/null 2>&1; then
  echo "blocked smoke issue should fail" >&2
  exit 1
fi

echo "model-backed GitHub runtime smoke script passed."
