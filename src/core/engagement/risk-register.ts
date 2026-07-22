import { Value } from "typebox/value";
import { EngagementError } from "./errors.ts";
import { RiskRegisterSchema, type RiskRegister, type RiskSeverity } from "./schema/risk-register.ts";

export function deriveRiskSeverity(likelihood: number, impact: number): RiskSeverity {
  if (!Number.isInteger(likelihood) || !Number.isInteger(impact) || likelihood < 1 || likelihood > 5 || impact < 1 || impact > 5) {
    throw new EngagementError("invalid_artifact", "risk likelihood and impact must be integers from 1 through 5");
  }
  const score = likelihood * impact;
  if (score <= 4) return "low";
  if (score <= 9) return "moderate";
  if (score <= 16) return "high";
  return "critical";
}

export function validateRiskRegister(value: unknown, validStepIds?: ReadonlySet<string>): RiskRegister {
  if (!Value.Check(RiskRegisterSchema, value)) throw new EngagementError("invalid_artifact", "risk register failed schema validation");
  const ids = new Set<string>();
  for (const risk of value.risks) {
    if (ids.has(risk.risk_id)) throw new EngagementError("duplicate_id", `duplicate risk ID: ${risk.risk_id}`);
    ids.add(risk.risk_id);
    if (risk.severity !== deriveRiskSeverity(risk.likelihood, risk.impact)) throw new EngagementError("invalid_artifact", `risk ${risk.risk_id} has incorrect derived severity`);
    for (const stepId of risk.related_step_ids) if (validStepIds && !validStepIds.has(stepId)) throw new EngagementError("invalid_reference", `risk ${risk.risk_id} references missing step ${stepId}`);
  }
  return value;
}
