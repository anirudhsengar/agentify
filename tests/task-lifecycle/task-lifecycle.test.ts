import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { MemoryRecord } from "../../src/core/memory/schema.ts";
import {
  TASK_LIFECYCLE_SCHEMA_VERSION,
  type BuilderAttempt,
  type BuilderRequest,
  type BuilderResult,
  type DurableTaskState,
  type OrchestratorPlan,
  type ReviewerVerdict,
  type TaskLifecyclePolicy,
  type TrustedIssueEvent,
  type ValidationResult,
} from "../../src/core/task-lifecycle/contracts.ts";
import { createBuilderTools } from "../../src/core/task-lifecycle/builder-tools.ts";
import { parseTrustedIssueCommand } from "../../src/core/task-lifecycle/commands.ts";
import {
  approveTask,
  beginTaskImplementation,
  recordBuilderCompletion,
  recordReviewerVerdict,
  recordTaskPlan,
  recordTaskReadiness,
  recordValidationCompletion,
} from "../../src/core/task-lifecycle/engine.ts";
import {
  assessBuilderResult,
  assessDraftPublication,
  assessReviewerVerdict,
  buildAcceptedTaskEvidence,
  buildBuilderRequest,
  createTaskRoleAuthorities,
} from "../../src/core/task-lifecycle/execution.ts";
import {
  findGitHubTaskStateRecord,
  projectionLabelsForTask,
  serializeGitHubTaskState,
} from "../../src/core/task-lifecycle/github-state.ts";
import { parseIssueSpecification } from "../../src/core/task-lifecycle/issue.ts";
import { collectBuilderScopedFileContext } from "../../src/core/task-lifecycle/model-runtime.ts";
import {
  buildOrchestratorPlan,
  loadCurrentSpecialistPortfolio,
} from "../../src/core/task-lifecycle/planning.ts";
import { assessTaskReadiness } from "../../src/core/task-lifecycle/readiness.ts";
import { digestTaskValue } from "../../src/core/task-lifecycle/serialization.ts";
import {
  applyTaskStateMutation,
  beginTaskRecovery,
  completeTaskRecovery,
  makeInitialTaskState,
  reconcileTaskModelCall,
  recordTaskExternalMutation,
  reserveTaskModelCall,
  taskBranchName,
} from "../../src/core/task-lifecycle/state-machine.ts";
import type { SpecialistPortfolio } from "../../src/core/specialists/contracts.ts";
import { specialistPortfolioDigest } from "../../src/core/specialists/validation.ts";
import { makeSpecialistFixtureMap } from "../fixtures/specialist-map.ts";

const BASE = "a".repeat(40);
const NEXT = "b".repeat(40);
const FINAL = "c".repeat(40);
const NOW = "2026-08-01T00:00:00.000Z";

function policy(overrides: Partial<TaskLifecyclePolicy> = {}): TaskLifecyclePolicy {
  const value: TaskLifecyclePolicy = {
    policy_digest: "",
    approval_required: true,
    approval_ttl_ms: 60_000,
    maximum_cost_usd: 5,
    maximum_runtime_ms: 10 * 60_000,
    maximum_model_calls: 8,
    maximum_fix_cycles: 2,
    protected_paths: [".github/workflows", ".agentify/policies"],
    allowed_write_paths: ["src", "tests", "docs"],
    validation_commands: [{
      command_id: "focused-tests",
      argv: ["node", "--test"],
      cwd: ".",
      timeout_ms: 30_000,
      required: true,
      mutation_allowed: false,
      source: "repository-policy",
    }],
    forbidden_actions: ["merge", "auto-merge", "deployment", "force-push"],
    ...overrides,
  };
  value.policy_digest = digestTaskValue({ ...value, policy_digest: undefined });
  return value;
}

function event(overrides: Partial<TrustedIssueEvent> = {}): TrustedIssueEvent {
  return {
    schema_version: TASK_LIFECYCLE_SCHEMA_VERSION,
    delivery_id: "delivery-1",
    event_name: "issues",
    action: "labeled",
    repository: { repository_id: "123", full_name: "owner/repo", default_branch: "main" },
    installation_repository_id: "123",
    issue_number: 152,
    issue_state: "open",
    issue_is_pull_request: false,
    issue_title: "Implement lifecycle",
    issue_body: "## Acceptance criteria\n- Works\n## Scope\n- `src/core/task-lifecycle`",
    actor: { login: "maintainer", type: "User", permission: "write" },
    label_name: "agentify:queue",
    comment_id: null,
    comment_body: null,
    comment_created_at: null,
    comment_updated_at: null,
    received_at: NOW,
    ...overrides,
  };
}

function initial(p = policy()): DurableTaskState {
  return makeInitialTaskState({
    repository: event().repository,
    issue_number: 152,
    expected_base_commit: BASE,
    policy: p,
    event_id: "create-1",
    now: NOW,
    actor: "maintainer",
  });
}

function portfolio(): SpecialistPortfolio {
  const value: SpecialistPortfolio = {
    schema_version: "1",
    supporting_commit: BASE,
    source_map_digest: "0".repeat(64),
    evidence_paths: ["src/core/task-lifecycle/contracts.ts"],
    warnings: [],
    specialists: [{
      specialist_id: "specialist-lifecycle",
      display_name: "Lifecycle",
      concern: "task lifecycle",
      one_line: "Protect task state and publication contracts",
      covers: "Durable task state, approval binding, and draft publication.",
      excludes: "Repository validation commands, which the reviewer owns.",
      flows: [{
        name: "publish a draft",
        description: "Approved plan through unmerged draft pull request.",
        steps: [
          { path: "src/core/task-lifecycle/contracts.ts", what_happens: "Binds the approval to a base commit." },
          { path: "scaffold/.github/workflows/agentify-issue.yml", what_happens: "Publishes the draft." },
        ],
      }],
      touchpoints: [{
        path: "src/core/task-lifecycle/contracts.ts",
        symbol: "TaskPlan",
        role: "The durable state contract every transition is checked against.",
        line_range: null,
        centrality: "core",
      }],
      invariants: [{
        rule: "durable state",
        why: "A lost transition would duplicate delivery.",
        reference: "src/core/task-lifecycle/contracts.ts",
      }],
      pitfalls: [{
        risk: "duplicate delivery",
        consequence: "The same task publishes twice.",
        reference: "src/core/task-lifecycle/contracts.ts",
      }],
      entry_questions: ["Does this change a state transition?"],
      related_specialists: [],
      validation_commands: ["node --test"],
      evidence_paths: ["src/core/task-lifecycle/contracts.ts"],
      context_paths: ["scaffold/.github", "src/core/task-lifecycle"],
      spans_subtrees: ["scaffold", "src"],
      freshness_dependencies: ["src/core/task-lifecycle"],
      supporting_commit: BASE,
      freshness: "current",
      confidence: "high",
      source_kinds: ["concern_evidence"],
      execution_policy: {
        mode: "read_only",
        builtin_tools: ["read", "grep", "find", "ls"],
        shell: "denied",
        filesystem_writes: "denied",
        github_write: "none",
      },
    }],
    procedures: [{
      procedure_id: "validate-lifecycle",
      name: "Validate lifecycle",
      purpose: "Run focused lifecycle tests",
      owner_specialist_id: "specialist-lifecycle",
      trigger_conditions: ["task lifecycle changes"],
      required_context_paths: ["src/core/task-lifecycle"],
      allowed_commands: ["node --test"],
      expected_file_patterns: ["src/core/task-lifecycle/**"],
      side_effects: [],
      validation_commands: ["node --test"],
      recovery_steps: ["fix and rerun"],
      evidence_paths: ["package.json"],
      freshness_dependencies: ["package.json"],
      supporting_commit: BASE,
      freshness: "current",
      confidence: "high",
      source_kind: "repository_validation",
    }],
  };
  return { ...value, source_map_digest: specialistPortfolioDigest(value) };
}

function planFor(state: DurableTaskState, p = policy()): OrchestratorPlan {
  return buildOrchestratorPlan({
    cwd: ".",
    task_id: state.task_id,
    repository: state.repository,
    issue_number: state.issue_number,
    expected_base_commit: state.expected_base_commit,
    task_summary: "Implement the canonical issue lifecycle",
    acceptance_criteria: [{ criterion_id: "criterion-1", statement: "Open a validated draft PR", verification: "Focused tests pass" }],
    candidate_paths: ["src/core/task-lifecycle"],
    excluded_paths: [".github/workflows"],
    risk_category: "high",
    implementation_steps: [{
      step_id: "step-1",
      description: "Implement lifecycle",
      in_scope_paths: ["src/core/task-lifecycle"],
      required_procedure_ids: ["validate-lifecycle"],
      validation_command_ids: ["focused-tests"],
    }],
    portfolio: portfolio(),
    policy: p,
    now: NOW,
  }, {
    learningContext: (_cwd, _candidatePaths, specialistIds) => ({
      records: [],
      evidence: [],
      selected_specialist_ids: [...specialistIds],
    }),
  }).plan;
}

function memoryRecord(kind: "episode" | "codebase", freshness: "current" | "stale", statement: string): MemoryRecord {
  const common = {
    schema_version: "1" as const, memory_id: `${kind}-${freshness}`, revision: 1, owning_agent_id: "orchestrator",
    statement, source_type: "merged_code" as const, supporting_commit: BASE,
    evidence: [{ evidence_id: `${kind}-evidence`, source_type: "merged_code" as const, repository_path: "src/core/task-lifecycle/planning.ts", commit_sha: BASE, sha256: null, line_start: null, line_end: null, external_ref: null, description: "accepted task evidence", observed_at: NOW, actor: "maintainer" }],
    confidence: "high" as const, freshness, dependent_paths: ["src/core/task-lifecycle"], invalidation_conditions: [], superseded_by: null, contradicts: [], human_attribution: null, tags: [], accepted_candidate_ids: [`candidate-${kind}`], created_at: NOW, updated_at: NOW, semantic_digest: "a".repeat(64), content_digest: "b".repeat(64),
  };
  return kind === "episode" ? { ...common, kind, payload: { task_id: "prior-task", issue_number: 151, outcome: "success", attempts: [{ sequence: 1, approach: "repeat the failed approach", result: "failed", failure_category: "test_failure", signal: "focused test failed", correction: "apply the accepted correction" }, { sequence: 2, approach: "apply the accepted correction", result: "succeeded", failure_category: null, signal: "focused test passed", correction: null }], review_feedback: ["retain the accepted correction"], generalization: "task_local", cost_usd: 1, runtime_ms: 10 } } : { ...common, kind, payload: { subject: "contradictory stale fact", paths: ["src/core/task-lifecycle"], symbols: [], contracts: ["use the stale behavior"], relationships: [], validation_commands: [] } };
}

test("task plans bind deterministic current excerpts and exclude stale contradictory memory", () => {
  const state = initial();
  const input = {
    cwd: ".", task_id: state.task_id, repository: state.repository, issue_number: state.issue_number,
    expected_base_commit: state.expected_base_commit, task_summary: "Implement the canonical issue lifecycle",
    acceptance_criteria: [{ criterion_id: "criterion-1", statement: "Use the prior correction", verification: "Focused tests pass" }],
    candidate_paths: ["src/core/task-lifecycle"], excluded_paths: [".github/workflows"], risk_category: "high" as const,
    implementation_steps: [{ step_id: "step-1", description: "Implement lifecycle", in_scope_paths: ["src/core/task-lifecycle"], required_procedure_ids: ["validate-lifecycle"], validation_command_ids: ["focused-tests"] }],
    portfolio: portfolio(), policy: policy(), now: NOW,
  };
  const learningContext = () => ({ records: [memoryRecord("codebase", "stale", "stale contradictory fact"), memoryRecord("episode", "current", "accepted prior lesson")], evidence: [], selected_specialist_ids: [] });
  const first = buildOrchestratorPlan(input, { learningContext }).plan;
  const second = buildOrchestratorPlan(input, { learningContext }).plan;
  assert.deepEqual(first.memory_excerpts, second.memory_excerpts);
  assert.equal(first.plan_digest, second.plan_digest);
  assert.match(JSON.stringify(first.memory_excerpts), /accepted correction/);
  assert.doesNotMatch(JSON.stringify(first.memory_excerpts), /stale contradictory fact|stale behavior/);
});

function approvedState(p = policy()): { state: DurableTaskState; plan: OrchestratorPlan } {
  let state = initial(p);
  state = recordTaskReadiness({
    state,
    decision: { disposition: "ready", reasons: [], clarification_questions: [], risk_category: "high" },
    expected_revision: state.revision,
    event_id: "ready-1",
    actor: "maintainer",
    now: "2026-08-01T00:00:01.000Z",
  }).state;
  const plan = planFor(state, p);
  state = recordTaskPlan({
    state,
    plan,
    policy: p,
    expected_revision: state.revision,
    event_id: "plan-1",
    actor: "orchestrator",
    now: "2026-08-01T00:00:02.000Z",
  }).state;
  state = approveTask({
    state,
    policy: p,
    expected_revision: state.revision,
    event_id: "approve-1",
    approver: "maintainer",
    now: "2026-08-01T00:00:03.000Z",
  }).state;
  return { state, plan };
}

function builder(request: BuilderRequest): BuilderResult {
  return {
    schema_version: "1",
    task_id: request.task_id,
    issue_number: request.issue_number,
    expected_base_commit: request.expected_base_commit,
    branch: request.branch,
    builder_agent_id: "builder",
    started_at: "2026-08-01T00:00:05.000Z",
    completed_at: "2026-08-01T00:00:06.000Z",
    commit_shas: [FINAL],
    final_commit: FINAL,
    changed_files: ["src/core/task-lifecycle/engine.ts"],
    untracked_files: [],
    summary: "Implemented lifecycle",
    attempts: [{ sequence: 1, approach: "typed state machine", result: "succeeded", failure_category: null, signal: "focused tests", correction: null }],
    cost_usd: 0.25,
    runtime_ms: 1_000,
  };
}

function validation(state: DurableTaskState): ValidationResult {
  return {
    schema_version: "1",
    task_id: state.task_id,
    expected_base_commit: BASE,
    expected_branch: state.active_branch ?? "",
    builder_commit: FINAL,
    final_commit: FINAL,
    changed_files: ["src/core/task-lifecycle/engine.ts"],
    untracked_files: [],
    commands: [{
      command_id: "focused-tests",
      started_at: "2026-08-01T00:00:07.000Z",
      completed_at: "2026-08-01T00:00:08.000Z",
      exit_code: 0,
      timed_out: false,
      output_digest: "e".repeat(64),
      redacted_summary: "output omitted",
      head_before: FINAL,
      head_after: FINAL,
      tree_digest_before: "f".repeat(64),
      tree_digest_after: "f".repeat(64),
    }],
    policy_verdict: "passed",
    policy_reasons: [],
    started_at: "2026-08-01T00:00:07.000Z",
    completed_at: "2026-08-01T00:00:08.000Z",
    final_tree_digest: "f".repeat(64),
  };
}

function reviewer(state: DurableTaskState, verdict: ReviewerVerdict["verdict"] = "approved"): ReviewerVerdict {
  const value: ReviewerVerdict = {
    schema_version: "1",
    task_id: state.task_id,
    issue_number: state.issue_number,
    expected_base_commit: BASE,
    reviewed_commit: FINAL,
    reviewer_agent_id: "reviewer",
    builder_agent_id: "builder",
    verdict,
    findings: verdict === "changes_requested" ? [{
      finding_id: "finding-1",
      severity: "major",
      path: "src/core/task-lifecycle/engine.ts",
      statement: "Add a regression test",
      required_change: "Add a regression test",
      acceptance_criterion_ids: ["criterion-1"],
    }] : [],
    summary: verdict === "approved" ? "Approved" : "Changes required",
    reviewed_at: "2026-08-01T00:00:09.000Z",
    verdict_digest: "",
  };
  value.verdict_digest = digestTaskValue({ ...value, verdict_digest: undefined });
  return value;
}

test("authorized queue and exact commands are accepted while untrusted contexts are ignored", () => {
  assert.equal(parseTrustedIssueCommand(event()).command, "queue");
  const comment = event({
    event_name: "issue_comment",
    action: "created",
    label_name: null,
    comment_id: 42,
    comment_body: "/agent approve",
    comment_created_at: NOW,
    comment_updated_at: NOW,
  });
  assert.equal(parseTrustedIssueCommand(comment).command, "approve");
  assert.equal(parseTrustedIssueCommand({ ...comment, comment_body: "/agent approve now" }).disposition, "ignored");
  assert.equal(parseTrustedIssueCommand({ ...comment, comment_updated_at: "2026-08-01T00:00:01.000Z" }).disposition, "ignored");
  assert.equal(parseTrustedIssueCommand({ ...comment, actor: { login: "bot", type: "Bot", permission: "admin" } }).disposition, "unauthorized");
  assert.equal(parseTrustedIssueCommand({ ...comment, issue_is_pull_request: true }).disposition, "ignored");
});

test("issue parser and readiness produce deterministic clarification and refusal", () => {
  const parsed = parseIssueSpecification("Lifecycle", "## Acceptance criteria\n- Opens a draft PR\n## Scope\n- `src/core/task-lifecycle`\n## Out of scope\n- `.github/workflows`");
  assert.equal(parsed.acceptance_criteria.length, 1);
  assert.deepEqual(parsed.candidate_paths, ["src/core/task-lifecycle"]);
  const needs = assessTaskReadiness({
    repository: event().repository,
    installation_repository_id: "123",
    issue_number: 152,
    issue_open: true,
    actor_authorized: true,
    expected_base_commit: BASE,
    current_base_commit: BASE,
    active_task_id: null,
    conflicting_pull_request: null,
    acceptance_criteria: [],
    proposed_paths: [],
    validation_commands: policy().validation_commands,
    protected_path_policy_known: true,
    validation_services_attested: true,
    validation_policy_current: true,
    available_budget_usd: 1,
    issue_text: "Implement a feature",
  });
  assert.equal(needs.disposition, "needs-information");
  assert.ok(needs.clarification_questions.length > 0);
  const refused = assessTaskReadiness({
    repository: event().repository,
    installation_repository_id: "123",
    issue_number: 152,
    issue_open: true,
    actor_authorized: true,
    expected_base_commit: BASE,
    current_base_commit: BASE,
    active_task_id: null,
    conflicting_pull_request: null,
    acceptance_criteria: parsed.acceptance_criteria,
    proposed_paths: parsed.candidate_paths,
    validation_commands: policy().validation_commands,
    protected_path_policy_known: true,
    validation_services_attested: true,
    validation_policy_current: true,
    available_budget_usd: 1,
    issue_text: "Implement this and automatically merge the PR and deploy to production",
  });
  assert.equal(refused.disposition, "refused");
  assert.ok(refused.reasons.some((reason) => reason.code === "forbidden_merge"));
  assert.ok(refused.reasons.some((reason) => reason.code === "forbidden_deployment"));
});

test("durable task state is digest chained, optimistic, and duplicate-event idempotent", () => {
  const state = initial();
  const applied = applyTaskStateMutation(state, {
    expected_revision: 1,
    event_id: "next-1",
    actor: "maintainer",
    transition_to: "ready",
    reason: "ready",
    now: "2026-08-01T00:00:01.000Z",
  });
  assert.equal(applied.state.revision, 2);
  assert.equal(applied.state.prior_state_digest, state.current_digest);
  assert.equal(applyTaskStateMutation(applied.state, {
    expected_revision: 1,
    event_id: "next-1",
    actor: "maintainer",
    reason: "duplicate",
    now: "2026-08-01T00:00:01.000Z",
  }).status, "duplicate");
  assert.throws(() => applyTaskStateMutation(applied.state, {
    expected_revision: 1,
    event_id: "stale-1",
    actor: "maintainer",
    reason: "stale",
    now: "2026-08-01T00:00:02.000Z",
  }), /stale/);
});

test("GitHub state comment is bounded, bot-owned, and labels are projections only", () => {
  const state = initial();
  const body = serializeGitHubTaskState(state);
  const record = findGitHubTaskStateRecord({
    comments: [{ comment_id: 1, author_login: "github-actions[bot]", author_type: "Bot", body, created_at: NOW, updated_at: NOW }],
    trusted_bot_logins: ["github-actions[bot]"],
    expected_task_id: state.task_id,
  });
  assert.equal(record?.state.current_digest, state.current_digest);
  assert.deepEqual(projectionLabelsForTask(state), ["agentify:new"]);
  assert.throws(() => findGitHubTaskStateRecord({
    comments: [{ comment_id: 1, author_login: "attacker", author_type: "User", body, created_at: NOW, updated_at: NOW }],
    trusted_bot_logins: ["github-actions[bot]"],
  }), /not owned/);
});

test("deterministic plan cites specialist and procedure and binds a digest", () => {
  let state = initial();
  state = recordTaskReadiness({ state, decision: { disposition: "ready", reasons: [], clarification_questions: [], risk_category: "high" }, expected_revision: state.revision, event_id: "ready", actor: "maintainer", now: "2026-08-01T00:00:01.000Z" }).state;
  const plan = planFor(state);
  assert.equal(plan.selected_specialists[0]?.specialist_id, "specialist-lifecycle");
  assert.equal(plan.selected_procedures[0]?.procedure_id, "validate-lifecycle");
  assert.equal(plan.plan_digest, digestTaskValue({ ...plan, plan_digest: undefined }));
  assert.ok(plan.security_controls.some((control) => control.control_id === "one-writable-builder"));
  const recorded = recordTaskPlan({
    state,
    plan,
    policy: policy(),
    expected_revision: state.revision,
    event_id: "record-plan",
    actor: "orchestrator",
    now: "2026-08-01T00:00:02.000Z",
  });
  assert.equal(recorded.intermediate_states?.length, 1);
  assert.equal(recorded.intermediate_states?.[0]?.current_state, "planned");
  assert.equal(recorded.intermediate_states?.[0]?.revision, state.revision + 1);
  assert.equal(recorded.state.current_state, "awaiting-approval");
  assert.equal(recorded.state.revision, state.revision + 2);
  assert.equal(recorded.state.prior_state_digest, recorded.intermediate_states?.[0]?.current_digest);
});

test("focused installed audit state is the canonical specialist-routing source", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-focused-task-routing-"));
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(path.join(cwd, "src", "billing"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "billing", "index.ts"), "export const billing = true;\n");
    git("init", "-q");
    git("config", "user.name", "Agentify Test");
    git("config", "user.email", "agentify@example.invalid");
    git("add", ".");
    git("commit", "-qm", "fixture");
    const mapPath = path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, `${JSON.stringify(makeSpecialistFixtureMap(), null, 2)}\n`);
    const loaded = loadCurrentSpecialistPortfolio(cwd);
    assert.equal(loaded.supporting_commit, git("rev-parse", "HEAD"));
    assert.ok(loaded.specialists.length > 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("approval is plan/base/policy-bound, expires, and invalidates on replan", () => {
  const { state } = approvedState();
  assert.equal(state.current_state, "approved");
  assert.throws(() => beginTaskImplementation({
    state,
    issue_title: "Lifecycle",
    current_base_commit: BASE,
    conflicting_branch: false,
    conflicting_pull_request: null,
    expected_revision: state.revision,
    event_id: "late",
    actor: "runtime",
    now: "2026-08-01T00:02:00.000Z",
  }), /expired/);
  const changed = applyTaskStateMutation(state, {
    expected_revision: state.revision,
    event_id: "base-change",
    actor: "runtime",
    transition_to: "ready",
    reason: "base moved",
    now: "2026-08-01T00:00:04.000Z",
    patch: { expected_base_commit: NEXT },
  }).state;
  assert.equal(changed.approval, null);
});

test("stale base and branch conflicts stop before source mutation", () => {
  const { state } = approvedState();
  const stale = beginTaskImplementation({ state, issue_title: "Lifecycle", current_base_commit: NEXT, conflicting_branch: false, conflicting_pull_request: null, expected_revision: state.revision, event_id: "stale", actor: "runtime", now: "2026-08-01T00:00:04.000Z" }).state;
  assert.equal(stale.current_state, "stale-base");
  const conflict = beginTaskImplementation({ state, issue_title: "Lifecycle", current_base_commit: BASE, conflicting_branch: true, conflicting_pull_request: null, expected_revision: state.revision, event_id: "conflict", actor: "runtime", now: "2026-08-01T00:00:04.000Z" }).state;
  assert.equal(conflict.current_state, "blocked");
});

test("role authority has exactly one writer and no GitHub-authorized model", () => {
  const roles = createTaskRoleAuthorities({ cwd: ".", write_root: "src", allowed_paths: ["src"], protected_paths: [".github"] });
  assert.deepEqual(roles.filter((role) => role.application_source_write).map((role) => role.role), ["builder"]);
  assert.ok(roles.filter((role) => role.role !== "builder").every((role) => role.execution_policy.writableRoots.length === 0));
  assert.ok(roles.every((role) => role.github_write === false));
  assert.ok(roles.every((role) => role.execution_policy.networkIsolation === "not-provided"));
  assert.ok(roles.every((role) => role.execution_policy.allowedTools.length === 0));
  assert.deepEqual(roles.find((role) => role.role === "planner")?.trusted_custom_tools, ["submit_planner_refinement"]);
  assert.equal(roles.find((role) => role.role === "planner")?.may_approve_result, false);
  assert.deepEqual(roles.find((role) => role.role === "specialist")?.trusted_custom_tools, ["submit_specialist_findings"]);
  assert.deepEqual(roles.find((role) => role.role === "builder")?.trusted_custom_tools, [
    "write_task_file",
    "replace_task_text",
    "delete_task_file",
    "run_task_check",
    "submit_builder_result",
  ]);
  assert.deepEqual(roles.find((role) => role.role === "reviewer")?.trusted_custom_tools, ["submit_reviewer_verdict"]);
});

test("builder request rejects protected or policy-exceeding scope", () => {
  const p = policy();
  const { state: approved, plan } = approvedState(p);
  const implementing = beginTaskImplementation({ state: approved, issue_title: "Lifecycle", current_base_commit: BASE, conflicting_branch: false, conflicting_pull_request: null, expected_revision: approved.revision, event_id: "implement", actor: "runtime", now: "2026-08-01T00:00:04.000Z" }).state;
  const request = buildBuilderRequest({ cwd: ".", state: implementing, plan, specialist_findings: [], policy: p });
  assert.equal(request.branch, taskBranchName(152, "Lifecycle"));
  assert.deepEqual(request.allowed_paths, ["src/core/task-lifecycle"]);
  const badPlan = { ...plan, in_scope_paths: [".github/workflows"] };
  assert.throws(() => buildBuilderRequest({ cwd: ".", state: implementing, plan: badPlan, specialist_findings: [], policy: p }), /exceeds repository policy|protected/);
});

test("builder prompt context includes only bounded allowed non-protected source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-builder-context-"));
  try {
    fs.mkdirSync(path.join(root, "src", "protected"), { recursive: true });
    fs.mkdirSync(path.join(root, "outside"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "value.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, "src", "protected", "secret.ts"), "not supplied\n");
    fs.writeFileSync(path.join(root, "outside", "other.ts"), "not supplied\n");
    const context = collectBuilderScopedFileContext(root, {
      allowed_paths: ["src"],
      protected_paths: ["src/protected"],
    });
    assert.deepEqual(context, [{ path: "src/value.ts", content: "export const value = 1;\n" }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builder tools deny protected and out-of-scope writes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-builder-tools-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const request = {
    ...({} as BuilderRequest),
    allowed_paths: ["src"],
    protected_paths: ["src/protected"],
    plan: { validation_commands: [] } as unknown as OrchestratorPlan,
  };
  const toolSet = createBuilderTools({ cwd: root, request, commands: [] });
  const write = toolSet.tools.find((tool) => tool.name === "write_task_file") as unknown as { execute(id: string, params: {path:string;content:string}): Promise<unknown> };
  await write.execute("1", { path: "src/ok.txt", content: "ok\n" });
  assert.equal(fs.readFileSync(path.join(root, "src/ok.txt"), "utf8"), "ok\n");
  await assert.rejects(write.execute("2", { path: "src/protected/no.txt", content: "no" }), /protected/);
  await assert.rejects(write.execute("3", { path: "outside.txt", content: "no" }), /outside/);
});

test("builder submission applies one validated bounded change set", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-builder-submit-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "old.txt"), "remove me\n");
    const request = {
      ...({} as BuilderRequest),
      allowed_paths: ["src"],
      protected_paths: ["src/protected"],
      plan: { validation_commands: [] } as unknown as OrchestratorPlan,
    };
    const toolSet = createBuilderTools({ cwd: root, request, commands: [] });
    const submit = toolSet.tools.find((tool) => tool.name === "submit_builder_result") as unknown as {
      execute(id: string, params: {
        changes: Array<{ action: "write"; path: string; content: string } | { action: "delete"; path: string; expected_sha256: string }>;
        summary: string;
        attempts: BuilderAttempt[];
      }): Promise<unknown>;
    };
    const oldDigest = crypto.createHash("sha256").update("remove me\n").digest("hex");
    await submit.execute("submit", {
      changes: [
        { action: "write", path: "src/new.txt", content: "complete\n" },
        { action: "delete", path: "src/old.txt", expected_sha256: oldDigest },
      ],
      summary: "Applied the bounded change set.",
      attempts: [{ sequence: 1, approach: "Apply final content", result: "succeeded", failure_category: null, signal: "Prepared exact content", correction: null }],
    });
    assert.equal(fs.readFileSync(path.join(root, "src", "new.txt"), "utf8"), "complete\n");
    assert.equal(fs.existsSync(path.join(root, "src", "old.txt")), false);
    assert.equal(toolSet.getSubmission()?.summary, "Applied the bounded change set.");

    await assert.rejects(submit.execute("protected", {
      changes: [{ action: "write", path: "src/protected/no.txt", content: "no" }],
      summary: "Rejected.",
      attempts: [{ sequence: 1, approach: "Write protected path", result: "failed", failure_category: "scope", signal: "Rejected", correction: null }],
    }), /protected/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model call reservations enforce one active call, cost, deadline, and reconciliation", () => {
  let state = initial();
  state = reserveTaskModelCall({ state, expected_revision: state.revision, event_id: "reserve", actor: "runtime", call_id: "call-1", role: "specialist", phase: "routing", reservation_cost_usd: 1, now: "2026-08-01T00:00:01.000Z" }).state;
  assert.equal(state.active_model_call?.call_id, "call-1");
  assert.throws(() => reserveTaskModelCall({ state, expected_revision: state.revision, event_id: "reserve-2", actor: "runtime", call_id: "call-2", role: "builder", phase: "build", reservation_cost_usd: 1, now: "2026-08-01T00:00:02.000Z" }), /already active/);
  state = reconcileTaskModelCall({ state, expected_revision: state.revision, event_id: "reconcile", actor: "runtime", call_id: "call-1", usage: { turns: 1, cost_usd: 0.5, runtime_ms: 100, aborted: false }, now: "2026-08-01T00:00:02.000Z" }).state;
  assert.equal(state.active_model_call, null);
  assert.equal(state.budget.model_calls, 1);
  assert.equal(state.budget.measured_cost_usd, 0.5);
});

test("builder, validation, role-separated automated review, bounded fixes, and evidence remain commit-bound", () => {
  const p = policy();
  const prepared = approvedState(p);
  let state = beginTaskImplementation({ state: prepared.state, issue_title: "Lifecycle", current_base_commit: BASE, conflicting_branch: false, conflicting_pull_request: null, expected_revision: prepared.state.revision, event_id: "implement", actor: "runtime", now: "2026-08-01T00:00:04.000Z" }).state;
  const request = buildBuilderRequest({ cwd: ".", state, plan: prepared.plan, specialist_findings: [], policy: p });
  const built = builder(request);
  const builderAssessment = assessBuilderResult(request, built, p, "2026-08-01T00:00:06.000Z");
  assert.equal(builderAssessment.passed, true);
  state = recordBuilderCompletion({ state, builder: built, assessment: builderAssessment, expected_revision: state.revision, event_id: "builder", actor: "builder", now: "2026-08-01T00:00:06.000Z" }).state;
  const validated = validation(state);
  state = recordValidationCompletion({ state, validation: validated, assessment: { passed: true, reasons: [] }, expected_revision: state.revision, event_id: "validation", actor: "validator", now: "2026-08-01T00:00:08.000Z" }).state;
  const selfReview = { ...reviewer(state), reviewer_agent_id: "builder" };
  selfReview.verdict_digest = digestTaskValue({ ...selfReview, verdict_digest: undefined });
  assert.equal(assessReviewerVerdict({ reviewer: selfReview, builder: built, validation: validated }).passed, false);
  const changes = reviewer(state, "changes_requested");
  state = recordReviewerVerdict({ state, reviewer: changes, assessment: assessReviewerVerdict({ reviewer: changes, builder: built, validation: validated }), expected_revision: state.revision, event_id: "review-1", actor: "reviewer", now: "2026-08-01T00:00:09.000Z" }).state;
  assert.equal(state.current_state, "fixing");
  assert.equal(state.fix_cycle_count, 1);
});

test("crash recovery checkpoints are idempotent and ownership conflicts fail closed", () => {
  let state = initial();
  state = beginTaskRecovery({ state, expected_revision: state.revision, event_id: "recover", actor: "runtime", target_state: "ready", checkpoint: "state-created", now: "2026-08-01T00:00:01.000Z" }).state;
  state = recordTaskExternalMutation({ state, expected_revision: state.revision, event_id: "checkpoint", actor: "runtime", mutation: "state-created", resource: { kind: "state-comment", identity: "1", ownership_digest: "a".repeat(64) }, now: "2026-08-01T00:00:02.000Z" }).state;
  assert.deepEqual(state.recovery?.completed_mutations, ["state-created"]);
  assert.throws(() => recordTaskExternalMutation({ state, expected_revision: state.revision, event_id: "conflicting-checkpoint", actor: "runtime", mutation: "projection-updated", resource: { kind: "state-comment", identity: "1", ownership_digest: "b".repeat(64) }, now: "2026-08-01T00:00:03.000Z" }), /conflicting ownership/);
  state = completeTaskRecovery({ state, expected_revision: state.revision, event_id: "complete", actor: "runtime", now: "2026-08-01T00:00:03.000Z" }).state;
  assert.equal(state.current_state, "ready");
  assert.equal(state.recovery, null);
});

test("draft publication requires valid approval, stable tree, passed validation, and approved automated review", () => {
  const p = policy({ approval_ttl_ms: 10 * 60_000 });
  const prepared = approvedState(p);
  let state = beginTaskImplementation({ state: prepared.state, issue_title: "Lifecycle", current_base_commit: BASE, conflicting_branch: false, conflicting_pull_request: null, expected_revision: prepared.state.revision, event_id: "implement", actor: "runtime", now: "2026-08-01T00:00:04.000Z" }).state;
  const request = buildBuilderRequest({ cwd: ".", state, plan: prepared.plan, specialist_findings: [], policy: p });
  const built = builder(request);
  state = recordBuilderCompletion({ state, builder: built, assessment: { passed: true, reasons: [] }, expected_revision: state.revision, event_id: "builder", actor: "builder", now: "2026-08-01T00:00:06.000Z" }).state;
  const validated = validation(state);
  state = recordValidationCompletion({ state, validation: validated, assessment: { passed: true, reasons: [] }, expected_revision: state.revision, event_id: "validation", actor: "validator", now: "2026-08-01T00:00:08.000Z" }).state;
  const reviewed = reviewer(state);
  state = recordReviewerVerdict({ state, reviewer: reviewed, assessment: { passed: true, reasons: [] }, expected_revision: state.revision, event_id: "review", actor: "reviewer", now: "2026-08-01T00:00:09.000Z" }).state;
  const decision = assessDraftPublication({ state, plan: prepared.plan, validation: validated, reviewer: reviewed, branch_owned: true, current_base_commit: BASE, current_head_commit: FINAL, current_tree_digest: validated.final_tree_digest, conflicting_pull_request: null, approval_now: "2026-08-01T00:00:10.000Z", accepted_task_evidence_ref: "artifact-1" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.draft, true);
  assert.match(decision.body, /never merges/i);
  const conflict = assessDraftPublication({ state, plan: prepared.plan, validation: validated, reviewer: reviewed, branch_owned: true, current_base_commit: BASE, current_head_commit: FINAL, current_tree_digest: validated.final_tree_digest, conflicting_pull_request: 99, approval_now: "2026-08-01T00:00:10.000Z", accepted_task_evidence_ref: "artifact-1" });
  assert.equal(conflict.allowed, false);
});

test("accepted task evidence uses the #151 contract without authorizing learning", () => {
  const p = policy({ approval_ttl_ms: 10 * 60_000 });
  const prepared = approvedState(p);
  let state = beginTaskImplementation({ state: prepared.state, issue_title: "Lifecycle", current_base_commit: BASE, conflicting_branch: false, conflicting_pull_request: null, expected_revision: prepared.state.revision, event_id: "implement", actor: "runtime", now: "2026-08-01T00:00:04.000Z" }).state;
  const request = buildBuilderRequest({ cwd: ".", state, plan: prepared.plan, specialist_findings: [], policy: p });
  const built = builder(request);
  const validated = validation({ ...state, active_branch: request.branch });
  const reviewed = reviewer(state);
  const evidence = buildAcceptedTaskEvidence({ state, plan: prepared.plan, builder: built, validation: validated, reviewer: reviewed, pull_request_number: 160, source_artifact_url: "https://github.com/owner/repo/actions/runs/1" });
  assert.equal(evidence.task_id, state.task_id);
  assert.equal(evidence.pull_request_number, 160);
  assert.deepEqual(evidence.selected_specialist_ids, ["specialist-lifecycle"]);
  assert.equal(evidence.validation.passed, true);
  assert.equal("authorizes_learning" in evidence, false);
});

test("accepted task evidence canonicalizes routed IDs and validation refs for learning", () => {
  const prepared = approvedState(policy({ approval_ttl_ms: 10 * 60_000 }));
  let state = beginTaskImplementation({ state: prepared.state, issue_title: "Lifecycle", current_base_commit: BASE, conflicting_branch: false, conflicting_pull_request: null, expected_revision: prepared.state.revision, event_id: "implement", actor: "runtime", now: "2026-08-01T00:00:04.000Z" }).state;
  const built = builder(buildBuilderRequest({ cwd: ".", state, plan: prepared.plan, specialist_findings: [], policy: policy() }));
  const validated = validation(state);
  const templateResult = validated.commands[0]!;
  const templateSpec = prepared.plan.validation_commands[0]!;
  const plan = {
    ...prepared.plan,
    selected_specialists: [
      { ...prepared.plan.selected_specialists[0]!, specialist_id: "specialist-z" },
      { ...prepared.plan.selected_specialists[0]!, specialist_id: "specialist-a" },
    ],
    selected_procedures: [
      { ...prepared.plan.selected_procedures[0]!, procedure_id: "procedure-z" },
      { ...prepared.plan.selected_procedures[0]!, procedure_id: "procedure-a" },
    ],
    validation_commands: [
      { ...templateSpec, command_id: "z-check", argv: ["npm", "run", "z"] },
      { ...templateSpec, command_id: "a-check", argv: ["npm", "run", "a"] },
    ],
  };
  const evidence = buildAcceptedTaskEvidence({
    state,
    plan,
    builder: built,
    validation: {
      ...validated,
      commands: [
        { ...templateResult, command_id: "z-check", output_digest: "b".repeat(64) },
        { ...templateResult, command_id: "a-check", output_digest: "a".repeat(64) },
      ],
    },
    reviewer: reviewer(state),
    pull_request_number: 160,
    source_artifact_url: "https://github.com/owner/repo/actions/runs/1",
  });
  assert.deepEqual(evidence.selected_specialist_ids, ["specialist-a", "specialist-z"]);
  assert.deepEqual(evidence.selected_procedure_ids, ["procedure-a", "procedure-z"]);
  assert.deepEqual(evidence.validation.commands, ["npm run a", "npm run z"]);
  assert.deepEqual(evidence.validation.evidence_refs, [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`]);
});
