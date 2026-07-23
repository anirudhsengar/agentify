import type { MetricEvent } from "./schema.ts";

type ExecutionOrigin = Exclude<MetricEvent["execution_origin"], undefined>;
interface Summary { sample_size: number; p50: number | null; p95: number | null }
export interface PilotAggregates {
  schema_version: "1";
  sample_warning: string | null;
  runs: { total: number; shadow: number; draft: number; completed: number; completion_rate: number | null; failure_rate: number | null; cancellations: number; timeouts: number; safety_failures: number };
  runs_by_execution_origin: Record<ExecutionOrigin, { started: number; terminal: number; completed: number; failed: number }>;
  escalation_count: number;
  costs: { measured_usd: number | null; measured_sample_size: number; estimated_usd: number | null; estimated_sample_size: number };
  runtime_ms: Summary;
  time_to_plan_ms: Summary;
  time_to_draft_ms: Summary;
  review_minutes: Summary;
  acceptance_counts: Record<string, number>;
  major_rework_rate: number | null;
  rejection_rate: number | null;
  intervention_count: number;
  repeat_use_count: number;
}

const ORIGINS: ExecutionOrigin[] = ["github_live_shadow", "live_local_shadow", "github_draft", "synthetic", "imported", "no_execution", "operator", "evaluation", "legacy_unspecified"];
function percentile(values: number[], percentileValue: number): number | null { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1]!; }
function summary(values: number[]): Summary { return { sample_size: values.length, p50: percentile(values, 50), p95: percentile(values, 95) }; }
function present(field: { value: number | null; quality: string }): number[] { return field.value === null || field.quality === "unavailable" ? [] : [field.value]; }

export function aggregatePilotEvents(events: readonly MetricEvent[]): PilotAggregates {
  const starts = events.filter((event) => event.event_type === "run_started");
  const completions = events.filter((event) => event.event_type === "run_completed");
  const reviews = events.filter((event) => event.event_type === "human_review_recorded");
  const acceptance: Record<string, number> = {};
  for (const review of reviews) acceptance[review.payload.outcome] = (acceptance[review.payload.outcome] ?? 0) + 1;
  const measured = completions.flatMap((event) => event.payload.measured_cost_usd.quality === "measured" ? present(event.payload.measured_cost_usd) : []);
  const estimated = completions.flatMap((event) => event.payload.estimated_cost_usd.quality === "estimated" ? present(event.payload.estimated_cost_usd) : []);
  const rate = (count: number, total: number) => total ? count / total : null;
  const failed = completions.filter((event) => event.payload.final_status === "failed" || event.payload.final_status === "rejected" || event.payload.final_status === "timed_out").length;
  const runsByOrigin = Object.fromEntries(ORIGINS.map((origin) => {
    const originStarts = starts.filter((event) => event.execution_origin === origin);
    const originTerminals = completions.filter((event) => event.execution_origin === origin);
    return [origin, {
      started: originStarts.length,
      terminal: originTerminals.length,
      completed: originTerminals.filter((event) => event.payload.final_status === "completed").length,
      failed: originTerminals.filter((event) => event.payload.final_status !== "completed").length,
    }];
  })) as PilotAggregates["runs_by_execution_origin"];
  const completed = completions.filter((event) => event.payload.final_status === "completed").length;
  return {
    schema_version: "1",
    sample_warning: starts.length < 5 ? `small sample: ${starts.length} run(s); do not infer business outcomes` : null,
    runs: {
      total: starts.length,
      shadow: starts.filter((event) => event.payload.mode === "shadow").length,
      draft: starts.filter((event) => event.payload.mode === "draft").length,
      completed,
      completion_rate: rate(completed, starts.length),
      failure_rate: rate(failed, starts.length),
      cancellations: completions.filter((event) => event.payload.cancellation).length,
      timeouts: completions.filter((event) => event.payload.timeout).length,
      safety_failures: completions.filter((event) => event.payload.safety_status === "failed").length,
    },
    runs_by_execution_origin: runsByOrigin,
    escalation_count: events.filter((event) => event.event_type === "readiness_recorded").reduce((count, event) => count + event.payload.escalations.length, 0),
    costs: { measured_usd: measured.length ? measured.reduce((a, b) => a + b, 0) : null, measured_sample_size: measured.length, estimated_usd: estimated.length ? estimated.reduce((a, b) => a + b, 0) : null, estimated_sample_size: estimated.length },
    runtime_ms: summary(completions.flatMap((event) => present(event.payload.runtime_ms))),
    time_to_plan_ms: summary(events.filter((event) => event.event_type === "plan_recorded").flatMap((event) => present(event.payload.time_to_first_plan_ms))),
    time_to_draft_ms: summary(events.filter((event) => event.event_type === "draft_published").flatMap((event) => present(event.payload.time_to_draft_ms))),
    review_minutes: summary(reviews.flatMap((event) => present(event.payload.review_minutes))),
    acceptance_counts: acceptance,
    major_rework_rate: rate(acceptance.major_rework ?? 0, reviews.length),
    rejection_rate: rate(acceptance.rejected ?? 0, reviews.length),
    intervention_count: events.filter((event) => event.event_type === "intervention_recorded").length,
    repeat_use_count: events.filter((event) => event.event_type === "adoption_recorded" && event.payload.repeated_use).length,
  };
}
