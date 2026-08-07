import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestratorPlan, PlannerRefinementResult } from "../../src/core/task-lifecycle/contracts.ts";
import { createTaskRoleAuthorities } from "../../src/core/task-lifecycle/execution.ts";
import { buildPlannerRefinementRequest } from "../../src/core/task-lifecycle/planning.ts";
import { validatePlannerRefinementResult } from "../../src/core/task-lifecycle/schema.ts";
import { digestTaskValue } from "../../src/core/task-lifecycle/serialization.ts";

const BASE = "a".repeat(40);
const HEX64 = "b".repeat(64);

function draftPlan(overrides: Partial<OrchestratorPlan> = {}): OrchestratorPlan {
  const plan: OrchestratorPlan = {
    schema_version: "1",
    task_id: "task-1",
    repository: { repository_id: "1", full_name: "acme/example", default_branch: "main" },
    issue_number: 42,
    expected_base_commit: BASE,
    task_summary: "Implement the feature",
    acceptance_criteria: [{ criterion_id: "criterion-1", statement: "Do the thing", verification: "Focused tests pass" }],
    in_scope_paths: ["src/feature"],
    excluded_paths: [".github/workflows"],
    selected_specialists: [],
    selected_procedures: [],
    implementation_steps: [{
      step_id: "step-1",
      description: "Implement the thing",
      in_scope_paths: ["src/feature"],
      required_procedure_ids: [],
      validation_command_ids: [],
    }],
    validation_commands: [{
      command_id: "focused-tests",
      argv: ["node", "--test"],
      cwd: ".",
      timeout_ms: 30_000,
      required: true,
      mutation_allowed: false,
      source: "repository-policy",
    }],
    security_controls: [{ control_id: "one-writable-builder", description: "Exactly one builder writes application source.", enforcement: "policy" }],
    risk_category: "low",
    migration_implications: [],
    documentation_expectations: [],
    approval_required: true,
    estimated_model_calls: 3,
    estimated_cost_usd: 0.1,
    escalation_conditions: [],
    memory_record_ids: [],
    memory_excerpts: [],
    routing_digest: HEX64,
    policy_digest: HEX64,
    created_at: "2026-08-01T00:00:00.000Z",
    plan_digest: HEX64,
  };
  return { ...plan, ...overrides };
}

function plannerResult(overrides: Partial<PlannerRefinementResult> = {}): PlannerRefinementResult {
  const withoutDigest: PlannerRefinementResult = {
    schema_version: "1",
    task_id: "task-1",
    draft_plan_digest: HEX64,
    expected_base_commit: BASE,
    implementation_steps: [{
      step_id: "step-1",
      description: "Implement the thing",
      in_scope_paths: ["src/feature"],
      required_procedure_ids: [],
      validation_command_ids: [],
    }],
    scope_conflicts: [],
    result_digest: "",
    ...overrides,
  };
  withoutDigest.result_digest = digestTaskValue({ ...withoutDigest, result_digest: undefined });
  return withoutDigest;
}

test("buildPlannerRefinementRequest binds correctly to a draft plan", () => {
  const plan = draftPlan();
  const request = buildPlannerRefinementRequest({ draft_plan: plan });
  assert.equal(request.task_id, plan.task_id);
  assert.equal(request.issue_number, plan.issue_number);
  assert.equal(request.expected_base_commit, plan.expected_base_commit);
  assert.equal(request.task_summary, plan.task_summary);
  assert.deepEqual(request.acceptance_criteria, plan.acceptance_criteria);
  assert.deepEqual(request.candidate_paths, plan.in_scope_paths);
  assert.deepEqual(request.excluded_paths, plan.excluded_paths);
  assert.deepEqual(request.draft_implementation_steps, plan.implementation_steps);
});

test("validatePlannerRefinementResult accepts a well-formed digest-bound result", () => {
  const result = validatePlannerRefinementResult(plannerResult());
  assert.equal(result.result_digest, digestTaskValue({ ...result, result_digest: undefined }));
  assert.equal(result.implementation_steps.length, 1);
});

test("validatePlannerRefinementResult rejects a stale digest and empty steps", () => {
  const tampered = plannerResult();
  tampered.implementation_steps = [{
    step_id: "step-1",
    description: "A different, unbound change",
    in_scope_paths: ["src/feature"],
    required_procedure_ids: [],
    validation_command_ids: [],
  }];
  assert.throws(() => validatePlannerRefinementResult(tampered));

  const noSteps = plannerResult({ implementation_steps: [] });
  assert.throws(() => validatePlannerRefinementResult(noSteps));
});

test("planner role authority is read-only and cannot approve the result", () => {
  const roles = createTaskRoleAuthorities({ cwd: ".", write_root: "src", allowed_paths: ["src"], protected_paths: [".github"] });
  const planner = roles.find((role) => role.role === "planner");
  assert.ok(planner);
  assert.equal(planner?.application_source_write, false);
  assert.equal(planner?.may_approve_result, false);
  assert.equal(planner?.github_write, false);
  assert.deepEqual(planner?.trusted_custom_tools, ["submit_planner_refinement"]);
  assert.equal(planner?.execution_policy.allowedTools.length, 0);
  assert.equal(roles.filter((role) => role.application_source_write).length, 1);
});
