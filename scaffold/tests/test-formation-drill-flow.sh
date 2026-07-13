#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "$1 $2" in
  "issue list")
    printf '[]\n'
    ;;
  "issue edit"|"issue comment")
    printf '%s\n' "$*" >> "$GH_ROUTE_CAPTURE"
    ;;
  "issue create")
    body_file=""
    label=""
    title=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --body-file)
          shift
          body_file=$1
          ;;
        --label)
          shift
          label=$1
          ;;
        --title)
          shift
          title=$1
          ;;
      esac
      shift || true
    done
    printf '%s\n' "$label" > "$GH_LABEL_CAPTURE"
    printf '%s\n' "$title" > "$GH_TITLE_CAPTURE"
    cat "$body_file" > "$GH_BODY_CAPTURE"
    printf 'https://github.com/owner/repo/issues/34\n'
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

state_name="green"
state_name="${state_name}field-state.json"
mkdir -p "$tmp/.pi/agentify"
cat > "$tmp/.pi/agentify/manifest.json" <<'JSON'
{"schema_version":"1","files":[]}
JSON

cat > "$tmp/.pi/agentify/$state_name" <<'JSON'
{
  "schema_version": "1",
  "updated_at": "2026-07-06T00:00:00.000Z",
  "checkpoint": "plan",
  "turns": 4,
  "cost_usd": null,
  "aborted": false,
  "checkpoints": {
    "wide_idea": true,
    "goals": true,
    "prd": true,
    "plan": true,
    "issue_slices": false,
    "spec": false
  },
  "next_actions": [
    "Ask for approval on the first implementation slice breakdown."
  ],
  "artifact_validation": {
    "ok": true,
    "reasons": []
  },
  "resume": {
    "source": "formation",
    "stop_at": "plan",
    "current_focus": "Process invoices end to end",
    "artifact_paths": [
      "GOALS.md",
      "docs/prds/first.md",
      "docs/plans/first.md"
    ],
    "local_resume": "Resume local formation with /to-issues.",
    "github_resume": "Open an agent:drill-me issue that asks for slice approval, then create agent:queued issues."
  }
}
JSON

export FORMATION_RESUME_CONTEXT
FORMATION_RESUME_CONTEXT="$(bash "$repo_root/.github/scripts/render-formation-resume-context.sh" "$tmp")"
export EVENT_NAME=issues
export EVENT_ID=formation-flow-1
export ISSUE_NUMBER=12
export ISSUE_TITLE="Continue formation"
export BRANCH=agent/drill-me-12-continue-formation
export REPO_OWNER=owner
export REPO_NAME=repo
export GH_TOKEN=gh-test
export GH_REPO=owner/repo
export GH_LABEL_CAPTURE="$tmp/gh-label.txt"
export GH_TITLE_CAPTURE="$tmp/gh-title.txt"
export GH_BODY_CAPTURE="$tmp/gh-body.md"
export GH_ROUTE_CAPTURE="$tmp/gh-route.txt"
export GITHUB_REPOSITORY=owner/repo

prompt="$tmp/drill-prompt.md"
envsubst < "$repo_root/.github/agent-prompts/drill-me-issue.md" > "$prompt"

grep -q '## Formation Resume Context' "$prompt"
grep -q 'Checkpoint: `plan`' "$prompt"
grep -q 'Approved stop_at: `plan`' "$prompt"
grep -q 'Current focus: Process invoices end to end' "$prompt"
grep -q 'docs/plans/first.md' "$prompt"
grep -q 'create agent:queued issues' "$prompt"
if grep -q 'FORMATION_RESUME_CONTEXT' "$prompt"; then
  echo "formation resume placeholder was not substituted" >&2
  exit 1
fi

transcript="$tmp/transcript.txt"
comment="$tmp/comment.md"
summary="$tmp/summary.md"

cat > "$transcript" <<'EOF'
The approved breakdown can now be published as queued implementation work.

<output>
{
  "reply": "The approved implementation slice is ready. The workflow will create or reuse the queued issue and append its link below.",
  "state": "awaiting_issue_approval",
  "filesChanged": false,
  "childIssues": [],
  "prdIssues": [],
  "implementationIssues": [
    {
      "slug": "import-invoices",
      "title": "Import invoices",
      "body": "## What to build\n\nCreate the first invoice import slice.\n\n## Acceptance criteria\n\n- The CLI accepts one fixture path.\n- The command prints a deterministic invoice summary.\n\n## Blocked by\n\nNone - can start immediately."
    }
  ]
}
</output>
EOF

bash "$repo_root/.github/scripts/apply-drill-issues.sh" "$transcript" 12 "$summary"
bash "$repo_root/.github/scripts/render-drill-reply.sh" "$transcript" "$comment" "agentify-event:formation-flow-1" "$summary"
grep -q '^agent:queued$' "$GH_LABEL_CAPTURE"
grep -q '^Import invoices$' "$GH_TITLE_CAPTURE"
grep -q 'agentify-source:issue-12-slice-import-invoices' "$GH_BODY_CAPTURE"
grep -q '#34 Import invoices (`agent:queued`)' "$comment"
grep -q '<!-- agentify-event:formation-flow-1 agentify-state:awaiting_issue_approval -->' "$comment"

bash "$repo_root/.github/scripts/route-agent-command.sh" "/agent implement" "34" "false"
grep -q 'issue edit 34 --repo owner/repo --add-label agent:implement' "$GH_ROUTE_CAPTURE"
grep -q 'issue comment 34 --repo owner/repo --body Queued implementation' "$GH_ROUTE_CAPTURE"
