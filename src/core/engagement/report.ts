import type { OpportunityMatrix } from "./schema/opportunity.ts";
import type { QualificationResult } from "./schema/qualification.ts";
import type { RiskRegister } from "./schema/risk-register.ts";
import type { EngagementCharter } from "./schema/engagement-charter.ts";
import type { StakeholderRegister } from "./schema/stakeholders.ts";
import type { WorkflowMap } from "./schema/workflow-map.ts";
import type { AutomationDecisionRegister } from "./schema/automation-decision.ts";

export function renderEngagementSummary(qualification: QualificationResult, opportunities: OpportunityMatrix, risks: RiskRegister): string {
  const recommendations = opportunities.opportunities.reduce<Record<string, number>>((counts, item) => {
    counts[item.recommendation] = (counts[item.recommendation] ?? 0) + 1; return counts;
  }, {});
  const lines = [
    `# Engagement ${qualification.engagement_id}`,
    "", `Qualification: ${qualification.status}`, `Qualification reasons: ${qualification.reasons.map(({ code }) => code).join(", ") || "none"}`,
    `Opportunities: ${opportunities.opportunities.length}`, `Recommendations: ${Object.entries(recommendations).sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key}=${count}`).join(", ") || "none"}`,
    `Open risks: ${risks.risks.filter(({ status }) => status !== "closed").length}`, "",
  ];
  return lines.join("\n");
}

export function renderEngagementReport(charter: EngagementCharter, artifacts: {
  stakeholders: StakeholderRegister; current: WorkflowMap; target: WorkflowMap;
  opportunities: OpportunityMatrix; decisions: AutomationDecisionRegister; risks: RiskRegister; qualification: QualificationResult;
}): string {
  const names = new Map(artifacts.stakeholders.stakeholders.map((item) => [item.stakeholder_id, item.name]));
  const evidence = new Set([
    ...charter.evidence_references, ...artifacts.current.evidence, ...artifacts.target.evidence,
    ...artifacts.opportunities.opportunities.flatMap(({ candidate }) => candidate.evidence),
    ...artifacts.risks.risks.flatMap((risk) => risk.evidence),
  ]);
  const opportunities = artifacts.opportunities.opportunities.length === 0
    ? ["- Missing: no opportunity candidates supplied."]
    : artifacts.opportunities.opportunities.map((item) => `- ${item.candidate.opportunity_id}: ${item.recommendation} (score ${item.score.final_score}, risk ${item.score.risk_score})`);
  const risks = artifacts.risks.risks.length === 0 ? ["- Missing: no risks supplied."] : artifacts.risks.risks.map((risk) => `- ${risk.risk_id}: ${risk.severity} — ${risk.description} (${risk.status})`);
  const decisions = artifacts.decisions.decisions.length === 0 ? ["- Missing: no automation decisions supplied."] : artifacts.decisions.decisions.map((decision) => `- ${decision.step_id}: ${decision.mode} — ${decision.rationale}`);
  return [
    `# Engagement ${charter.engagement_id}`, "", "## Supplied facts", "",
    `- Lifecycle: ${charter.status}`, `- Problem: ${charter.problem_statement}`,
    `- Workflow owner: ${names.get(artifacts.stakeholders.workflow_owner_id) ?? charter.workflow_owner}`,
    `- Business owner: ${charter.business_owner}`, `- Technical owner: ${charter.technical_owner}`,
    `- Current workflow: ${artifacts.current.name} (${artifacts.current.steps.length} steps)`,
    `- Target workflow: ${artifacts.target.name} (${artifacts.target.steps.length} steps)`,
    `- Qualification: ${artifacts.qualification.status}`, "", "## Opportunity recommendations", "", ...opportunities,
    "", "## Risks", "", ...risks, "", "## Automation and human-control decisions", "", ...decisions,
    "", "## Evidence", "", evidence.size === 0 ? "- Missing: no evidence references supplied." : `- Supplied references: ${[...evidence].sort().join(", ")}`,
    "- ROI: not supplied unless explicitly present in an opportunity record.",
    "- Implementation/deployment: not claimed by this engagement-record report.", "",
  ].join("\n");
}
