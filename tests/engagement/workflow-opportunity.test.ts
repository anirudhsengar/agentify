import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  AutomationDecisionRegisterSchema, AutomationDecisionSchema, EngagementError, OpportunityCandidateSchema,
  OpportunityMatrixSchema, QualificationInputSchema, QualificationResultSchema, RiskRegisterSchema, RiskSchema,
  StakeholderRegisterSchema, StakeholderSchema, WorkflowMapSchema, WorkflowStepSchema,
  deriveRiskSeverity, engagementArtifactPath, qualifyEngagement, readEngagementArtifact, scoreOpportunity,
  validateAutomationDecision, validateAutomationDecisionRegister, validateOpportunityMatrix, validateRiskRegister,
  validateStakeholderRegister, validateWorkflowMap, writeEngagementArtifact,
  type AutomationDecision, type OpportunityCandidate, type QualificationInput, type Risk, type StakeholderRegister, type WorkflowMap,
} from "../../src/core/engagement/index.ts";

const stakeholders: StakeholderRegister = {
  schema_version: "1", engagement_id: "eng-1", workflow_owner_id: "owner", adoption_owner_id: "adopter",
  stakeholders: [
    { stakeholder_id: "owner", name: "Owner", roles: ["workflow_owner"], decision_rights: ["scope"], escalation_contact: true, goals: ["speed"], concerns: [] },
    { stakeholder_id: "adopter", name: "Adopter", roles: ["business_owner"], decision_rights: ["adoption"], escalation_contact: false, goals: ["quality"], concerns: ["training"] },
  ],
};
const workflow: WorkflowMap = {
  schema_version: "1", engagement_id: "eng-1", workflow_id: "invoice", name: "Invoice review", variant: "current",
  trigger: "Invoice arrives", actors: ["owner"], systems: ["ledger"], data_sources: ["inbox"], source_of_truth_system: "ledger",
  evidence: ["ticket:1"], baseline_metrics: [{ name: "cycle", unit: "minutes", value: 20 }],
  steps: [
    { step_id: "receive", name: "Receive", actors: ["owner"], systems: ["inbox"], data_sources: ["inbox"], inputs: ["email"], outputs: ["invoice"], decisions: [], handoff_to_step_ids: ["review"], approvals: [], waiting_period_minutes: 0, exceptions: [], workarounds: [], failure_modes: ["missing attachment"], evidence: ["ticket:1"] },
    { step_id: "review", name: "Review", actors: ["owner"], systems: ["ledger"], data_sources: ["ledger"], inputs: ["invoice"], outputs: ["decision"], decisions: [{ description: "Valid?", outcomes: ["yes", "no"] }], handoff_to_step_ids: [], approvals: ["finance"], waiting_period_minutes: 10, exceptions: [], workarounds: [], failure_modes: ["incorrect decision"], evidence: ["log:2"] },
  ],
};
const candidate: OpportunityCandidate = {
  opportunity_id: "opp-1", workflow_id: "invoice", step_id: "review", business_value: 80, volume: 70,
  feasibility: 80, risk: 20, adoption_readiness: 70, evaluation_feasibility: 80, reversibility: 90,
  data_availability: 80, integration_availability: 60, implementation_complexity: 30, evidence: ["ticket:1"], rejection_reason: null,
};
const decision: AutomationDecision = {
  decision_id: "dec-1", workflow_id: "invoice", step_id: "review", mode: "llm_classification",
  rationale: "Bounded classification", simpler_approaches_rejected: ["Rules do not cover unstructured text"], failure_impact: "Review delay",
  reversibility: "Disable classifier", human_control_checkpoint: "Analyst confirms", fallback: "Manual review", required_evidence: ["eval:1"],
  maximum_cost_usd: 1, confidence: "medium", uncertainty: ["language drift"], approval_owner_id: "owner", security_restrictions: ["no secrets"],
};
const risk: Risk = { risk_id: "risk-1", category: "operational", description: "Bad classification", likelihood: 2, impact: 4, severity: "moderate", mitigation: "Human review", owner_id: "owner", status: "open", detection_method: "Sample audit", rollback_or_fallback: "Manual review", related_step_ids: ["review"], evidence: ["eval:1"] };
const qualification: QualificationInput = { workflow_owner_id: "owner", problem_statement_clear: true, measurable_outcome_defined: true, workflow_evidence_count: 1, task_frequency_sufficient: true, strategic_justification: false, data_accessible: true, technically_feasible: true, evaluation_feasible: true, risk_acceptable: true, human_control_defined: false, adoption_owner_id: "adopter", unresolved_prohibited_conditions: [] };

function expectCode(fn: () => unknown, code: EngagementError["code"]): void {
  assert.throws(fn, (error: unknown) => error instanceof EngagementError && error.code === code);
}

test("all engagement schemas accept fixtures, reject unknown properties, and enforce score ranges", () => {
  const fixtures: Array<[unknown, object]> = [
    [StakeholderSchema, stakeholders.stakeholders[0]], [StakeholderRegisterSchema, stakeholders], [WorkflowStepSchema, workflow.steps[0]],
    [WorkflowMapSchema, workflow], [OpportunityCandidateSchema, candidate], [AutomationDecisionSchema, decision], [RiskSchema, risk],
    [RiskRegisterSchema, { schema_version: "1", engagement_id: "eng-1", risks: [risk] }], [QualificationInputSchema, qualification],
    [QualificationResultSchema, qualifyEngagement("eng-1", qualification)],
  ];
  const scored = scoreOpportunity(candidate);
  fixtures.push([OpportunityMatrixSchema, { schema_version: "1", engagement_id: "eng-1", opportunities: [scored] }]);
  fixtures.push([AutomationDecisionRegisterSchema, { schema_version: "1", engagement_id: "eng-1", decisions: [decision] }]);
  for (const [schema, fixture] of fixtures) {
    assert.equal(Value.Check(schema as never, fixture), true);
    assert.equal(Value.Check(schema as never, { ...fixture, unknown_property: true }), false);
  }
  for (const value of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) expectCode(() => scoreOpportunity({ ...candidate, business_value: value }), "invalid_score");
  const { feasibility: _, ...incomplete } = candidate;
  expectCode(() => scoreOpportunity(incomplete), "invalid_score");
});

test("workflow and stakeholder validators reject duplicate and missing references", () => {
  assert.deepEqual(validateWorkflowMap(workflow), workflow);
  expectCode(() => validateWorkflowMap({ ...workflow, steps: [workflow.steps[0], workflow.steps[0]] }), "duplicate_id");
  expectCode(() => validateWorkflowMap({ ...workflow, steps: [{ ...workflow.steps[0], handoff_to_step_ids: ["missing"] }] }), "invalid_reference");
  assert.deepEqual(validateStakeholderRegister(stakeholders), stakeholders);
  expectCode(() => validateStakeholderRegister({ ...stakeholders, stakeholders: [stakeholders.stakeholders[0], stakeholders.stakeholders[0]] }), "duplicate_id");
  expectCode(() => validateStakeholderRegister({ ...stakeholders, workflow_owner_id: "missing" }), "invalid_reference");
});

test("opportunity scoring is deterministic, transparent, bounded, and does not invent ROI", () => {
  const first = scoreOpportunity(candidate);
  assert.deepEqual(scoreOpportunity(structuredClone(candidate)), first);
  assert.equal(first.score.weighted_value_score, 76.5);
  assert.equal(first.score.risk_penalty, 5);
  assert.equal(first.score.final_score, 71.5);
  assert.equal(first.recommendation, "prioritize");
  assert.equal(first.candidate.supplied_roi, undefined);
  assert.equal(scoreOpportunity({ ...candidate, risk: 90 }).recommendation, "reject");
  assert.equal(scoreOpportunity({ ...candidate, risk: 70 }).recommendation, "defer");
  assert.equal(scoreOpportunity({ ...candidate, business_value: 0, volume: 0, feasibility: 0, adoption_readiness: 0, evaluation_feasibility: 0, reversibility: 0, data_availability: 0, integration_availability: 0, implementation_complexity: 100, risk: 100 }).score.final_score, 0);
});

test("cross-artifact opportunity and automation references are validated", () => {
  const scored = scoreOpportunity(candidate);
  const matrix = { schema_version: "1" as const, engagement_id: "eng-1", opportunities: [scored] };
  assert.deepEqual(validateOpportunityMatrix(matrix, "invoice", new Set(["receive", "review"])), matrix);
  expectCode(() => validateOpportunityMatrix({ ...matrix, opportunities: [{ ...scored, candidate: { ...candidate, step_id: "missing" } }] }, "invoice", new Set(["review"])), "invalid_reference");
  expectCode(() => validateOpportunityMatrix({ ...matrix, opportunities: [scored, scored] }, "invoice", new Set(["review"])), "duplicate_id");
  const register = { schema_version: "1" as const, engagement_id: "eng-1", decisions: [decision] };
  assert.deepEqual(validateAutomationDecisionRegister(register, "invoice", new Set(["review"]), new Set(["owner"])), register);
  expectCode(() => validateAutomationDecisionRegister(register, "invoice", new Set(), new Set(["owner"])), "invalid_reference");
});

test("AI, human approval, prohibited, and no-AI decisions enforce controls", () => {
  assert.deepEqual(validateAutomationDecision(decision), decision);
  expectCode(() => validateAutomationDecision({ ...decision, simpler_approaches_rejected: [] }), "invalid_artifact");
  expectCode(() => validateAutomationDecision({ ...decision, mode: "agentic_execution", human_control_checkpoint: null }), "invalid_artifact");
  expectCode(() => validateAutomationDecision({ ...decision, mode: "human_approval", simpler_approaches_rejected: [], human_control_checkpoint: null }), "invalid_artifact");
  assert.equal(validateAutomationDecision({ ...decision, mode: "unchanged", simpler_approaches_rejected: [], human_control_checkpoint: null }).mode, "unchanged");
  assert.equal(validateAutomationDecision({ ...decision, mode: "prohibited", simpler_approaches_rejected: [], human_control_checkpoint: null }).mode, "prohibited");
  expectCode(() => validateAutomationDecision({ ...decision, mode: "prohibited" }), "invalid_artifact");
});

test("risk severity is derived at every boundary and references are checked", () => {
  assert.equal(deriveRiskSeverity(1, 1), "low"); assert.equal(deriveRiskSeverity(2, 2), "low");
  assert.equal(deriveRiskSeverity(1, 5), "moderate"); assert.equal(deriveRiskSeverity(3, 3), "moderate");
  assert.equal(deriveRiskSeverity(4, 4), "high"); assert.equal(deriveRiskSeverity(5, 5), "critical");
  const register = { schema_version: "1" as const, engagement_id: "eng-1", risks: [risk] };
  assert.deepEqual(validateRiskRegister(register, new Set(["review"])), register);
  expectCode(() => validateRiskRegister({ ...register, risks: [{ ...risk, severity: "critical" }] }), "invalid_artifact");
  expectCode(() => validateRiskRegister(register, new Set()), "invalid_reference");
  expectCode(() => validateRiskRegister({ ...register, risks: [risk, risk] }), "duplicate_id");
});

test("qualification succeeds and exposes every machine-readable failure reason", () => {
  assert.deepEqual(qualifyEngagement("eng-1", qualification), { schema_version: "1", engagement_id: "eng-1", status: "qualified", reasons: [] });
  const cases: Array<[keyof QualificationInput, unknown, string, string]> = [
    ["workflow_owner_id", null, "missing_workflow_owner", "conditionally_qualified"], ["problem_statement_clear", false, "unclear_problem_statement", "insufficient_evidence"],
    ["measurable_outcome_defined", false, "missing_measurable_outcome", "conditionally_qualified"], ["workflow_evidence_count", 0, "missing_workflow_evidence", "insufficient_evidence"],
    ["task_frequency_sufficient", false, "insufficient_frequency_or_strategy", "conditionally_qualified"], ["data_accessible", false, "data_inaccessible", "rejected"],
    ["technically_feasible", false, "technical_infeasibility", "rejected"], ["evaluation_feasible", false, "evaluation_infeasibility", "conditionally_qualified"],
    ["risk_acceptable", false, "unacceptable_uncontrolled_risk", "rejected"], ["adoption_owner_id", null, "missing_adoption_owner", "conditionally_qualified"],
    ["unresolved_prohibited_conditions", ["legal prohibition"], "unresolved_prohibited_condition", "rejected"],
  ];
  for (const [field, value, code, status] of cases) {
    const result = qualifyEngagement("eng-1", { ...qualification, [field]: value });
    assert.equal(result.status, status, field); assert.ok(result.reasons.some((reason) => reason.code === code), field);
  }
  assert.equal(qualifyEngagement("eng-1", { ...qualification, task_frequency_sufficient: false, strategic_justification: true }).status, "qualified");
  assert.equal(qualifyEngagement("eng-1", { ...qualification, risk_acceptable: false, human_control_defined: true }).status, "qualified");
});

test("all roadmap artifact paths persist atomically with stable serialization", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-engagement-artifacts-"));
  try {
    const artifacts = [
      ["stakeholders.json", StakeholderRegisterSchema, stakeholders], ["current-workflow.json", WorkflowMapSchema, workflow],
      ["target-workflow.json", WorkflowMapSchema, { ...workflow, variant: "target" }],
      ["opportunity-matrix.json", OpportunityMatrixSchema, { schema_version: "1", engagement_id: "eng-1", opportunities: [scoreOpportunity(candidate)] }],
      ["automation-decisions.json", AutomationDecisionRegisterSchema, { schema_version: "1", engagement_id: "eng-1", decisions: [decision] }],
      ["risk-register.json", RiskRegisterSchema, { schema_version: "1", engagement_id: "eng-1", risks: [risk] }],
      ["qualification.json", QualificationResultSchema, qualifyEngagement("eng-1", qualification)],
    ] as const;
    for (const [name, schema, value] of artifacts) {
      writeEngagementArtifact(root, "eng-1", name, schema, value);
      const filePath = engagementArtifactPath(root, "eng-1", name);
      const first = fs.readFileSync(filePath, "utf-8");
      writeEngagementArtifact(root, "eng-1", name, schema, value);
      assert.equal(fs.readFileSync(filePath, "utf-8"), first);
      assert.deepEqual(readEngagementArtifact(root, "eng-1", name, schema), value);
    }
    assert.deepEqual(fs.readdirSync(path.join(root, "engagements", "eng-1")).sort(), artifacts.map(([name]) => name).sort());
    expectCode(() => writeEngagementArtifact(root, "other", "stakeholders.json", StakeholderRegisterSchema, stakeholders), "invalid_reference");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
