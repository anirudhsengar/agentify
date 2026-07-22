#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); publisher="$root/.github/scripts/publish-implementation-pr.sh"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"; calls="$tmp/calls"
cat > "$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$CALLS"
case "$1" in rev-parse) echo "${LOCAL_SHA:-abc123}";; ls-remote) [[ "$*" == *refs/heads/main* ]] && echo "${BASE_SHA:-base123} refs/heads/main" || { [ -z "${REMOTE_SHA:-}" ] || echo "$REMOTE_SHA refs/heads/x"; };; check-ref-format) exit 0;; push) exit 0;; esac
EOF
cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >> "$CALLS"
if [ "$1 $2" = "pr list" ]; then
  if [ "${PR_MODE:-none}" = owned ]; then printf '%s\n' '[{"number":123,"url":"https://github.com/owner/repo/pull/123","isDraft":true,"body":"Closes #42\n<!-- agentify:draft engagement=eng issue=42 branch=agent/draft-42-900-1-change -->","headRefName":"agent/draft-42-900-1-change","baseRefName":"main"}]';
  elif [ "${PR_MODE:-none}" = mismatch ]; then printf '%s\n' '[{"number":99,"url":"https://github.com/owner/repo/pull/99","isDraft":true,"body":"other","headRefName":"agent/draft-42-900-1-change","baseRefName":"main"}]';
  elif [ "${CREATED:-0}" = 1 ] || [ -f "${CREATED_FILE:-/nonexistent}" ]; then touch "$CREATED_FILE"; printf '%s\n' '[{"number":123,"url":"https://github.com/owner/repo/pull/123","isDraft":true,"body":"Closes #42\n<!-- agentify:draft engagement=eng issue=42 branch=agent/draft-42-900-1-change -->","headRefName":"agent/draft-42-900-1-change","baseRefName":"main"}]'; else printf '[]\n'; fi
elif [ "$1 $2" = "pr create" ]; then touch "$CREATED_FILE"; [ "${CREATE_FAIL:-0}" = 0 ] || exit 1; fi
EOF
chmod +x "$tmp/bin/git" "$tmp/bin/gh"
title="$tmp/title"; body="$tmp/body"; printf 'change\n' > "$title"; printf 'Closes #42\n' > "$body"
fresh_state() { node "$root/.github/scripts/draft-run-control.mjs" init "$1" "$tmp/config"; jq '.publication.engagement_id="eng"' "$1" > "$1.x"; mv "$1.x" "$1"; }
printf '{"maximum_runtime_ms":60000,"maximum_cost_usd":5,"engagement_id":"eng","pricing_policy":{"version":"v1","models":[]}}\n' > "$tmp/config"
run_publish() { CALLS="$calls" CREATED_FILE="$tmp/created" PATH="$tmp/bin:$PATH" AGENT_PAT=token GH_REPO=owner/repo bash "$publisher" "agent/draft-42-900-1-change" main base123 abc123 "$title" "$body" "$1" "$2"; }
state="$tmp/state"; output="$tmp/output"; fresh_state "$state"; run_publish "$state" "$output"; grep -q '^pr_number=123$' "$output"; jq -e '.publication.status=="publication_recorded" and .publication.pr_number==123 and .remote_branches[0].status=="active"' "$state" >/dev/null
grep -q 'gh pr list .* --state all ' "$calls"
before=$(grep -c 'gh pr create' "$calls"); retry="$tmp/retry"; run_publish "$state" "$retry"; after=$(grep -c 'gh pr create' "$calls"); [ "$before" -eq "$after" ]; grep -q '^pr_number=123$' "$retry"
rm -f "$tmp/created"; conflict="$tmp/conflict"; fresh_state "$conflict"; if PR_MODE=mismatch CALLS="$calls" PATH="$tmp/bin:$PATH" AGENT_PAT=token GH_REPO=owner/repo bash "$publisher" "agent/draft-42-900-1-change" main base123 abc123 "$title" "$body" "$conflict" "$tmp/no" >/dev/null 2>&1; then exit 1; fi; jq -e '.publication.status=="ownership_conflict"' "$conflict" >/dev/null
rm -f "$tmp/created"; crash="$tmp/crash"; fresh_state "$crash"; CREATE_FAIL=1 run_publish "$crash" "$tmp/crash-out"; grep -q '^pr_number=123$' "$tmp/crash-out"; [ "$(grep -c 'gh pr create' "$calls")" -ge 2 ]
if CALLS="$calls" PATH="$tmp/bin:$PATH" AGENT_PAT=token GH_REPO=owner/repo bash "$publisher" main main base123 abc123 "$title" "$body" "$state" "$tmp/no" >/dev/null 2>&1; then exit 1; fi
expired="$tmp/expired"; fresh_state "$expired"; jq '.runtime.deadline_at="2000-01-01T00:00:00.000Z"' "$expired" > "$expired.x"; mv "$expired.x" "$expired"; before=$(grep -c 'gh pr create' "$calls"); if CALLS="$calls" PATH="$tmp/bin:$PATH" AGENT_PAT=token GH_REPO=owner/repo bash "$publisher" "agent/draft-42-900-1-change" main base123 abc123 "$title" "$body" "$expired" "$tmp/no" >/dev/null 2>&1; then exit 1; fi; after=$(grep -c 'gh pr create' "$calls"); [ "$before" -eq "$after" ]
fresh_state "$tmp/base-mismatch"; if CALLS="$calls" PATH="$tmp/bin:$PATH" AGENT_PAT=token GH_REPO=owner/repo BASE_SHA=moved bash "$publisher" "agent/draft-42-900-1-change" main base123 abc123 "$title" "$body" "$tmp/base-mismatch" "$tmp/no" >/dev/null 2>&1; then exit 1; fi
fresh_state "$tmp/head-mismatch"; if CALLS="$calls" PATH="$tmp/bin:$PATH" AGENT_PAT=token GH_REPO=owner/repo LOCAL_SHA=moved bash "$publisher" "agent/draft-42-900-1-change" main base123 abc123 "$title" "$body" "$tmp/head-mismatch" "$tmp/no" >/dev/null 2>&1; then exit 1; fi
