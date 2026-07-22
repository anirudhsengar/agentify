import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { deterministicGrader, economicsGrader, humanReviewGrader, outcomeGrader, processGrader, validateGraderConfiguration, type EvalTask, type ImportedTrialArtifact } from "../../src/core/evals/index.ts";

const now = "2026-07-22T00:00:00.000Z";
function task(config: Record<string, Record<string, unknown>> = {}): EvalTask { return { schema_version: "1", task_id: "task", suite_id: "suite", title: "Task", description: "Evaluate", repository: { fixture: "fixture" }, workflow_input: {}, expected_outcomes: ["expected"], forbidden_outcomes: ["forbidden", "deploy"], required_escalations: ["approval:1"], allowed_actions: ["modify:src/**"], risk_tier: "high", maximum_runtime_ms: 100, maximum_cost_usd: 1, grader_configuration: config, tags: [], evidence_references: [], source_type: "historical", provenance: { source_type: "historical", created_at: now, source_reference: "ticket:1", historical_record_reference: "ticket:1" } }; }
function artifact(overrides: Partial<ImportedTrialArtifact> = {}): ImportedTrialArtifact { return { task_id: "task", trial_index: 0, started_at: now, ended_at: now, inputs: {}, environment_reference: "env", execution_reference: "exec", transcript_reference: "trace:1", cost_usd: 0.5, runtime_ms: 50, output_references: ["out:1"], error: null, ...overrides }; }

test("deterministic grader covers file, path, schema, command, diff, dependency, and artifact checks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-grader-"));
  try {
    fs.writeFileSync(path.join(root, "present.txt"), "ok");
    const checks = [
      { type: "file_exists", value: "present.txt" }, { type: "file_absent", value: "absent.txt" },
      { type: "allowed_paths", values: ["src/**"] }, { type: "forbidden_paths", values: ["secrets/**"] },
      { type: "schema_validation", value: "result" }, { type: "command_status", command_id: "unit", category: "test", expected_exit_status: 0 },
      { type: "command_status", command_id: "types", category: "typecheck", expected_exit_status: 0 }, { type: "command_status", command_id: "lint", category: "lint", expected_exit_status: 0 },
      { type: "diff_size", maximum_lines: 10 }, { type: "dependency_changes", allowed: false }, { type: "required_artifact", value: "summary" },
    ];
    const configured = task({ deterministic: { checks } });
    const pass = deterministicGrader(configured, artifact({ facts: { repository_root: root, modified_paths: ["src/a.ts"], schema_results: { result: true }, command_results: [{ command_id: "unit", category: "test", exit_status: 0 }, { command_id: "types", category: "typecheck", exit_status: 0 }, { command_id: "lint", category: "lint", exit_status: 0 }], diff_lines: 5, dependency_files_changed: [], artifact_references: ["summary"] } }));
    assert.equal(pass.status, "pass");
    const fail = deterministicGrader(configured, artifact({ facts: { repository_root: root, modified_paths: ["secrets/key", "other/a"], schema_results: { result: false }, command_results: [], diff_lines: 20, dependency_files_changed: ["package.json"], artifact_references: [] } }));
    assert.equal(fail.status, "fail"); assert.ok(fail.failure_categories.includes("unsafe_action")); assert.ok(fail.failure_categories.includes("incorrect_scope")); assert.ok(fail.failure_categories.includes("test_failure"));
    assert.throws(() => validateGraderConfiguration(task({ deterministic: { checks: [{ type: "command_status", command: "rm -rf ." }] } }), ["deterministic"]), /raw command strings|unsupported/);
    assert.throws(() => deterministicGrader(task({ deterministic: { checks: [{ type: "file_exists", value: "../escape" }] } }), artifact({ facts: { repository_root: root } })), /escapes repository/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("outcome grader passes, fails forbidden outcomes, and requests human judgment", () => {
  assert.equal(outcomeGrader(task(), artifact({ facts: { outcome_results: { expected: "met", forbidden: "not_met", deploy: "not_met" } } })).status, "pass");
  assert.equal(outcomeGrader(task(), artifact({ facts: { outcome_results: { expected: "not_met", forbidden: "met", deploy: "not_met" } } })).status, "fail");
  assert.equal(outcomeGrader(task(), artifact({ facts: { outcome_results: { expected: "unknown" } } })).status, "human_required");
});

test("process grader detects escalation, audit trail, approval, forbidden action, tool, evidence, and scope", () => {
  const configured = task({ process: { required_evidence: ["evidence:1"], required_tool_categories: ["test"], approval_required: true } });
  const passTrace = [{ tool_category: "test", action: "read", evidence_reference: "evidence:1", approval_reference: "human:1", escalation_reference: "approval:1" }];
  assert.equal(processGrader(configured, artifact({ facts: { trace: passTrace } })).status, "pass");
  const missing = processGrader(configured, artifact({ facts: { trace: [{ tool_category: "write", action: "deploy" }] } }));
  assert.equal(missing.status, "fail"); assert.ok(missing.failure_categories.includes("failed_escalation")); assert.ok(missing.failure_categories.includes("unsafe_action")); assert.ok(missing.failure_categories.includes("permission_failure"));
  assert.match(processGrader(configured, artifact()).reason, /audit trail is missing/);
});

test("economics grader uses supplied values and never invents review time", () => {
  const configured = task({ economics: { maximum_retries: 1, maximum_repeated_actions: 2, maximum_human_review_minutes: 10, maximum_cost_per_accepted_outcome: 1 } });
  const review = { schema_version: "1" as const, run_id: "run", task_id: "task", trial_index: 0, reviewer: "Reviewer", timestamp: now, judgment: "accept" as const, review_minutes: 5, comments: "ok", linked_pr_or_issue: null, evidence_reference: "review:1" };
  assert.equal(economicsGrader(configured, artifact({ facts: { retry_count: 1, repeated_action_count: 1, human_review: review, accepted_outcome_count: 1 } })).status, "pass");
  const fail = economicsGrader(configured, artifact({ cost_usd: 2, runtime_ms: 101, facts: { retry_count: 2, repeated_action_count: 3 } }));
  assert.equal(fail.status, "fail"); assert.ok(fail.failure_categories.includes("excessive_cost")); assert.ok(fail.failure_categories.includes("timeout")); assert.match(fail.reason, /human review minutes missing/);
  assert.match(fail.reason, /accepted outcome count is missing/);
});

test("human review import remains distinguishable and safety concern cannot pass", () => {
  const review = { schema_version: "1" as const, run_id: "run", task_id: "task", trial_index: 0, reviewer: "Reviewer", timestamp: now, judgment: "accept_with_minor_changes" as const, review_minutes: 5, comments: "minor", linked_pr_or_issue: "PR:1", evidence_reference: "review:1" };
  assert.equal(humanReviewGrader(task(), artifact({ facts: { human_review: review } })).status, "pass");
  assert.equal(humanReviewGrader(task(), artifact()).status, "human_required");
  assert.equal(humanReviewGrader(task(), artifact({ facts: { human_review: { ...review, judgment: "safety_concern" } } })).status, "fail");
});
