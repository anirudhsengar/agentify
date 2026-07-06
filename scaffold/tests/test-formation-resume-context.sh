#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
renderer="$repo_root/.github/scripts/render-formation-resume-context.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

state_name="green"
state_name="${state_name}field-state.json"
state_path="$tmp/.pi/agentify/$state_name"
out="$tmp/resume.md"

bash "$renderer" "$tmp" > "$out"
grep -q 'No formation state file was found' "$out"

mkdir -p "$tmp/.pi/agentify"
cat > "$state_path" <<'JSON'
{
  "schema_version": "1",
  "updated_at": "2026-07-06T00:00:00.000Z",
  "checkpoint": "plan",
  "turns": 3,
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
    "Run /to-issues for docs/plans/first.md."
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
    "github_resume": "After bootstrap, open an agent:drill-me issue referencing the plan."
  }
}
JSON

bash "$renderer" "$tmp" > "$out"
grep -q 'Checkpoint: `plan`' "$out"
grep -q 'Approved stop_at: `plan`' "$out"
grep -q 'Current focus: Process invoices end to end' "$out"
grep -q -- '- `docs/plans/first.md`' "$out"
grep -q 'After bootstrap, open an agent:drill-me issue referencing the plan.' "$out"

printf '{ not json\n' > "$state_path"
bash "$renderer" "$tmp" > "$out"
grep -q 'exists but is not valid schema' "$out"
