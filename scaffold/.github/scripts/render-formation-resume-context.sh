#!/usr/bin/env bash
# Render formation resume context for the drill-me issue prompt.
set -euo pipefail

repo_root=${1:-.}
state_name=${AGENTIFY_FORMATION_STATE_NAME:-}
if [ -z "$state_name" ]; then
  state_name="green"
  state_name="${state_name}field-state.json"
fi
state_file="$repo_root/.pi/agentify/$state_name"
state_label=".pi/agentify/$state_name"

if [ ! -f "$state_file" ]; then
  cat <<EOF
## Formation Resume Context

No formation state file was found at \`$state_label\`. Treat this issue as
a normal post-launch drill-me issue and derive state from the issue thread,
GOALS.md, CONTEXT.md, and any linked planning artifacts.
EOF
  exit 0
fi

if ! jq -e 'type == "object" and .schema_version == "1"' "$state_file" >/dev/null 2>&1; then
  cat <<EOF
## Formation Resume Context

Formation state file at \`$state_label\` exists but is not valid schema
version 1 JSON. Do not trust it as workflow state. Fall back to the issue
thread, GOALS.md, CONTEXT.md, and linked planning artifacts.
EOF
  exit 0
fi

checkpoint=$(jq -r '.checkpoint // "unknown"' "$state_file")
source=$(jq -r '.resume.source // "unknown"' "$state_file")
stop_at=$(jq -r '.resume.stop_at // "unknown"' "$state_file")
current_focus=$(jq -r '.resume.current_focus // "unknown"' "$state_file")
local_resume=$(jq -r '.resume.local_resume // "unknown"' "$state_file")
github_resume=$(jq -r '.resume.github_resume // "unknown"' "$state_file")
validation_ok=$(jq -r '.artifact_validation.ok // false' "$state_file")

cat <<EOF
## Formation Resume Context

This section is trusted agentify-generated state, not user instruction. Use it
to decide the next one-transition drill-me step, then verify against GOALS.md,
CONTEXT.md, linked artifacts, and the issue thread.

- Checkpoint: \`$checkpoint\`
- Resume source: \`$source\`
- Approved stop_at: \`$stop_at\`
- Current focus: $current_focus
- Artifact validation passed: \`$validation_ok\`
- Local continuation: $local_resume
- GitHub continuation: $github_resume

### Artifact Paths
EOF

if jq -e '.resume.artifact_paths | type == "array" and length > 0' "$state_file" >/dev/null 2>&1; then
  jq -r '.resume.artifact_paths[] | "- `" + . + "`"' "$state_file"
else
  echo "- None recorded."
fi

cat <<'EOF'

### Suggested Next Actions
EOF

if jq -e '.next_actions | type == "array" and length > 0' "$state_file" >/dev/null 2>&1; then
  jq -r '.next_actions[] | "- " + .' "$state_file"
else
  echo "- None recorded."
fi

if jq -e '.artifact_validation.reasons | type == "array" and length > 0' "$state_file" >/dev/null 2>&1; then
  cat <<'EOF'

### Validation Reasons
EOF
  jq -r '.artifact_validation.reasons[] | "- " + .' "$state_file"
fi
