#!/usr/bin/env bash
# Focused product boundary for the install-once repository team.
set -euo pipefail
export LC_ALL=C

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

failures=0
fail() { echo "ERROR: $*" >&2; failures=$((failures + 1)); }

# Installation is deliberately small and exact. Runtime bundles are copied by
# trusted installer code, not stored as duplicate scaffold artifacts.
expected_scaffold=$(cat <<'EOF'
.github/agentify-task-policy.json
.github/agentify/validation-smoke.mjs
.github/scripts/complete-accepted-task-merge.mjs
.github/scripts/publish-task-draft.mjs
.github/scripts/run-task-lifecycle.mjs
.github/scripts/task-state-github.mjs
.github/workflows/agentify-issue.yml
.github/workflows/agentify-learn.yml
AGENTS.md
SETUP.md
EOF
)
actual_scaffold=$(find scaffold -type f ! -path 'scaffold/tests/*' -printf '%P\n' | sort)
[ "$actual_scaffold" = "$expected_scaffold" ] \
  || fail "scaffold inventory differs from the focused allowlist"

for required in \
  scaffold/.github/workflows/agentify-issue.yml \
  scaffold/.github/workflows/agentify-learn.yml \
  scaffold/.github/agentify-task-policy.json \
  scaffold/.github/scripts/complete-accepted-task-merge.mjs \
  scaffold/.github/scripts/publish-task-draft.mjs \
  scaffold/.github/scripts/run-task-lifecycle.mjs \
  scaffold/.github/scripts/task-state-github.mjs \
  scaffold/AGENTS.md \
  scaffold/SETUP.md; do
  [ -f "$required" ] || fail "focused scaffold file missing: $required"
done

# The issue workflow consumes the installer-owned task runtime and retains human
# merge authority. The learning workflow consumes its installer-owned runtime.
issue_workflow=scaffold/.github/workflows/agentify-issue.yml
learn_workflow=scaffold/.github/workflows/agentify-learn.yml
grep -q 'node .github/scripts/run-task-lifecycle.mjs' "$issue_workflow" \
  || fail "issue workflow must run the trusted installed lifecycle controller"
grep -q 'persist-credentials: false' "$issue_workflow" \
  || fail "issue workflow checkout must not persist credentials"
if grep -qE 'auto-merge|gh pr merge|deploy' "$issue_workflow"; then
  fail "issue workflow must stop at an unmerged draft pull request"
fi
grep -q 'learning-runtime.mjs process' "$learn_workflow" \
  || fail "learning workflow must run the installed learning runtime"

# Public CLI inventory is exact and internal runtimes remain unreachable.
[ "$(jq -r '.bin.agentify // empty' package.json)" = './bin/agentify.js' ] \
  || fail "package.json must expose only bin.agentify"
[ -x bin/agentify.js ] || fail "bin/agentify.js must be executable"
for subcommand in login logout models; do
  grep -q "\"$subcommand\"" src/core/cli-commands.ts \
    || fail "focused CLI command missing: $subcommand"
done
# Publish curation must include focused runtime assets. The authoritative
# installed-package smoke test checks real bytes.
for required_entry in bin dist scaffold/AGENTS.md scaffold/SETUP.md; do
  jq -e --arg entry "$required_entry" '.files | index($entry)' package.json >/dev/null \
    || fail "package files allowlist missing: $required_entry"
done
# Shell and workflow syntax remains mechanically checked.
for script in scaffold/tests/*.sh tests/*.sh; do
  bash -n "$script" || fail "shell syntax failed: $script"
done
if command -v ruby >/dev/null 2>&1; then
  for workflow in scaffold/.github/workflows/*.yml; do
    ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0))' "$workflow" \
      || fail "YAML syntax failed: $workflow"
  done
fi

[ -f LICENSE ] || fail "LICENSE is missing"
[ "$(jq -r '.license // empty' package.json)" = 'MIT' ] \
  || fail "package license must match LICENSE"
[ -n "$(jq -r '.scripts.prepublishOnly // empty' package.json)" ] \
  || fail "prepublishOnly release gate is missing"
[ -f .github/workflows/ci.yml ] || fail "repository CI workflow is missing"

if [ "$failures" -gt 0 ]; then
  echo "$failures focused product invariant error(s)." >&2
  exit 1
fi
echo "Focused product invariants passed."
