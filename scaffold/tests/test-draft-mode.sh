#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"; mkdir -p "$repo/.agents/agentify/engagements/eng" "$repo/.agents/agentify/engagements/eng/evals" "$repo/src" "$repo/.github"
git -C "$repo" init -q -b main; git -C "$repo" config user.email test@example.com; git -C "$repo" config user.name Test
printf 'export const value = 1;\n' > "$repo/src/value.ts"
printf '{"files":[]}\n' > "$repo/.agents/agentify/manifest.json"
git -C "$repo" add .; git -C "$repo" commit -qm base; base=$(git -C "$repo" rev-parse HEAD)
future=$(node -e 'console.log(new Date(Date.now()+86400000).toISOString())')
mkdir -p "$repo/.agents/agentify/shadow/shadow-1"
cat > "$repo/.github/agentify-shadow.json" <<EOF
{"schema_version":"1","mode":"draft","engagement_id":"eng","eval_suite_id":"suite","task_id":"task","maximum_cost_usd":5,"maximum_runtime_ms":60000,"require_measured_cost":true,"maximum_input_tokens":1000,"maximum_output_tokens":100,"pricing_policy":{"version":"test-v1","models":[]},"allow_failed_draft":false,"allow_dependency_changes":false,"forbidden_paths":[".github/workflows"],"state_dir":".agents/agentify","validation_checks":[{"name":"build","kind":"build","argv":["node","-e","process.exit(0)"]},{"name":"tests","kind":"tests","argv":["node","-e","process.exit(0)"],"timeout_ms":1000},{"name":"typecheck","kind":"typecheck","argv":["node","-e","process.exit(0)"]},{"name":"lint","kind":"lint","argv":["node","-e","process.exit(0)"]},{"name":"security","kind":"security","argv":["node","-e","process.exit(0)"]}]}
EOF
printf '{"schema_version":"1","engagement_id":"eng","status":"shadow"}\n' > "$repo/.agents/agentify/engagements/eng/charter.json"
printf '{"schema_version":"1","engagement_id":"eng","risks":[]}\n' > "$repo/.agents/agentify/engagements/eng/risk-register.json"
cat > "$repo/.agents/agentify/engagements/eng/promotion-state.json" <<EOF
{"schema_version":"1","revision":2,"engagement_id":"eng","records":[{"record_id":"promotion-1","decision":"approved","candidate_level":"draft","evidence_run_ids":["shadow-1"],"expires_at":"$future","review_at":null,"rollback_level":"observe"}]}
EOF
cat > "$tmp/approval.json" <<EOF
{"schema_version":"1","approval_id":"approval-1","status":"approved","engagement_id":"eng","issue_number":7,"approved_by":"Maintainer","approved_at":"2026-01-01T00:00:00.000Z","expires_at":"$future","expected_base_commit":"$base"}
EOF
cat > "$repo/.agents/agentify/shadow/shadow-1/evidence-packet.json" <<EOF
{"engagement_id":"eng","readiness":{"status":"ready"},"eval":{"classification":"valid_live_shadow_evidence","results":[{"passed":true}]},"repository":{"commit_sha":"$base"},"policy":{"forbidden_action_attempted":false}}
EOF
printf '{"contents":"write","pull_requests":"write","issues":"write"}\n' > "$tmp/permissions.json"
node "$root/.github/scripts/check-draft-gates.mjs" "$repo" .agents/agentify .github/agentify-shadow.json 7 "$tmp/approval.json" "$tmp/permissions.json" "$tmp/gate.json" >/dev/null
jq -e '.status == "ready" and .explicit_no_merge_authority == true and .human_approval.approved_by == "Maintainer"' "$tmp/gate.json" >/dev/null

expect_gate_failure() { local pattern=$1; shift; set +e; output=$(node "$root/.github/scripts/check-draft-gates.mjs" "$repo" .agents/agentify .github/agentify-shadow.json 7 "$tmp/approval.json" "$tmp/permissions.json" "$tmp/gate-fail.json" 2>&1); status=$?; set -e; [ "$status" -ne 0 ] && grep -qi "$pattern" <<<"$output"; }
cp "$repo/.agents/agentify/engagements/eng/promotion-state.json" "$tmp/promotion"
jq '.records=[]' "$tmp/promotion" > "$repo/.agents/agentify/engagements/eng/promotion-state.json"; expect_gate_failure promotion
cp "$tmp/promotion" "$repo/.agents/agentify/engagements/eng/promotion-state.json"
jq '.records += [{"decision":"revoked"}]' "$tmp/promotion" > "$repo/.agents/agentify/engagements/eng/promotion-state.json"; expect_gate_failure promotion
cp "$tmp/promotion" "$repo/.agents/agentify/engagements/eng/promotion-state.json"
mv "$tmp/approval.json" "$tmp/approval-away"; set +e; output=$(node "$root/.github/scripts/check-draft-gates.mjs" "$repo" .agents/agentify .github/agentify-shadow.json 7 "$tmp/approval.json" "$tmp/permissions.json" "$tmp/gate-fail.json" 2>&1); status=$?; set -e; [ "$status" -ne 0 ] && grep -qi approval <<<"$output"; mv "$tmp/approval-away" "$tmp/approval.json"
jq '.expires_at="2020-01-01T00:00:00.000Z"' "$tmp/approval.json" > "$tmp/x"; mv "$tmp/x" "$tmp/approval.json"; expect_gate_failure expired
sed -i "s/2020-01-01T00:00:00.000Z/$future/" "$tmp/approval.json"
jq '.readiness.status="needs_information"' "$repo/.agents/agentify/shadow/shadow-1/evidence-packet.json" > "$tmp/x"; mv "$tmp/x" "$repo/.agents/agentify/shadow/shadow-1/evidence-packet.json"; expect_gate_failure ineligible
sed -i 's/needs_information/ready/' "$repo/.agents/agentify/shadow/shadow-1/evidence-packet.json"
printf '{"schema_version":"1","engagement_id":"eng","risks":[{"risk_id":"critical","severity":"critical","status":"open"}]}\n' > "$repo/.agents/agentify/engagements/eng/risk-register.json"; expect_gate_failure critical
printf '{"schema_version":"1","engagement_id":"eng","risks":[]}\n' > "$repo/.agents/agentify/engagements/eng/risk-register.json"
printf '{"contents":"read","pull_requests":"write","issues":"write"}\n' > "$tmp/permissions.json"; expect_gate_failure permission
printf '{"contents":"write","pull_requests":"write","issues":"write"}\n' > "$tmp/permissions.json"
jq '.expected_base_commit="0000000000000000000000000000000000000000"' "$tmp/approval.json" > "$tmp/x"; mv "$tmp/x" "$tmp/approval.json"; expect_gate_failure 'base commit moved'
sed -i "s/0000000000000000000000000000000000000000/$base/" "$tmp/approval.json"

printf 'export const value = 2;\n' > "$repo/src/value.ts"; git -C "$repo" add src/value.ts; git -C "$repo" commit -qm change
node "$root/.github/scripts/draft-run-control.mjs" init "$tmp/usage.json" "$repo/.github/agentify-shadow.json"
node "$root/.github/scripts/validate-draft-run.mjs" "$repo" "$base" .github/agentify-shadow.json "$tmp/usage.json" "$tmp/validation.json"
jq -e '.passed and .publication_allowed and .files_changed == ["src/value.ts"]' "$tmp/validation.json" >/dev/null
printf 'plan\n' > "$tmp/plan.md"
node "$root/.github/scripts/build-draft-evidence.mjs" "$repo" "$tmp/gate.json" "$tmp/validation.json" "$tmp/plan.md" 7 agent/draft-7-1-change "$tmp/evidence.json"
jq -e '.publication_status == "draft_unmerged" and (.explicit_statement | contains("never merges")) and .traces_included == false' "$tmp/evidence.json" >/dev/null

jq '.validation_checks[0].argv=["node","-e","require(\"node:fs\").writeFileSync(\"post-validation.txt\",\"untrusted mutation\")"]' "$repo/.github/agentify-shadow.json" > "$tmp/config"; mv "$tmp/config" "$repo/.github/agentify-shadow.json"
set +e; node "$root/.github/scripts/validate-draft-run.mjs" "$repo" "$base" .github/agentify-shadow.json "$tmp/usage.json" "$tmp/mutation.json"; mutation_status=$?; set -e
[ "$mutation_status" -ne 0 ] && jq -e '.diff_policy.validation_worktree_unchanged == false and .publication_allowed == false and (.validation_status_after | map(contains("post-validation.txt")) | any)' "$tmp/mutation.json" >/dev/null
rm "$repo/post-validation.txt"
jq '.validation_checks[0].argv=["node","-e","process.exit(0)"]' "$repo/.github/agentify-shadow.json" > "$tmp/config"; mv "$tmp/config" "$repo/.github/agentify-shadow.json"

jq '.allow_failed_draft=true | .validation_checks[0].argv=["node","-e","require(\"node:fs\").writeFileSync(\"post-validation.txt\",\"untrusted mutation\")"]' "$repo/.github/agentify-shadow.json" > "$tmp/config"; mv "$tmp/config" "$repo/.github/agentify-shadow.json"
set +e; node "$root/.github/scripts/validate-draft-run.mjs" "$repo" "$base" .github/agentify-shadow.json "$tmp/usage.json" "$tmp/mutation-override.json"; mutation_override_status=$?; set -e
[ "$mutation_override_status" -ne 0 ] && jq -e '.diff_policy.validation_worktree_unchanged == false and .publication_allowed == false and .failed_draft_policy_used == false' "$tmp/mutation-override.json" >/dev/null
rm "$repo/post-validation.txt"
jq '.allow_failed_draft=false | .validation_checks[0].argv=["node","-e","process.exit(0)"]' "$repo/.github/agentify-shadow.json" > "$tmp/config"; mv "$tmp/config" "$repo/.github/agentify-shadow.json"

jq '.validation_checks[0].argv=["node","-e","console.log(\"arbitrary-customer-secret-12345\")"]' "$repo/.github/agentify-shadow.json" > "$tmp/config"; mv "$tmp/config" "$repo/.github/agentify-shadow.json"
node "$root/.github/scripts/validate-draft-run.mjs" "$repo" "$base" .github/agentify-shadow.json "$tmp/usage.json" "$tmp/redacted-output.json"
! grep -q 'arbitrary-customer-secret-12345' "$tmp/redacted-output.json"
jq -e '.validation_results[0].output_tail | contains("omitted")' "$tmp/redacted-output.json" >/dev/null
jq '.validation_checks[0].argv=["node","-e","process.exit(0)"]' "$repo/.github/agentify-shadow.json" > "$tmp/config"; mv "$tmp/config" "$repo/.github/agentify-shadow.json"

printf '{"dependencies":{}}\n' > "$repo/package.json"; git -C "$repo" add package.json; git -C "$repo" commit -qm dependency
set +e; node "$root/.github/scripts/validate-draft-run.mjs" "$repo" "$base" .github/agentify-shadow.json "$tmp/usage.json" "$tmp/dependency.json"; dependency_status=$?; set -e
[ "$dependency_status" -ne 0 ] && jq -e '.diff_policy.dependency_changes == false and .dependency_changes == ["package.json"]' "$tmp/dependency.json" >/dev/null
git -C "$repo" revert --no-edit HEAD >/dev/null
mkdir -p "$repo/.github/workflows"; printf 'name: forbidden\n' > "$repo/.github/workflows/new.yml"; git -C "$repo" add .github/workflows/new.yml; git -C "$repo" commit -qm forbidden
set +e; node "$root/.github/scripts/validate-draft-run.mjs" "$repo" "$base" .github/agentify-shadow.json "$tmp/usage.json" "$tmp/forbidden.json"; forbidden_status=$?; set -e
[ "$forbidden_status" -ne 0 ] && jq -e '.diff_policy.forbidden_paths == false and .forbidden_path_changes == [".github/workflows/new.yml"]' "$tmp/forbidden.json" >/dev/null
git -C "$repo" revert --no-edit HEAD >/dev/null

jq '.maximum_cost_usd=0' "$repo/.github/agentify-shadow.json" > "$tmp/config"; mv "$tmp/config" "$repo/.github/agentify-shadow.json"
set +e; node "$root/.github/scripts/validate-draft-run.mjs" "$repo" "$base" .github/agentify-shadow.json "$tmp/usage.json" "$tmp/cost.json"; cost_status=$?; set -e
[ "$cost_status" -ne 0 ] && jq -e '.diff_policy.cost == false and .publication_allowed == false' "$tmp/cost.json" >/dev/null
jq '.maximum_cost_usd=5 | .maximum_runtime_ms=10' "$repo/.github/agentify-shadow.json" > "$tmp/config"; mv "$tmp/config" "$repo/.github/agentify-shadow.json"
set +e; node "$root/.github/scripts/validate-draft-run.mjs" "$repo" "$base" .github/agentify-shadow.json "$tmp/usage.json" "$tmp/time.json"; time_status=$?; set -e
[ "$time_status" -ne 0 ] && jq -e '.diff_policy.runtime == false' "$tmp/time.json" >/dev/null
jq '.maximum_runtime_ms=60000 | .validation_checks[0].argv=["node","-e","process.exit(1)"]' "$repo/.github/agentify-shadow.json" > "$tmp/config"; mv "$tmp/config" "$repo/.github/agentify-shadow.json"
set +e; node "$root/.github/scripts/validate-draft-run.mjs" "$repo" "$base" .github/agentify-shadow.json "$tmp/usage.json" "$tmp/fail.json"; fail_status=$?; set -e
[ "$fail_status" -ne 0 ] && jq -e '.validation_results[0].status == "failed"' "$tmp/fail.json" >/dev/null
jq '.validation_checks[0].argv=["node","-e","setTimeout(()=>{},1000)"] | .validation_checks[0].timeout_ms=1' "$repo/.github/agentify-shadow.json" > "$tmp/config"; mv "$tmp/config" "$repo/.github/agentify-shadow.json"
set +e; node "$root/.github/scripts/validate-draft-run.mjs" "$repo" "$base" .github/agentify-shadow.json "$tmp/usage.json" "$tmp/timeout.json"; timeout_status=$?; set -e
[ "$timeout_status" -ne 0 ] && jq -e '.validation_results[0].status == "timeout"' "$tmp/timeout.json" >/dev/null

printf '{"reviewer":"Reviewer","outcome":"major_rework","review_time_minutes":12,"notes":"Needs a safer boundary token-abcdefghijklmnopqrstuvwxyz","final_outcome":"changes_requested"}\n' > "$tmp/review.json"
node "$root/.github/scripts/import-draft-review.mjs" "$tmp/review.json" "$tmp/review-result.json"
jq -e '.[0].inputs.draft_review_outcome == "major_rework" and .[0].inputs.failure_categories == ["incomplete_task"] and .[0].facts.human_review.review_minutes == 12 and (.[0].facts.human_review.comments | contains("[REDACTED]"))' "$tmp/review-result.json" >/dev/null

! grep -R -E 'gh pr merge|auto-merge|git push (origin )?(main|master)' "$root/.github/workflows/agent-implement.yml" "$root/.github/scripts/publish-implementation-pr.sh"
grep -q -- '--draft' "$root/.github/scripts/publish-implementation-pr.sh"
echo "draft mode gates, validation, evidence, review, and no-merge controls passed."
