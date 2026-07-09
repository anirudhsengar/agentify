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
  scaffold/.github/workflows/agent-command.yml \
  scaffold/.github/workflows/agent-drill-me-issue.yml \
  scaffold/.github/agent-state-machine.json \
  scaffold/.github/agent-prompts/drill-me-issue.md \
  scaffold/.github/agent-prompts/orchestrate-issue.md \
  scaffold/.github/workflows/agent-refresh-surface.yml \
  scaffold/.github/actions/run-pi/action.yml \
  scaffold/.github/actions/setup-pi/action.yml \
  scaffold/.github/scripts/apply-drill-issues.sh \
  scaffold/.github/scripts/check-existing-issue-pr.sh \
  scaffold/.github/scripts/complete-implementation-handoff.sh \
  scaffold/.github/scripts/complete-review-handoff.sh \
  scaffold/.github/scripts/compute-implementation-branch.sh \
  scaffold/.github/scripts/detect-stale-experts.mjs \
  scaffold/.github/scripts/extract-orchestration-plan.sh \
  scaffold/.github/scripts/extract-pr-meta.sh \
  scaffold/.github/scripts/extract-review-verdict.sh \
  scaffold/.github/scripts/extract-update-branch-comment.sh \
  scaffold/.github/scripts/mark-implementation-failure.sh \
  scaffold/.github/scripts/mark-pr-workflow-failure.sh \
  scaffold/.github/scripts/publish-implementation-pr.sh \
  scaffold/.github/scripts/push-updated-branch.sh \
  scaffold/.github/scripts/run-pi-safe.sh \
  scaffold/.github/scripts/render-expert-context.sh \
  scaffold/.github/scripts/render-drill-reply.sh \
  scaffold/.github/scripts/render-formation-resume-context.sh \
  scaffold/.github/scripts/render-specialist-context.sh \
  scaffold/.github/scripts/render-workflow-context.sh \
  scaffold/.github/scripts/route-agent-command.sh \
  scaffold/.github/scripts/run-issue-readiness.sh \
  scaffold/.github/scripts/setup-agentify.sh \
  scaffold/.github/scripts/smoke-evidence.sh \
  scaffold/.github/scripts/smoke-drill-github-runtime.sh \
  scaffold/.github/scripts/smoke-github-runtime.sh \
  scaffold/.github/scripts/smoke-model-github-runtime.sh \
  scaffold/.github/scripts/smoke-refresh-github-runtime.sh \
  scaffold/.github/scripts/smoke-retry-github-runtime.sh \
  scaffold/.github/scripts/smoke-review-github-runtime.sh \
  scaffold/.github/scripts/refresh-managed-manifest.mjs \
  scaffold/.github/scripts/validate-refresh-surface.sh \
  scaffold/.github/scripts/verify-diff-routing-evidence.sh \
  scaffold/.github/scripts/verify-implementation-commits.sh \
  scaffold/.github/scripts/verify-routing-evidence.sh \
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

# 11. Refresh must track the repository's actual default branch, not a
#     hard-coded main/master subset.
refresh_workflow=scaffold/.github/workflows/agent-refresh-surface.yml
if grep -q 'branches: \[main, master\]' "$refresh_workflow"; then
  fail "agent-refresh-surface.yml must not hard-code main/master; guard against github.event.repository.default_branch"
fi
grep -q 'github.ref_name == github.event.repository.default_branch' "$refresh_workflow" \
  || fail "agent-refresh-surface.yml must guard pushes to the actual default branch"
grep -q 'detect-stale-experts.mjs' "$refresh_workflow" \
  || fail "agent-refresh-surface.yml must detect stale experts before running Pi"
grep -q 'STALE_EXPERTS_FILE' scaffold/.github/agent-prompts/refresh-surface.md \
  || fail "refresh-surface prompt must receive the stale expert report path"
grep -q 'Do NOT commit' scaffold/.github/agent-prompts/refresh-surface.md \
  || fail "refresh-surface prompt must leave commits to the trusted workflow"
grep -q 'git rev-list --count "origin/${BASE_REF}..HEAD"' "$refresh_workflow" \
  || fail "agent-refresh-surface.yml must open a PR when Pi already committed refresh changes"
grep -q 'validate-refresh-surface.sh' "$refresh_workflow" \
  || fail "agent-refresh-surface.yml must validate refresh edits before trusted commit/PR handoff"
grep -q 'refresh-managed-manifest.mjs' "$refresh_workflow" \
  || fail "agent-refresh-surface.yml must refresh managed-file manifest hashes before trusted commit/PR handoff"
grep -q 'Check model runtime configuration' "$refresh_workflow" \
  || fail "agent-refresh-surface.yml must skip cleanly when model runtime configuration is absent"
grep -q 'configured=false' "$refresh_workflow" \
  || fail "agent-refresh-surface.yml must report an unconfigured model runtime as a clean skip"
grep -q 'smoke-github-runtime.sh' scaffold/SETUP.md \
  || fail "SETUP.md must document the live GitHub smoke script"
grep -q 'workflow view agent-implement.yml' scaffold/.github/scripts/smoke-github-runtime.sh \
  || fail "smoke-github-runtime.sh must preflight the installed implement workflow before creating a smoke issue"
grep -q 'workflow view agent-implement.yml' scaffold/.github/scripts/smoke-model-github-runtime.sh \
  || fail "smoke-model-github-runtime.sh must preflight the installed implement workflow before creating a smoke issue"
if grep -q 'AGENT_BOT_LOGIN' scaffold/.github/scripts/smoke-model-github-runtime.sh; then
  fail "smoke-model-github-runtime.sh must not require drill-only AGENT_BOT_LOGIN"
fi
grep -q 'workflow view agent-review.yml' scaffold/.github/scripts/smoke-review-github-runtime.sh \
  || fail "smoke-review-github-runtime.sh must preflight the installed review workflow before editing PR labels"
if grep -RE 'gh (label|secret|variable) list .*\|.*grep -F?x?q' scaffold/.github/scripts >/dev/null; then
  fail "scaffold GitHub list preflights must capture output before grep to avoid pipefail/SIGPIPE"
fi
for list_smoke_script in \
  scaffold/.github/scripts/smoke-drill-github-runtime.sh \
  scaffold/.github/scripts/smoke-retry-github-runtime.sh \
  scaffold/.github/scripts/smoke-model-github-runtime.sh \
  scaffold/.github/scripts/smoke-review-github-runtime.sh \
  scaffold/.github/scripts/smoke-refresh-github-runtime.sh; do
  grep -q 'list=$(cat)' "$list_smoke_script" \
    || fail "$list_smoke_script must consume full gh list output before matching required items"
done
grep -q 'smoke-drill-github-runtime.sh' scaffold/SETUP.md \
  || fail "SETUP.md must document the drill GitHub smoke script"
grep -q 'AGENT_BOT_LOGIN' scaffold/.github/scripts/smoke-drill-github-runtime.sh \
  || fail "smoke-drill-github-runtime.sh must require AGENT_BOT_LOGIN to prevent drill reply loops"
grep -q 'AGENT_BOT_LOGIN' scaffold/.github/scripts/setup-agentify.sh \
  || fail "setup-agentify.sh must validate AGENT_BOT_LOGIN for drill loop safety"
grep -q 'AGENT_BOT_LOGIN' docs/lifecycle/README.md \
  || fail "lifecycle docs must document AGENT_BOT_LOGIN setup"
grep -q 'smoke-model-github-runtime.sh' scaffold/SETUP.md \
  || fail "SETUP.md must document the model-backed GitHub smoke script"
grep -q 'smoke-review-github-runtime.sh' scaffold/SETUP.md \
  || fail "SETUP.md must document the model-backed review smoke script"
grep -q 'smoke-refresh-github-runtime.sh' scaffold/SETUP.md \
  || fail "SETUP.md must document the model-backed refresh smoke script"
grep -q 'smoke-retry-github-runtime.sh' scaffold/SETUP.md \
  || fail "SETUP.md must document the retry GitHub smoke script"
grep -q -- '--evidence-file' scaffold/SETUP.md \
  || fail "SETUP.md must document smoke evidence file output"
grep -q 'agentify.smoke-evidence.v1' scaffold/.github/scripts/smoke-evidence.sh \
  || fail "smoke-evidence.sh must write the evidence schema marker"
grep -q 'commit_sha' scaffold/.github/scripts/smoke-evidence.sh \
  || fail "smoke-evidence.sh must write candidate commit evidence"
grep -q 'createdAt >=' scaffold/.github/scripts/smoke-evidence.sh \
  || fail "smoke-evidence.sh must time-bound workflow run lookup to the smoke start"
for smoke_script in \
  scaffold/.github/scripts/smoke-github-runtime.sh \
  scaffold/.github/scripts/smoke-drill-github-runtime.sh \
  scaffold/.github/scripts/smoke-retry-github-runtime.sh \
  scaffold/.github/scripts/smoke-model-github-runtime.sh \
  scaffold/.github/scripts/smoke-review-github-runtime.sh \
  scaffold/.github/scripts/smoke-refresh-github-runtime.sh; do
  grep -q -- '--evidence-file' "$smoke_script" \
    || fail "$smoke_script must accept --evidence-file"
  grep -q 'write_smoke_evidence' "$smoke_script" \
    || fail "$smoke_script must write smoke evidence on success"
done
grep -q 'model_implementation must include workflow_url' src/core/smoke-evidence.ts \
  || fail "smoke evidence verifier must require workflow_url for model implementation evidence"
grep -q 'model_review must include workflow_url' src/core/smoke-evidence.ts \
  || fail "smoke evidence verifier must require workflow_url for model review evidence"
grep -q 'run-issue-readiness.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must delegate issue readiness to a tested trusted script"
grep -q 'check-existing-issue-pr.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must delegate duplicate PR refusal to a tested trusted script"
grep -q 'compute-implementation-branch.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must delegate issue branch naming to a tested trusted script"
grep -q 'extract-pr-meta.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must delegate PR metadata validation to a tested trusted script"
grep -q 'publish-implementation-pr.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must delegate branch push and draft PR creation to a tested trusted script"
grep -q 'verify-implementation-commits.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must delegate no-change detection to a tested trusted script"
grep -q 'verify-routing-evidence.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must verify selected specialist/expert routing evidence before PR publication"
grep -q '## Routing evidence' scaffold/.github/agent-prompts/implement.md \
  || fail "implement prompt must require selected specialist/expert routing evidence"
grep -q 'complete-implementation-handoff.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must delegate post-PR handoff side effects to a tested trusted script"
grep -q 'mark-implementation-failure.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must delegate failure handoff side effects to a tested trusted script"
grep -q 'orchestrate-issue.md' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must run the public orchestration planner before implementation"
grep -q 'extract-orchestration-plan.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must extract the structured orchestration plan through a tested trusted script"
grep -q 'validate_known_names' scaffold/.github/scripts/extract-orchestration-plan.sh \
  || fail "extract-orchestration-plan.sh must validate selected names against generated context"
grep -q 'validate_known_validation_focus' scaffold/.github/scripts/extract-orchestration-plan.sh \
  || fail "extract-orchestration-plan.sh must validate validation focus commands against generated context"
grep -q 'push-updated-branch.sh' scaffold/.github/workflows/agent-update-branch.yml \
  || fail "agent-update-branch.yml must delegate stale push protection to a tested trusted script"
grep -q 'extract-update-branch-comment.sh' scaffold/.github/workflows/agent-update-branch.yml \
  || fail "agent-update-branch.yml must delegate merge-resolution output validation to a tested trusted script"
grep -q 'mark-pr-workflow-failure.sh' scaffold/.github/workflows/agent-update-branch.yml \
  || fail "agent-update-branch.yml must delegate failure handoff to a tested trusted script"
grep -q 'extract-review-verdict.sh' scaffold/.github/workflows/agent-review.yml \
  || fail "agent-review.yml must delegate review verdict validation to a tested trusted script"
grep -q 'push-updated-branch.sh' scaffold/.github/workflows/agent-review.yml \
  || fail "agent-review.yml must delegate review fixup pushes to a tested trusted script"
grep -q 'verify-diff-routing-evidence.sh' scaffold/.github/workflows/agent-review.yml \
  || fail "agent-review.yml must verify changed-path specialist/expert routing evidence before posting review results"
grep -q 'verify-diff-routing-evidence.sh' scaffold/.github/workflows/agent-implement-pr.yml \
  || fail "agent-implement-pr.yml must verify changed-path specialist/expert routing evidence before pushing PR fixups"
grep -q '## Routing evidence' scaffold/.github/agent-prompts/review.md \
  || fail "review prompt must require changed-path specialist/expert routing evidence"
grep -q '## Routing evidence' scaffold/.github/agent-prompts/implement-pr.md \
  || fail "implement-pr prompt must require changed-path specialist/expert routing evidence"
grep -q 'complete-review-handoff.sh' scaffold/.github/workflows/agent-review.yml \
  || fail "agent-review.yml must delegate review verdict side effects to a tested trusted script"
grep -q 'mark-pr-workflow-failure.sh' scaffold/.github/workflows/agent-review.yml \
  || fail "agent-review.yml must delegate review failure handoff to a tested trusted script"

grep -q 'render-workflow-context.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must inject generated project workflow context"
grep -q 'render-workflow-context.sh' scaffold/.github/workflows/agent-implement-pr.yml \
  || fail "agent-implement-pr.yml must inject generated project workflow context"
grep -q 'render-specialist-context.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must inject generated specialist routing context"
grep -q 'render-specialist-context.sh' scaffold/.github/workflows/agent-implement-pr.yml \
  || fail "agent-implement-pr.yml must inject generated specialist routing context"
grep -q 'render-specialist-context.sh' scaffold/.github/workflows/agent-review.yml \
  || fail "agent-review.yml must inject generated specialist routing context"
grep -q 'render-expert-context.sh' scaffold/.github/workflows/agent-implement.yml \
  || fail "agent-implement.yml must inject generated expert routing context"
grep -q 'render-expert-context.sh' scaffold/.github/workflows/agent-implement-pr.yml \
  || fail "agent-implement-pr.yml must inject generated expert routing context"
grep -q 'render-expert-context.sh' scaffold/.github/workflows/agent-review.yml \
  || fail "agent-review.yml must inject generated expert routing context"
grep -q 'WORKFLOW_CONTEXT' scaffold/.github/agent-prompts/implement.md \
  || fail "implement prompt must include generated project workflow context"
grep -q 'WORKFLOW_CONTEXT' scaffold/.github/agent-prompts/implement-pr.md \
  || fail "implement-pr prompt must include generated project workflow context"
grep -q 'SPECIALIST_CONTEXT' scaffold/.github/agent-prompts/implement.md \
  || fail "implement prompt must include generated specialist routing context"
grep -q 'SPECIALIST_CONTEXT' scaffold/.github/agent-prompts/implement-pr.md \
  || fail "implement-pr prompt must include generated specialist routing context"
grep -q 'SPECIALIST_CONTEXT' scaffold/.github/agent-prompts/review.md \
  || fail "review prompt must include generated specialist routing context"
grep -q 'EXPERT_CONTEXT' scaffold/.github/agent-prompts/implement.md \
  || fail "implement prompt must include generated expert routing context"
grep -q 'ORCHESTRATION_PLAN' scaffold/.github/agent-prompts/implement.md \
  || fail "implement prompt must include the generated orchestration plan"
grep -q 'EXPERT_CONTEXT' scaffold/.github/agent-prompts/implement-pr.md \
  || fail "implement-pr prompt must include generated expert routing context"
grep -q 'EXPERT_CONTEXT' scaffold/.github/agent-prompts/review.md \
  || fail "review prompt must include generated expert routing context"

# 12. Drill-me issue replies must be posted by the trusted workflow from
#     structured output; the model process runs without GitHub tokens.
drill_issue_workflow=scaffold/.github/workflows/agent-drill-me-issue.yml
grep -q 'render-drill-reply.sh' "$drill_issue_workflow" \
  || fail "agent-drill-me-issue.yml must render a structured drill reply"
grep -q 'capture-issue-context.sh' "$drill_issue_workflow" \
  || fail "agent-drill-me-issue.yml must capture issue context before running Pi"
grep -q 'apply-drill-issues.sh' "$drill_issue_workflow" \
  || fail "agent-drill-me-issue.yml must create requested issues through trusted shell"
grep -q 'implementationIssues' scaffold/.github/agent-prompts/drill-me-issue.md \
  || fail "drill-me prompt must use structured implementation issue requests"
grep -q '## Blocked by' scaffold/.github/agent-prompts/drill-me-issue.md \
  || fail "drill-me prompt must require blocker sections on implementation issue bodies"
grep -q 'Blocked by' scaffold/.github/scripts/apply-drill-issues.sh \
  || fail "apply-drill-issues.sh must validate blocker sections before creating queued issues"
if grep -Eq 'gh issue create|gh issue comment' scaffold/.github/agent-prompts/drill-me-issue.md; then
  fail "drill-me prompt must not ask credential-free Pi to mutate GitHub directly"
fi
grep -q 'gh issue comment "$ISSUE_NUMBER" --body-file "$COMMENT_FILE"' "$drill_issue_workflow" \
  || fail "agent-drill-me-issue.yml must post the rendered drill reply on success"
grep -q 'agentify-drill-smoke-no-model' "$drill_issue_workflow" \
  || fail "agent-drill-me-issue.yml must support the trusted no-model drill smoke marker"
grep -q 'agentify drill smoke: no-model preflight' "$drill_issue_workflow" \
  || fail "agent-drill-me-issue.yml must scope the drill smoke marker to the exact smoke issue title"
grep -q 'no Pi model run started' "$drill_issue_workflow" \
  || fail "agent-drill-me-issue.yml must prove the drill smoke exits before Pi"
drill_smoke_line=$(grep -n 'agentify-drill-smoke-no-model' "$drill_issue_workflow" | head -n1 | cut -d: -f1)
drill_bot_skip_line=$(grep -n 'skipping to avoid a reply loop' "$drill_issue_workflow" | head -n1 | cut -d: -f1)
if [ "$drill_smoke_line" -ge "$drill_bot_skip_line" ]; then
  fail "agent-drill-me-issue.yml must handle exact no-model smoke before bot self-loop skipping"
fi

# 13. The audit is retargeted to emit intelligence only (ADR-0009): the builder
#     prompt must carry the Emission Contract and must not instruct emitting the
#     shipped build chain.
builder=src/core/audit/prompts/builder.md
grep -q "Emission contract" "$builder" || fail "builder.md is missing the Emission Contract (ADR-0009 retarget)"
grep -q "ship as skills" "$builder" || grep -q "shipped skills" "$builder" \
  || fail "builder.md must state the build chain ships as skills"

# 14. The standalone pivot keeps a single public CLI command.
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

# 15. Internal trigger/runtime machinery may still ship even though it is
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

# 16. The public CLI is a single entrypoint.
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

# 16b. Config-utility subcommands are the only public subcommands and
#      must be implemented in src/core/cli-commands.ts (ADR 0008 amendment
#      2026-07-09).
[ -f src/core/cli-commands.ts ] || fail "src/core/cli-commands.ts must exist"
for sub in login logout models; do
  if ! grep -q "\"$sub\"" src/core/cli-commands.ts; then
    fail "src/core/cli-commands.ts must dispatch the '$sub' subcommand"
  fi
done
if grep -q '"webhook"\|"aiw"\|"orchestrator"\|"expert"' src/core/cli-commands.ts; then
  fail "src/core/cli-commands.ts must not dispatch internal runtimes as subcommands"
fi
for f in src/cli-webhook.ts src/cli-aiw.ts src/cli-orchestrator.ts src/cli-expert.ts tests/cli-expert.test.ts; do
  if [ -e "$f" ]; then
    fail "legacy adapter/test should be removed: $f"
  fi
done

# 17. Release hygiene: the license, changelog, and publish curation the
#     package claims must actually exist.
[ -f LICENSE ] || fail "LICENSE file is missing (package.json declares MIT)"
[ -f CHANGELOG.md ] || fail "CHANGELOG.md is missing"
[ "$(jq -r '.license // empty' package.json)" = "MIT" ] \
  || fail "package.json license must be MIT (matching LICENSE)"
jq -e '.files | index("bin")' package.json >/dev/null \
  || fail "package.json must declare a files allowlist including bin/"
[ "$(jq -r '.scripts.prepublishOnly // empty' package.json)" != "" ] \
  || fail "package.json must define a prepublishOnly gate"
jq -e '.repository.url // empty' package.json >/dev/null \
  || fail "package.json must declare a repository url"
grep -q 'typecheck' <<<"$(jq -r '.scripts.test // empty' package.json)" \
  || fail "npm test must run the typecheck gate"

# 18. Root CI exists for the agentify package itself (not just the
#     scaffold stamped into target repos).
[ -f .github/workflows/ci.yml ] || fail "root CI workflow .github/workflows/ci.yml is missing"

# 19. Every doc the README links to resolves, and the ADR set is present.
for d in \
  docs/lifecycle/README.md \
  docs/release-evidence.md \
  docs/release-readiness.md \
  docs/01-orientation.md \
  docs/13-repository-layout.md \
  docs/14-development-guide.md \
  docs/15-the-webhook-server.md \
  docs/18-the-orchestrator.md \
  docs/adr/README.md; do
  [ -f "$d" ] || fail "documentation file referenced by the repo is missing: $d"
done

grep -q 'release-evidence.md' docs/release-readiness.md \
  || fail "release-readiness.md must require a durable release evidence ledger"
grep -q 'score:expert-outcomes' package.json \
  || fail "package.json must expose the expert outcome scoring command"
grep -q 'verify:smoke-evidence' package.json \
  || fail "package.json must expose the smoke evidence verification command"
grep -q 'qualify:release-evidence' package.json \
  || fail "package.json must expose the combined release evidence qualification command"
grep -q 'score:expert-outcomes' docs/release-evidence.md \
  || fail "release-evidence.md must document the expert outcome scoring command"
grep -q 'verify:smoke-evidence' docs/release-evidence.md \
  || fail "release-evidence.md must document the smoke evidence verification command"
grep -q -- '--profile no-llm' docs/release-evidence.md \
  || fail "release-evidence.md must document no-LLM smoke evidence verification"
grep -q 'no_llm' src/core/smoke-evidence.ts \
  || fail "smoke evidence verifier must support a no-LLM evidence profile"
grep -q -- '--profile' src/core/scripts/verify-smoke-evidence.ts \
  || fail "verify-smoke-evidence CLI must expose smoke evidence profiles"
grep -q 'qualify:release-evidence' docs/release-evidence.md \
  || fail "release-evidence.md must document the combined release evidence qualification command"
grep -q 'qualify:release-evidence' docs/release-readiness.md \
  || fail "release-readiness.md must require combined release evidence qualification"
grep -q 'github_handoff' src/core/greenfield-state.ts \
  || fail "greenfield state must include a structured GitHub handoff"
grep -q 'Structured GitHub Handoff' scaffold/.github/scripts/render-formation-resume-context.sh \
  || fail "formation resume renderer must include the structured GitHub handoff"
grep -q 'Use the Structured GitHub Handoff' scaffold/.github/agent-prompts/drill-me-issue.md \
  || fail "drill-me prompt must instruct the model to consume the structured GitHub handoff"
grep -q '"activate": true' scaffold/.github/agent-prompts/drill-me-issue.md \
  || fail "drill-me prompt must support activated implementation issue handoff"
grep -q 'agent:implement' scaffold/.github/scripts/apply-drill-issues.sh \
  || fail "apply-drill-issues.sh must support trusted implementation activation"
grep -q 'open_blockers_for_body' scaffold/.github/scripts/apply-drill-issues.sh \
  || fail "apply-drill-issues.sh must check blockers before trusted implementation activation"
grep -q -- '--json body,state' scaffold/.github/scripts/apply-drill-issues.sh \
  || fail "apply-drill-issues.sh must fetch existing issue body/state before activating reused issues"
grep -q 'existing_state' scaffold/.github/scripts/apply-drill-issues.sh \
  || fail "apply-drill-issues.sh must consider existing issue state before trusted implementation activation"
grep -q 'github_handoff' README.md \
  || fail "README.md must document greenfield structured GitHub handoff"
grep -q 'github_handoff' docs/lifecycle/README.md \
  || fail "lifecycle docs must document greenfield structured GitHub handoff"
grep -q -- '--repo <owner/name>' docs/release-readiness.md \
  || fail "release-readiness.md must pin release qualification to the staged repository"
grep -q -- '--commit <sha>' docs/release-readiness.md \
  || fail "release-readiness.md must pin release qualification to the candidate commit"
grep -q -- '--since <iso>' docs/release-readiness.md \
  || fail "release-readiness.md must require a fresh evidence window"
grep -q -- '--repo owner/name' docs/release-evidence.md \
  || fail "release-evidence.md must show release qualification with an explicit staged repository"
grep -q -- '--commit <candidate-sha>' docs/release-evidence.md \
  || fail "release-evidence.md must show release qualification with an explicit candidate commit"
grep -q -- '--since <candidate-started-at-iso>' docs/release-evidence.md \
  || fail "release-evidence.md must show release qualification with an explicit evidence window"
grep -q -- '--evidence-file' docs/release-evidence.md \
  || fail "release-evidence.md must document machine-readable smoke evidence"
for smoke in \
  smoke-github-runtime.sh \
  smoke-drill-github-runtime.sh \
  smoke-retry-github-runtime.sh \
  smoke-model-github-runtime.sh \
  smoke-review-github-runtime.sh \
  smoke-refresh-github-runtime.sh; do
  grep -q "$smoke" docs/release-evidence.md \
    || fail "release-evidence.md must track staged smoke evidence for $smoke"
done
grep -q 'Expert Outcome Evidence' docs/release-evidence.md \
  || fail "release-evidence.md must track expert outcome transcript evidence"
grep -q '"repo": "owner/name"' docs/release-evidence.md \
  || fail "release-evidence.md must require expert outcome manifests to name the staged repository"
grep -q '"commit_sha"' docs/release-evidence.md \
  || fail "release-evidence.md must require expert outcome manifests to name the candidate commit"
grep -q '"captured_at"' docs/release-evidence.md \
  || fail "release-evidence.md must require expert outcome manifests to name the capture timestamp"
grep -q '"provider"' docs/release-evidence.md \
  || fail "release-evidence.md must require expert outcome manifests to name the provider"
grep -q '"model"' docs/release-evidence.md \
  || fail "release-evidence.md must require expert outcome manifests to name the model"
grep -q 'expert outcome captured_at' src/core/release-qualification.ts \
  || fail "release qualification must pin expert outcome evidence to the evidence window"

# 20. Every ADR referenced from shipped skills / scaffold resolves.
while IFS= read -r adr; do
  [ -f "docs/adr/$adr" ] || fail "referenced ADR is missing: docs/adr/$adr"
done < <(grep -rhoE 'docs/adr/[0-9]{4}-[a-z0-9-]+\.md' \
           .agents/skills scaffold docs README.md 2>/dev/null \
           | sed 's#.*docs/adr/##' | sort -u)

if [ "$failures" -gt 0 ]; then
  echo "$failures unification invariant error(s)." >&2
  exit 1
fi
echo "Unification invariants passed."
