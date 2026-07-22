import type { OpportunityMatrix } from "./schema/opportunity.ts";
import type { QualificationResult } from "./schema/qualification.ts";
import type { RiskRegister } from "./schema/risk-register.ts";

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
