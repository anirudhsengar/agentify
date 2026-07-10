#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
smoke="$repo_root/.github/scripts/smoke-refresh-github-runtime.sh"
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
    if [ "$*" = "repo view owner/repo --json nameWithOwner --jq .nameWithOwner" ]; then
      printf 'owner/repo\n'
    elif [ "$*" = "repo view owner/repo --json defaultBranchRef --jq .defaultBranchRef.name" ]; then
      printf 'main\n'
    else
      echo "unexpected repo view call: $*" >&2
      exit 1
    fi
    ;;
  "secret list")
    printf '%s\n' "${SECRETS_OUTPUT:-PI_API_KEY
AGENT_PAT}"
    ;;
  "variable list")
    printf '%s\n' "${VARIABLES_OUTPUT:-PI_VERSION
PI_MODEL}"
    ;;
  "workflow view")
    if [ "$*" != "workflow view agent-refresh-surface.yml --repo owner/repo" ]; then
      echo "unexpected workflow view call: $*" >&2
      exit 1
    fi
    ;;
  "workflow run")
    if [ "$*" != "workflow run agent-refresh-surface.yml --repo owner/repo --ref main" ]; then
      echo "unexpected workflow run call: $*" >&2
      exit 1
    fi
    ;;
  "run list")
    if [ "$3" = "--repo" ] && [ "$4" = "owner/repo" ] \
      && [ "$5" = "--workflow" ] && [ "$6" = "agent-refresh-surface.yml" ] \
      && [ "$7" = "--branch" ] && [ "$8" = "main" ] \
      && [ "${9:-}" = "--event" ] && [ "${10:-}" = "workflow_dispatch" ] \
      && [ "${11:-}" = "--limit" ] && [ "${12:-}" = "20" ] \
      && [ "${13:-}" = "--json" ] && [ "${14:-}" = "status,conclusion,url,createdAt" ] \
      && [ "${15:-}" = "--jq" ] && [[ "${16:-}" == *'createdAt >='* ]]; then
      case "${REFRESH_RESULT:-success}" in
        success) printf 'completed\tsuccess\thttps://github.com/owner/repo/actions/runs/999\n' ;;
        failure) printf 'completed\tfailure\thttps://github.com/owner/repo/actions/runs/999\n' ;;
        pending) printf 'in_progress\t\thttps://github.com/owner/repo/actions/runs/999\n' ;;
        *) echo "unexpected REFRESH_RESULT: $REFRESH_RESULT" >&2; exit 1 ;;
      esac
    else
      echo "unexpected run list call: $*" >&2
      exit 1
    fi
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
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 >/dev/null 2>&1; then
  echo "refresh smoke should require explicit confirmation" >&2
  exit 1
fi

PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --confirm-model-run --evidence-file "$evidence_file"

grep -q 'gh workflow view agent-refresh-surface.yml --repo owner/repo' "$calls"
grep -q 'gh workflow run agent-refresh-surface.yml --repo owner/repo --ref main' "$calls"
grep -q 'gh run list --repo owner/repo --workflow agent-refresh-surface.yml --branch main --event workflow_dispatch --limit 20 --json status,conclusion,url,createdAt --jq' "$calls"
grep -q 'createdAt >=' "$calls"
jq -e '
  .schema == "agentify.smoke-evidence.v1" and
  .gate == "model_refresh" and
  .repo == "owner/repo" and
  .result == "passed" and
  (.commit_sha | test("^[0-9a-f]{40}$")) and
  .workflow_url == "https://github.com/owner/repo/actions/runs/999"
' "$evidence_file" >/dev/null

if CALLS_LOG="$calls" REFRESH_RESULT="failure" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --confirm-model-run >/dev/null 2>&1; then
  echo "failed refresh workflow should fail" >&2
  exit 1
fi

if CALLS_LOG="$calls" SECRETS_OUTPUT="PI_API_KEY" PATH="$bin_dir:$PATH" \
  bash "$smoke" --repo owner/repo --timeout 5 --poll 0 --confirm-model-run >/dev/null 2>&1; then
  echo "missing AGENT_PAT should fail" >&2
  exit 1
fi

echo "model-backed refresh smoke script passed."
