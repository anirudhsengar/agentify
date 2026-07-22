export { EngagementError, type EngagementErrorCode } from "./errors.ts";
export { engagementArtifactPath, engagementCharterPath, engagementReportPath, engagementRootPath, validateEngagementId, type EngagementArtifactName } from "./paths.ts";
export { readEngagementArtifact, writeEngagementArtifact } from "./artifacts.ts";
export {
  EngagementCharterSchema,
  EngagementMetricSchema,
  EngagementRepositorySchema,
  EngagementTargetSchema,
  type EngagementCharter,
  type EngagementMetric,
} from "./schema/engagement-charter.ts";
export {
  ENGAGEMENT_STATUSES,
  EngagementStatusSchema,
  type EngagementStatus,
} from "./schema/engagement-status.ts";
export * from "./schema/stakeholders.ts";
export * from "./schema/workflow-map.ts";
export * from "./schema/opportunity.ts";
export * from "./schema/automation-decision.ts";
export * from "./schema/risk-register.ts";
export * from "./schema/qualification.ts";
export {
  createEngagement,
  listEngagements,
  readEngagement,
  transitionEngagement,
  updateEngagement,
  validateEngagementCharter,
  type CreateEngagementInput,
  type EngagementStateOptions,
  type UpdateEngagementInput,
} from "./state.ts";
export { assertLegalEngagementTransition, legalEngagementTransitions } from "./transitions.ts";
export { validateWorkflowMap } from "./workflow-map.ts";
export { scoreOpportunity } from "./opportunity-scorer.ts";
export { validateAutomationDecision } from "./automation-decider.ts";
export { deriveRiskSeverity, validateRiskRegister } from "./risk-register.ts";
export { qualifyEngagement } from "./qualification.ts";
export { renderEngagementReport, renderEngagementSummary } from "./report.ts";
export { validateAutomationDecisionRegister, validateOpportunityMatrix, validateStakeholderRegister } from "./registers.ts";
