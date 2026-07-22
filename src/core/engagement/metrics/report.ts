import type { EngagementCharter } from "../schema/engagement-charter.ts";
import { aggregatePilotEvents } from "./aggregate.ts";
import type { MetricEvent } from "./schema.ts";

/**
 * Redact credential- and secret-shaped substrings from any operator-supplied
 * text that flows into the rendered pilot report. Mirrors the defensive
 * patterns already used by `run-shadow.mjs`; reports must never echo tokens,
 * private keys, or `token=...` query parameters verbatim.
 */
function redactForReport(value: string): string {
  return value.slice(0, 8_000)
    .replace(/(gh[psoru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gi, "[REDACTED]")
    .replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED]");
}

export function renderPilotReport(charter: EngagementCharter, events: readonly MetricEvent[]): string {
  const a = aggregatePilotEvents(events); const dates = events.map((e) => e.timestamp).sort(); const reviews = events.filter((e) => e.event_type === "human_review_recorded"); const incidents = events.filter((e) => e.event_type === "incident_recorded"); const baselines = events.filter((e) => e.event_type === "baseline_recorded");
  const conclusion = !events.length ? "no_pilot_data" : a.runs.safety_failures || incidents.some((e) => e.payload.severity === "critical" && e.payload.status !== "resolved") ? "safety_blocked" : a.runs.total < 5 ? "insufficient_sample" : reviews.length < a.runs.draft ? "human_review_incomplete" : "collecting_data";
  const fmt = (value: number | null) => value === null ? "unavailable" : String(value);
  // `provenance.method` is operator-supplied for human-supplied events; the
  // shadow/draft scaffold produces it from controlled text. Redact either way
  // so secrets cannot be embedded through either path.
  const provenance = [...new Set(events.map((e) => `${e.provenance.quality}: ${redactForReport(e.provenance.method)}`))].sort();
  return `# Pilot report

Engagement: ${charter.engagement_id}
Workflow: ${charter.workflow_name}
Pilot period: ${dates.length ? `${dates[0]} to ${dates.at(-1)}` : "no data"}
Conclusion: ${conclusion}

## Data provenance
${provenance.length ? provenance.map((v) => `- ${v}`).join("\n") : "- unavailable"}

## Baseline data
- records: ${baselines.length}

## Shadow runs
- count: ${a.runs.shadow}

## Draft runs
- count: ${a.runs.draft}

## Runtime
- p50 ms: ${fmt(a.runtime_ms.p50)}
- p95 ms: ${fmt(a.runtime_ms.p95)}
- sample size: ${a.runtime_ms.sample_size}

## Cost
- measured USD: ${fmt(a.costs.measured_usd)} (n=${a.costs.measured_sample_size})
- estimated USD: ${fmt(a.costs.estimated_usd)} (n=${a.costs.estimated_sample_size})
- reserved exposure is not spend and is not aggregated as cost

## Quality outcomes
- completions: ${a.runs.completed}/${a.runs.total}
- safety failures: ${a.runs.safety_failures}

## Human reviews
- records: ${reviews.length}
- major-rework rate: ${fmt(a.major_rework_rate)}
- rejection rate: ${fmt(a.rejection_rate)}

## Interventions
- count: ${a.intervention_count}

## Incidents
- count: ${incidents.length}

## Adoption observations
- repeat-use records: ${a.repeat_use_count}

## Missing evidence
${a.runs.total === 0 ? "- runtime pilot evidence\n- human review evidence\n- adoption evidence" : "- fields marked unavailable remain missing and are never treated as zero"}

## Small-sample warnings
- ${a.sample_warning ?? "none recorded; sample size alone does not prove causality or business value"}

## Open risks
- This instrumentation does not prove ROI, business value, product-market fit, readiness to scale, or readiness for autonomous operation.
- Repeated real pilots and a separate productization review remain required.
`;
}
