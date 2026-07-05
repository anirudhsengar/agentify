#!/usr/bin/env bash
# Contract tests for the unified agentify repo. These guard the invariants the
# GreenField+agentify merge depends on (see docs/adr/).
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

failures=0
fail() { echo "ERROR: $*" >&2; failures=$((failures + 1)); }

# 1. Every skill's frontmatter `name:` matches its directory.
for skill_file in .agents/skills/*/SKILL.md; do
  dir=$(basename "$(dirname "$skill_file")")
  name=$(sed -n 's/^name:[[:space:]]*//p' "$skill_file" | head -n1)
  [ "$dir" = "$name" ] || fail "$skill_file declares '$name', expected '$dir'"
done

# 2. skills-lock.json entries point to real skills.
while IFS= read -r s; do
  [ -f ".agents/skills/$s/SKILL.md" ] || fail "skills-lock.json references missing skill '$s'"
done < <(jq -r '.skills | keys[]' skills-lock.json)

# 3. Forked/reconciled skills must NOT be in the lock (ADR-0002/0006/0009): once
#    edited, a skill is agentify-owned and no longer mergeable with upstream.
for owned in implement review spec scout test fix document; do
  if jq -e --arg k "$owned" '.skills | has($k)' skills-lock.json >/dev/null; then
    fail "skills-lock.json must not track agentify-owned skill '$owned'"
  fi
done

# 4. .claude/skills mirrors .agents/skills exactly (dual discovery; ADR-0008/G10).
for d in .agents/skills/*/; do
  name=$(basename "$d")
  [ -e ".claude/skills/$name" ] || fail ".claude/skills/$name missing (dual-discovery mirror)"
done
for l in .claude/skills/*; do
  name=$(basename "$l")
  [ -d ".agents/skills/$name" ] || fail ".claude/skills/$name has no .agents/skills/$name source"
done

# 5. The unification renamed the product: no stale GreenField tokens in the
#    shipped skills or the scaffold payload.
if grep -rnE 'greenfield|GreenField' .agents/skills scaffold 2>/dev/null \
     | grep -vE '## Greenfield' ; then
  fail "stale 'greenfield' product token in skills/scaffold (only the lifecycle-phase noun '## Greenfield' is allowed)"
fi
# (Live surface only. The inherited ADRs docs/adr/0001-0007 preserve the original
#  GreenField wording as historical records, framed by docs/adr/README.md.)
if grep -rn 'ask-greenfield' .agents/skills scaffold 2>/dev/null; then
  fail "stale 'ask-greenfield' reference — there is no router skill; the lifecycle lives in docs/lifecycle/README.md"
fi

# 6. The build-chain skills the merge promised exist (ADR-0009/0010).
for s in spec implement review test fix document scout \
         plan-build plan-build-review plan-build-review-fix scout-then-plan \
         drill-me to-goals to-prd to-plan to-issues domain-modeling \
         refresh-surface scaffold-ci writing-great-skills; do
  [ -f ".agents/skills/$s/SKILL.md" ] || fail "expected shipped skill '$s' is missing"
done

# 7. agentify does NOT regenerate generic primitives as a separate /plan command
#    (ADR-0010: the build spec command is /spec; /plan would collide with /to-plan).
[ -d .agents/skills/plan ] && fail "skill 'plan' must not exist — the build-spec command is /spec (ADR-0010)"

# 8. ADR ids are unique.
dupes=$(find docs/adr -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.md' -printf '%f\n' \
          | cut -d- -f1 | sort | uniq -d)
[ -z "$dupes" ] || fail "duplicate ADR identifiers: $dupes"

# 9. The scaffold payload is complete (what /scaffold-ci stamps into a target).
for f in \
  scaffold/.github/workflows/agent-implement.yml \
  scaffold/.github/workflows/agent-review.yml \
  scaffold/.github/workflows/agent-drill-me-issue.yml \
  scaffold/.github/agent-prompts/drill-me-issue.md \
  scaffold/.github/workflows/agent-refresh-surface.yml \
  scaffold/.github/actions/run-pi/action.yml \
  scaffold/.github/actions/setup-pi/action.yml \
  scaffold/.github/scripts/setup-agentify.sh \
  scaffold/.github/scripts/validate-repository.sh \
  scaffold/SETUP.md scaffold/.gitignore scaffold/tests/run.sh; do
  [ -f "$f" ] || fail "scaffold payload missing: $f"
done

# 10. All shell scripts parse; all workflow/action YAML parses (when ruby present).
for script in scaffold/.github/scripts/*.sh scaffold/tests/*.sh tests/*.sh; do
  bash -n "$script" || fail "shell syntax failed: $script"
done
if command -v ruby >/dev/null 2>&1; then
  for y in scaffold/.github/workflows/*.yml scaffold/.github/actions/*/action.yml; do
    ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0))' "$y" || fail "YAML syntax failed: $y"
  done
fi

# 11. The audit is retargeted to emit intelligence only (ADR-0009): the builder
#     prompt must carry the Emission Contract and must not instruct emitting the
#     shipped build chain.
builder=src/core/audit/prompts/builder.md
grep -q "Emission contract" "$builder" || fail "builder.md is missing the Emission Contract (ADR-0009 retarget)"
grep -q "ship as skills" "$builder" || grep -q "shipped skills" "$builder" \
  || fail "builder.md must state the build chain ships as skills"

# 12. The standalone pivot keeps a single public CLI command.
[ "$(jq -r '.bin.agentify // empty' package.json)" = "./bin/agentify.js" ] \
  || fail "package.json must expose bin.agentify at ./bin/agentify.js"
[ -x bin/agentify.js ] || fail "bin/agentify.js must be executable"
if jq -e '.pi? // empty' package.json >/dev/null; then
  fail "package.json must not declare a pi manifest"
fi
if jq -e '.keywords[]? | select(. == "pi-package")' package.json >/dev/null; then
  fail "package.json keywords must not include pi-package"
fi
if find extensions -type f -print -quit 2>/dev/null | grep -q .; then
  fail "extensions/ must not contain agentify Pi extension adapter files"
fi

# 13. Internal trigger/runtime machinery may still ship even though it is
#     no longer a public command family.
for f in \
  src/core/webhook/state.ts \
  src/core/webhook/signature.ts \
  src/core/webhook/queue.ts \
  src/core/webhook/trigger-registry.ts \
  src/core/webhook/server.ts \
  src/core/webhook/worker.ts \
  src/core/webhook/index.ts \
  .agentify/webhooks.example.json \
  docs/15-the-webhook-server.md \
  docs/adr/0013-webhook-server.md; do
  [ -f "$f" ] || fail "webhook surface missing: $f"
done
jq -e . .agentify/webhooks.example.json >/dev/null \
  || fail ".agentify/webhooks.example.json is not valid JSON"

# 14. The public CLI is a single entrypoint.
[ -f src/core/agentify-app.ts ] || fail "src/core/agentify-app.ts must exist"
grep -q 'runAgentifyApp' src/cli.ts \
  || fail "src/cli.ts must route through runAgentifyApp"
if grep -q 'argv\[0\] === "webhook"' src/cli.ts; then
  fail "src/cli.ts must not dispatch the 'webhook' subcommand"
fi
if grep -q 'argv\[0\] === "aiw"' src/cli.ts; then
  fail "src/cli.ts must not dispatch the 'aiw' subcommand"
fi
if grep -q 'argv\[0\] === "orchestrator"' src/cli.ts; then
  fail "src/cli.ts must not dispatch the 'orchestrator' subcommand"
fi
if grep -q 'argv\[0\] === "expert"' src/cli.ts; then
  fail "src/cli.ts must not dispatch the 'expert' subcommand"
fi
if grep -q 'agentify webhook' README.md docs/lifecycle/README.md; then
  fail "README.md and docs/lifecycle/README.md must not present webhook as a public command"
fi
if grep -q 'agentify aiw' README.md docs/lifecycle/README.md; then
  fail "README.md and docs/lifecycle/README.md must not present AIW as a public command"
fi
if grep -q 'agentify orchestrator' README.md docs/lifecycle/README.md; then
  fail "README.md and docs/lifecycle/README.md must not present orchestrator as a public command"
fi
if grep -q 'agentify expert' README.md docs/lifecycle/README.md; then
  fail "README.md and docs/lifecycle/README.md must not present expert as a public command"
fi
for f in src/cli-webhook.ts src/cli-aiw.ts src/cli-orchestrator.ts src/cli-expert.ts tests/cli-expert.test.ts; do
  if [ -e "$f" ]; then
    fail "legacy adapter/test should be removed: $f"
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "$failures unification invariant error(s)." >&2
  exit 1
fi
echo "Unification invariants passed."
