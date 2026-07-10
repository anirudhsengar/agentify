#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
applier="$repo_root/.github/scripts/apply-drill-issues.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "$1 $2" in
  "issue list")
    search=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --search)
          shift
          search=$1
          ;;
      esac
      shift || true
    done
    if [[ "$search" == *"subgoal-existing-child"* ]]; then
      printf '%s\n' '[{"number":21,"url":"https://github.com/owner/repo/issues/21","title":"Existing child issue"}]'
    elif [[ "$search" == *"slice-existing-blocked"* ]]; then
      printf '%s\n' '[{"number":43,"url":"https://github.com/owner/repo/issues/43","title":"Existing blocked slice"}]'
    else
      printf '[]\n'
    fi
    ;;
  "issue create")
    label=""
    title=""
    body_file=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --label)
          shift
          label=$1
          ;;
        --title)
          shift
          title=$1
          ;;
        --body-file)
          shift
          body_file=$1
          ;;
      esac
      shift || true
    done
    printf '%s|%s\n' "$label" "$title" >> "$GH_CREATE_CAPTURE"
    cat "$body_file" >> "$GH_BODY_CAPTURE"
    printf '\n---\n' >> "$GH_BODY_CAPTURE"
    case "$label" in
      artifact:prd) printf 'https://github.com/owner/repo/issues/41\n' ;;
      agent:queued) printf 'https://github.com/owner/repo/issues/42\n' ;;
      *) printf 'unexpected label: %s\n' "$label" >&2; exit 1 ;;
    esac
    ;;
  "issue edit")
    number=$3
    shift 3
    labels=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --add-label)
          shift
          labels="${labels}${labels:+,}$1"
          ;;
      esac
      shift || true
    done
    printf '%s|%s\n' "$number" "$labels" >> "$GH_EDIT_CAPTURE"
    ;;
  "issue view")
    number=$3
    if [[ "$*" == *"--json body,state"* ]]; then
      case "$number" in
        43) printf '%s\n' '{"state":"OPEN","body":"## What to build\n\nExisting body.\n\n## Acceptance criteria\n\n- Existing criteria.\n\n## Blocked by\n\n- #7"}' ;;
        *) printf '%s\n' '{"state":"OPEN","body":"## Blocked by\n\nNone - can start immediately."}' ;;
      esac
      exit 0
    fi
    case "$number" in
      7) printf 'OPEN\n' ;;
      8) printf 'CLOSED\n' ;;
      *) printf 'unexpected issue view: %s\n' "$number" >&2; exit 1 ;;
    esac
    ;;
  *)
    printf 'unexpected gh invocation: %q ' "$@" >&2
    printf '\n' >&2
    exit 1
    ;;
esac
SH
chmod +x "$tmp/bin/gh"

export PATH="$tmp/bin:$PATH"
export GH_TOKEN=gh-test
export GH_REPO=owner/repo
export GH_CREATE_CAPTURE="$tmp/created.txt"
export GH_EDIT_CAPTURE="$tmp/edited.txt"
export GH_BODY_CAPTURE="$tmp/bodies.md"

transcript="$tmp/transcript.txt"
summary="$tmp/summary.md"

cat > "$transcript" <<'EOF'
<output>
{
  "reply": "The requested issues are ready.",
  "state": "ready_for_prd",
  "filesChanged": false,
  "childIssues": [
    {
      "slug": "existing-child",
      "title": "Child issue",
      "body": "Existing issue should be reused."
    }
  ],
  "prdIssues": [
    {
      "slug": "payments-prd",
      "title": "Payments PRD",
      "body": "Define the payment workflow PRD."
    }
  ],
  "implementationIssues": [
    {
      "slug": "import-invoices",
      "title": "Import invoices",
      "body": "## What to build\n\nBuild the invoice import slice.\n\n## Acceptance criteria\n\n- The importer accepts one fixture file.\n\n## Blocked by\n\nNone - can start immediately."
    },
    {
      "slug": "run-first-spec",
      "title": "Run first spec",
      "body": "## What to build\n\nRun the first approved implementation spec.\n\n## Acceptance criteria\n\n- The spec is implemented through the public CLI seam.\n\n## Blocked by\n\nNone - can start immediately.",
      "activate": true
    },
    {
      "slug": "blocked-follow-up",
      "title": "Blocked follow-up",
      "body": "## What to build\n\nRun the blocked follow-up slice.\n\n## Acceptance criteria\n\n- The follow-up behavior is covered.\n\n## Blocked by\n\n- #7\n- #8",
      "activate": true
    },
    {
      "slug": "existing-blocked",
      "title": "Existing blocked replacement title",
      "body": "## What to build\n\nThe requested body says unblocked.\n\n## Acceptance criteria\n\n- Existing issue should still be authoritative.\n\n## Blocked by\n\nNone - can start immediately.",
      "activate": true
    }
  ]
}
</output>
EOF

bash "$applier" "$transcript" 12 "$summary"

grep -q '#21 Existing child issue (`agent:drill-me`)' "$summary"
grep -q '#41 Payments PRD (`artifact:prd`)' "$summary"
grep -q '#42 Import invoices (`agent:queued`)' "$summary"
grep -q '#42 Run first spec (`agent:queued`, `agent:implement`)' "$summary"
grep -q '#42 Blocked follow-up (`agent:queued`; activation skipped: blocked by #7)' "$summary"
grep -q '#43 Existing blocked slice (`agent:queued`; activation skipped: blocked by #7)' "$summary"
grep -q '^artifact:prd|Payments PRD$' "$GH_CREATE_CAPTURE"
grep -q '^agent:queued|Import invoices$' "$GH_CREATE_CAPTURE"
grep -q '^agent:queued|Run first spec$' "$GH_CREATE_CAPTURE"
grep -q '^agent:queued|Blocked follow-up$' "$GH_CREATE_CAPTURE"
if grep -q '^agent:queued|Existing blocked replacement title$' "$GH_CREATE_CAPTURE"; then
  echo "existing blocked issue should have been reused, not recreated" >&2
  exit 1
fi
grep -q '^42|agent:queued,agent:implement$' "$GH_EDIT_CAPTURE"
[ "$(grep -c '^42|agent:queued,agent:implement$' "$GH_EDIT_CAPTURE")" -eq 1 ]
if grep -q '^43|' "$GH_EDIT_CAPTURE"; then
  echo "existing blocked issue must not be activated" >&2
  exit 1
fi
if grep -q 'agent:drill-me|Child issue' "$GH_CREATE_CAPTURE"; then
  echo "existing child issue should have been reused, not recreated" >&2
  exit 1
fi
grep -q 'agentify-source:issue-12-prd-payments-prd' "$GH_BODY_CAPTURE"
grep -q 'agentify-source:issue-12-slice-import-invoices' "$GH_BODY_CAPTURE"
grep -q '## Blocked by' "$GH_BODY_CAPTURE"

cat > "$transcript" <<'EOF'
<output>
{
  "reply": "The requested issue is malformed.",
  "state": "awaiting_issue_approval",
  "filesChanged": false,
  "childIssues": [],
  "prdIssues": [],
  "implementationIssues": [
    {
      "slug": "missing-blocker-section",
      "title": "Missing blocker section",
      "body": "## What to build\n\nBuild the malformed slice.\n\n## Acceptance criteria\n\n- Done."
    }
  ]
}
</output>
EOF

if bash "$applier" "$transcript" 12 "$summary" >/dev/null 2>&1; then
  echo "expected implementation issue without ## Blocked by to be refused" >&2
  exit 1
fi
