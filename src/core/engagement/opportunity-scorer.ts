import { Value } from "typebox/value";
import { EngagementError } from "./errors.ts";
import { OpportunityCandidateSchema, type OpportunityCandidate, type ScoredOpportunity } from "./schema/opportunity.ts";

const WEIGHTS = {
  business_value: 0.25, volume: 0.10, feasibility: 0.15, adoption_readiness: 0.10,
  evaluation_feasibility: 0.10, reversibility: 0.05, data_availability: 0.10,
  integration_availability: 0.05, implementation_simplicity: 0.10,
} as const;
const round = (value: number): number => Math.round(value * 100) / 100;
const clamp = (value: number): number => Math.min(100, Math.max(0, value));

export function scoreOpportunity(value: unknown): ScoredOpportunity {
  if (!Value.Check(OpportunityCandidateSchema, value)) {
    throw new EngagementError("invalid_score", "opportunity requires every explicit score in the 0-100 range");
  }
  const candidate: OpportunityCandidate = value;
  const contributions = {
    business_value: round(clamp(candidate.business_value) * WEIGHTS.business_value),
    volume: round(clamp(candidate.volume) * WEIGHTS.volume),
    feasibility: round(clamp(candidate.feasibility) * WEIGHTS.feasibility),
    adoption_readiness: round(clamp(candidate.adoption_readiness) * WEIGHTS.adoption_readiness),
    evaluation_feasibility: round(clamp(candidate.evaluation_feasibility) * WEIGHTS.evaluation_feasibility),
    reversibility: round(clamp(candidate.reversibility) * WEIGHTS.reversibility),
    data_availability: round(clamp(candidate.data_availability) * WEIGHTS.data_availability),
    integration_availability: round(clamp(candidate.integration_availability) * WEIGHTS.integration_availability),
    implementation_simplicity: round((100 - clamp(candidate.implementation_complexity)) * WEIGHTS.implementation_simplicity),
  };
  const weightedValue = round(Object.values(contributions).reduce((sum, score) => sum + score, 0));
  const riskPenalty = round(clamp(candidate.risk) * 0.25);
  const finalScore = round(clamp(weightedValue - riskPenalty));
  let recommendation: ScoredOpportunity["recommendation"];
  let reason: string;
  if (candidate.rejection_reason !== null || candidate.risk >= 90) {
    recommendation = "reject"; reason = candidate.rejection_reason ?? "Risk is at or above the rejection threshold.";
  } else if (candidate.risk >= 70) {
    recommendation = "defer"; reason = "High risk requires mitigation before proceeding.";
  } else if (finalScore >= 70 && candidate.evaluation_feasibility >= 60) {
    recommendation = "prioritize"; reason = "Adjusted score and evaluation feasibility meet prioritization thresholds.";
  } else if (finalScore >= 55 && candidate.evaluation_feasibility >= 50) {
    recommendation = "pilot"; reason = "Adjusted score supports a bounded, measurable pilot.";
  } else if (finalScore >= 35) {
    recommendation = "investigate"; reason = "Evidence warrants investigation but not a pilot commitment.";
  } else {
    recommendation = "defer"; reason = "Adjusted score is below the investigation threshold.";
  }
  return { candidate, score: { weighted_value_score: weightedValue, risk_score: candidate.risk, risk_penalty: riskPenalty, final_score: finalScore, contributions }, recommendation, recommendation_reasons: [reason] };
}
