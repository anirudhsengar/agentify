#!/usr/bin/env bash
set -euo pipefail

issue_number=${1:?usage: check-issue-ready.sh ISSUE_NUMBER [ACTOR]}
# Optional second arg: the actor who applied agent:implement. When
# provided (with GH_REPO in the environment), the run is refused unless
# that actor has write access to the repository. This stops an outside
# user from triggering a write-capable, secret-bearing agent run just by
# adding a label.
actor=${2:-}
if [ -n "$actor" ] && [ -n "${GH_REPO:-}" ]; then
  permission=$(gh api "repos/${GH_REPO}/collaborators/${actor}/permission" \
    --jq '.permission' 2>/dev/null || echo "none")
  case "$permission" in
    admin|write|maintain) ;;
    *)
      echo "Actor ${actor} has '${permission}' permission — refusing a write-capable agent run."
      exit 4
      ;;
  esac
fi

issue_json=$(gh issue view "$issue_number" --json body,labels)

if ! jq -e 'any(.labels[]?; .name == "agent:queued")' <<<"$issue_json" >/dev/null; then
  echo "Issue #${issue_number} is not labeled agent:queued."
  exit 2
fi

body=$(jq -r '.body // ""' <<<"$issue_json")
blocked_by=$(
  awk '
    /^##[[:space:]]+Blocked by[[:space:]]*$/ { in_section = 1; next }
    in_section && /^##[[:space:]]+/ { exit }
    in_section { print }
  ' <<<"$body"
)

mapfile -t blockers < <(grep -oE '#[0-9]+' <<<"$blocked_by" | sort -u || true)
open_blockers=()

for blocker in "${blockers[@]}"; do
  blocker_number=${blocker#\#}
  state=$(gh issue view "$blocker_number" --json state --jq '.state')
  if [ "$state" != "CLOSED" ]; then
    open_blockers+=("$blocker")
  fi
done

if [ "${#open_blockers[@]}" -gt 0 ]; then
  echo "Issue #${issue_number} is blocked by open issue(s): ${open_blockers[*]}."
  exit 3
fi

echo "Issue #${issue_number} is agent-ready."
