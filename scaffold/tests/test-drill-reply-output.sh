#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
renderer="$repo_root/.github/scripts/render-drill-reply.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

transcript="$tmp/transcript.txt"
comment="$tmp/comment.md"

cat > "$transcript" <<'EOF'
The next durable transition is to ask one clarifying question.

<output>
{
  "reply": "Which workflow should be optimized first?",
  "state": "interviewing",
  "filesChanged": false
}
</output>
EOF

bash "$renderer" "$transcript" "$comment" "agentify-event:test-node-1"

grep -q '^Which workflow should be optimized first?$' "$comment"
grep -q '<!-- agentify-event:test-node-1 agentify-state:interviewing -->' "$comment"

cat > "$transcript" <<'EOF'
<output>{"reply":"","state":"interviewing","filesChanged":false}</output>
EOF
if bash "$renderer" "$transcript" "$comment" "agentify-event:test-node-2" >/dev/null 2>&1; then
  echo "expected empty drill reply to fail validation" >&2
  exit 1
fi

cat > "$transcript" <<'EOF'
<output>
{
  "reply": "Create this issue.",
  "state": "awaiting_issue_approval",
  "filesChanged": false,
  "implementationIssues": [
    {
      "slug": "../escape",
      "title": "Invalid issue request",
      "body": "This slug must be rejected before the workflow posts a reply."
    }
  ]
}
</output>
EOF
if bash "$renderer" "$transcript" "$comment" "agentify-event:test-node-3" >/dev/null 2>&1; then
  echo "expected invalid issue request to fail validation" >&2
  exit 1
fi

cat > "$transcript" <<'EOF'
No structured output here.
EOF
if bash "$renderer" "$transcript" "$comment" "agentify-event:test-node-4" >/dev/null 2>&1; then
  echo "expected missing drill reply output to fail validation" >&2
  exit 1
fi
