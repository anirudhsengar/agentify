#!/usr/bin/env bash
set -euo pipefail

scaffold_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT

make_case() {
  local name=$1 body=$2 mode=${3:-shadow} audit=${4:-present} comment=${5:-false}
  local repo="$temporary_root/$name"
  mkdir -p "$repo/.github/scripts" "$repo/.agents/agentify/engagements/eng/evals/suites" "$repo/.agents/agentify/engagements/eng/evals/tasks" "$repo/src"
  cp "$scaffold_root/.github/scripts/run-shadow.mjs" "$repo/.github/scripts/run-shadow.mjs"
  printf '{"name":"fixture","version":"1.2.3"}\n' > "$repo/package.json"
  printf 'export const widget = true;\n' > "$repo/src/widget.ts"
  printf '{"schema_version":"1","mode":"%s","comment_on_issue":%s,"engagement_id":"eng","eval_suite_id":"suite","task_id":"task","validation_policy":"npm test","maximum_runtime_ms":900000,"maximum_cost_usd":1}\n' "$mode" "$comment" > "$repo/.github/agentify-shadow.json"
  printf '{"schema_version":"1","state_dir":".agents/agentify","agentify_version":"0.2.1"}\n' > "$repo/.agents/agentify/manifest.json"
  printf '{"schema_version":"1","engagement_id":"eng"}\n' > "$repo/.agents/agentify/engagements/eng/charter.json"
  printf '{"schema_version":"1","engagement_id":"eng","workflow_id":"wf","name":"Widget workflow","variant":"current"}\n' > "$repo/.agents/agentify/engagements/eng/current-workflow.json"
  printf '{"schema_version":"1","engagement_id":"eng","decisions":[]}\n' > "$repo/.agents/agentify/engagements/eng/automation-decisions.json"
  printf '{"schema_version":"1","engagement_id":"eng","risks":[]}\n' > "$repo/.agents/agentify/engagements/eng/risk-register.json"
  printf '{"schema_version":"1","suite_id":"suite","version":"1","task_references":["task"],"required_graders":["process"]}\n' > "$repo/.agents/agentify/engagements/eng/evals/suites/suite.json"
  printf '{"schema_version":"1","task_id":"task","suite_id":"suite","workflow_input":{"expected_files":["src/widget.ts"]}}\n' > "$repo/.agents/agentify/engagements/eng/evals/tasks/task.json"
  if [ "$audit" = present ]; then printf '{"schema_version":"7"}\n' > "$repo/.agents/agentify/codebase_map.json"; fi
  printf '{"repository":{"full_name":"owner/repo","node_id":"R_1"},"issue":{"number":42,"title":"Widget enhancement","body":%s,"html_url":"https://github.com/owner/repo/issues/42"}}\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$body")" > "$repo/event.json"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@example.invalid
  git -C "$repo" remote add origin https://github.com/owner/repo.git
  git -C "$repo" add .
  git -C "$repo" commit -qm fixture
  printf '%s\n' "$repo"
}

run_case() {
  local repo=$1
  mkdir -p "$temporary_root/artifacts-$(basename "$repo")"
  GITHUB_ACTIONS=true GITHUB_EVENT_PATH="$repo/event.json" GITHUB_REPOSITORY=owner/repo GITHUB_RUN_ID=900 GITHUB_RUN_ATTEMPT=1 \
    node "$repo/.github/scripts/run-shadow.mjs" "$repo" .agents/agentify .github/agentify-shadow.json "$temporary_root/artifacts-$(basename "$repo")"
}

disabled=$(make_case disabled "Acceptance criteria: widget should render. Tests: npm test. Owner: UI team." disabled)
set +e
disabled_output=$(run_case "$disabled" 2>&1); disabled_status=$?
set -e
[ "$disabled_status" -eq 78 ] && grep -q 'shadow mode is disabled' <<<"$disabled_output"

ready=$(make_case ready "Acceptance criteria: widget should render when opened. Tests: npm test. Owner: UI module team. Implementation affects src/widget.ts.")
ready_result=$(run_case "$ready")
[ "$(jq -r .readiness <<<"$ready_result")" = ready ]
[ "$(jq -r .comment_enabled <<<"$ready_result")" = false ]
jq -e '.evidence_origin == "live_shadow" and .policy.source_files_modified == false and .policy.branch_created_or_pushed == false and .policy.pull_request_created == false and (.explicit_no_code_change_statement | length > 0)' "$temporary_root/artifacts-ready/evidence-packet.json" >/dev/null
git -C "$ready" diff --quiet -- . ':(exclude).agents/agentify'
[ "$(git -C "$ready" branch --list | wc -l | tr -d ' ')" -eq 1 ]
[ -z "$(git -C "$ready" remote show)" ] || [ "$(git -C "$ready" remote show)" = origin ]

missing=$(make_case missing "Bug: widget crashes.")
[ "$(jq -r .readiness <<<"$(run_case "$missing")")" = needs_information ]

rejected=$(make_case rejected "Acceptance criteria: force push and auto-merge it. Tests: none. Owner: UI team.")
[ "$(jq -r .readiness <<<"$(run_case "$rejected")")" = rejected ]

human=$(make_case human "Acceptance criteria: upgrade dependency for widget. Tests: npm test. Owner: UI team.")
[ "$(jq -r .readiness <<<"$(run_case "$human")")" = requires_human_decision ]

security=$(make_case security "Acceptance criteria: rotate auth token handling. Tests: security test. Owner: security team.")
[ "$(jq -r .readiness <<<"$(run_case "$security")")" = requires_human_decision ]
jq -e '.readiness.checks.security_sensitive_scope and (.required_approvals | index("security owner"))' "$temporary_root/artifacts-security/evidence-packet.json" >/dev/null

commented=$(make_case commented "Acceptance criteria: widget should render. Tests: npm test. Owner: UI team." shadow present true)
[ "$(jq -r .comment_enabled <<<"$(run_case "$commented")")" = true ]

no_audit=$(make_case no-audit "Acceptance criteria: widget should render. Tests: npm test. Owner: UI team." shadow missing)
run_case "$no_audit" >/dev/null
[ "$(jq -r .eval.classification "$temporary_root/artifacts-no-audit/evidence-packet.json")" = incomplete_live_shadow_evidence ]

redaction=$(make_case redaction "Acceptance criteria: hide token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA from widget. Tests: npm test. Owner: security team.")
sed -i 's/Widget enhancement/Token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/' "$redaction/event.json"
git -C "$redaction" add event.json && git -C "$redaction" commit -qm redaction-fixture
run_case "$redaction" >/dev/null
! grep -q 'ghp_A' "$temporary_root/artifacts-redaction/evidence-packet.json"
grep -q '\[REDACTED\]' "$temporary_root/artifacts-redaction/evidence-packet.json"

corrupt=$(make_case corrupt "Acceptance criteria: widget should render. Tests: npm test. Owner: UI team.")
printf '{broken\n' > "$corrupt/.agents/agentify/engagements/eng/charter.json"
git -C "$corrupt" add . && git -C "$corrupt" commit -qm corrupt
set +e
corrupt_output=$(run_case "$corrupt" 2>&1); corrupt_status=$?
set -e
[ "$corrupt_status" -ne 0 ] && grep -q 'engagement charter is missing or corrupt' <<<"$corrupt_output"

eval_failure=$(make_case eval-failure "Acceptance criteria: widget should render. Tests: npm test. Owner: UI team.")
rm "$eval_failure/.agents/agentify/engagements/eng/evals/suites/suite.json"
git -C "$eval_failure" add -u && git -C "$eval_failure" commit -qm missing-suite
set +e
eval_output=$(run_case "$eval_failure" 2>&1); eval_status=$?
set -e
[ "$eval_status" -ne 0 ] && grep -q 'eval suite is missing or corrupt' <<<"$eval_output"

workflow="$scaffold_root/.github/workflows/agent-shadow.yml"
grep -q 'cancel-in-progress: true' "$workflow"
grep -q 'timeout-minutes: 20' "$workflow"
grep -q 'actions/upload-artifact@v4' "$workflow"
grep -q "comment_enabled == 'true'" "$workflow"
grep -q 'persist-credentials: false' "$workflow"
! grep -Eq 'git (checkout -b|push|commit)|gh pr (create|merge)' "$workflow"

echo "shadow mode simulations passed."
