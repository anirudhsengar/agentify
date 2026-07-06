#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pusher="$repo_root/.github/scripts/push-updated-branch.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

calls="$tmp/calls.log"
bin_dir="$tmp/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/gh" <<'EOF'
#!/usr/bin/env bash
if [ "${GH_TOKEN:-}" != "agent-token" ]; then
  echo "expected GH_TOKEN to be set from AGENT_PAT" >&2
  exit 1
fi
printf 'gh %s\n' "$*" >> "$CALLS_LOG"
EOF
chmod +x "$bin_dir/gh"

cat > "$bin_dir/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$CALLS_LOG"
if [ "${GIT_PUSH_FAIL:-}" = "stale" ]; then
  echo "To github.com:owner/repo.git" >&2
  echo " ! [rejected] agent/issue-42 -> agent/issue-42 (stale info)" >&2
  exit 1
fi
if [ "${GIT_PUSH_FAIL:-}" = "generic" ]; then
  echo "permission denied" >&2
  exit 2
fi
EOF
chmod +x "$bin_dir/git"

reason="$tmp/failure_reason.txt"
CALLS_LOG="$calls" \
PATH="$bin_dir:$PATH" \
AGENT_PAT="agent-token" \
  bash "$pusher" "agent/issue-42" "abc123" "$reason"

grep -q 'gh auth setup-git' "$calls" || {
  echo "expected gh auth setup-git" >&2
  exit 1
}
grep -q 'git push --force-with-lease=refs/heads/agent/issue-42:abc123 origin agent/issue-42' "$calls" || {
  echo "expected force-with-lease push" >&2
  exit 1
}
if [ -f "$reason" ]; then
  echo "successful push must not write a failure reason" >&2
  exit 1
fi

: > "$calls"
if CALLS_LOG="$calls" \
  PATH="$bin_dir:$PATH" \
  AGENT_PAT="agent-token" \
  GIT_PUSH_FAIL="stale" \
  bash "$pusher" "agent/issue-42" "abc123" "$reason" >/dev/null 2>&1; then
  echo "expected stale push to fail" >&2
  exit 1
fi
grep -q 'Branch advanced during update-branch run.' "$reason" || {
  echo "expected stale branch failure reason" >&2
  exit 1
}

if CALLS_LOG="$calls" PATH="$bin_dir:$PATH" AGENT_PAT="agent-token" \
  bash "$pusher" "main" "abc123" "$reason" >/dev/null 2>&1; then
  echo "expected non-agent branch push to fail" >&2
  exit 1
fi

if CALLS_LOG="$calls" PATH="$bin_dir:$PATH" \
  bash "$pusher" "agent/issue-42" "abc123" "$reason" >/dev/null 2>&1; then
  echo "expected missing AGENT_PAT to fail" >&2
  exit 1
fi
