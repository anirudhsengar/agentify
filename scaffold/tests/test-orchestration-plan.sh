#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
extractor="$repo_root/.github/scripts/extract-orchestration-plan.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

valid="$tmp/valid.txt"
cat > "$valid" <<'EOF'
Routing complete.
<output>
{
  "summary": "Use the payments workflow before implementation.",
  "selectedWorkflows": ["payments-plan-build-review-fix"],
  "selectedSpecialists": ["payments"],
  "selectedExperts": ["billing"],
  "validationFocus": ["npm test -- payments"]
}
</output>
EOF

bash "$extractor" "$valid" "$tmp/plan.md"
grep -q '^## Orchestration Plan$' "$tmp/plan.md" || {
  echo "expected orchestration plan heading" >&2
  exit 1
}
grep -q 'Use the payments workflow before implementation.' "$tmp/plan.md" || {
  echo "expected summary" >&2
  exit 1
}
grep -q '`payments-plan-build-review-fix`' "$tmp/plan.md" || {
  echo "expected selected workflow" >&2
  exit 1
}
grep -q '`payments`' "$tmp/plan.md" || {
  echo "expected selected specialist" >&2
  exit 1
}
grep -q '`billing`' "$tmp/plan.md" || {
  echo "expected selected expert" >&2
  exit 1
}
grep -q '`npm test -- payments`' "$tmp/plan.md" || {
  echo "expected validation focus" >&2
  exit 1
}

invalid_name="$tmp/invalid-name.txt"
cat > "$invalid_name" <<'EOF'
<output>
{
  "summary": "Bad name.",
  "selectedWorkflows": ["../../escape"],
  "selectedSpecialists": [],
  "selectedExperts": [],
  "validationFocus": []
}
</output>
EOF
if bash "$extractor" "$invalid_name" "$tmp/bad-plan.md" >/dev/null 2>&1; then
  echo "expected unsafe workflow name to fail" >&2
  exit 1
fi

too_many="$tmp/too-many.txt"
cat > "$too_many" <<'EOF'
<output>
{
  "summary": "Too many selections.",
  "selectedWorkflows": ["a", "b", "c", "d", "e", "f"],
  "selectedSpecialists": [],
  "selectedExperts": [],
  "validationFocus": []
}
</output>
EOF
if bash "$extractor" "$too_many" "$tmp/too-many-plan.md" >/dev/null 2>&1; then
  echo "expected too many selected workflows to fail" >&2
  exit 1
fi
