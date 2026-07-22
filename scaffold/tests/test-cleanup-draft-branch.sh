#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); cleanup="$root/.github/scripts/cleanup-draft-branch.sh"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [ "$1 $2" = "repo view" ]; then echo "${DEFAULT_BRANCH:-main}"; elif [ "$1" = api ]; then [ "${PROTECTED:-0}" = 1 ]; elif [ "$1 $2" = "pr list" ]; then echo "${ACTIVE_PRS:-0}"; fi
EOF
cat > "$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
[ "$1" = check-ref-format ] || printf 'git %s\n' "$*" >> "$CALLS"
EOF
chmod +x "$tmp/bin/gh" "$tmp/bin/git"; state="$tmp/state"; printf '{"remote_branches":[{"branch":"agent/draft-42-run-change","owned":true,"associated_pr":null,"status":"orphaned"}]}' > "$state"
envs=(PATH="$tmp/bin:$PATH" GH_REPO=owner/repo GH_TOKEN=token CALLS="$tmp/calls")
env "${envs[@]}" bash "$cleanup" "$state" agent/draft-42-run-change --confirm; grep -q 'git push origin --delete agent/draft-42-run-change' "$tmp/calls"; jq -e '.remote_branches[0].status=="deleted"' "$state" >/dev/null
printf '{"remote_branches":[]}' > "$state"; if env "${envs[@]}" bash "$cleanup" "$state" feature/user --confirm >/dev/null 2>&1; then exit 1; fi
printf '{"remote_branches":[{"branch":"agent/draft-42-run-change","owned":true,"associated_pr":null,"status":"orphaned"}]}' > "$state"
if DEFAULT_BRANCH=agent/draft-42-run-change env "${envs[@]}" bash "$cleanup" "$state" agent/draft-42-run-change --confirm >/dev/null 2>&1; then exit 1; fi
if PROTECTED=1 env "${envs[@]}" bash "$cleanup" "$state" agent/draft-42-run-change --confirm >/dev/null 2>&1; then exit 1; fi
if ACTIVE_PRS=1 env "${envs[@]}" bash "$cleanup" "$state" agent/draft-42-run-change --confirm >/dev/null 2>&1; then exit 1; fi
if env "${envs[@]}" bash "$cleanup" "$state" agent/draft-42-run-change nope >/dev/null 2>&1; then exit 1; fi
