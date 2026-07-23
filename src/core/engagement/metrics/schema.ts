import { Type, type Static, type TSchema } from "typebox";

export const EvidenceQualitySchema = Type.Union([
  Type.Literal("measured"), Type.Literal("human_supplied"), Type.Literal("derived"),
  Type.Literal("estimated"), Type.Literal("unavailable"),
]);
export const ProvenanceSchema = Type.Object({
  quality: EvidenceQualitySchema,
  method: Type.String({ minLength: 1, maxLength: 200 }),
  source_reference: Type.Union([Type.String({ minLength: 1, maxLength: 2_000 }), Type.Null()]),
}, { additionalProperties: false });
const MeasuredNumber = (minimum = 0) => Type.Object({
  value: Type.Union([Type.Number({ minimum }), Type.Null()]), quality: EvidenceQualitySchema,
  unit: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });
const StringList = Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 200 });
export const ExecutionOriginSchema = Type.Union([
  Type.Literal("github_live_shadow"), Type.Literal("live_local_shadow"), Type.Literal("github_draft"),
  Type.Literal("synthetic"), Type.Literal("imported"), Type.Literal("no_execution"),
  Type.Literal("operator"), Type.Literal("evaluation"), Type.Literal("legacy_unspecified"),
]);
export type ExecutionOrigin = Static<typeof ExecutionOriginSchema>;
const Common = {
  schema_version: Type.Literal("1"), event_id: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  engagement_id: Type.String({ minLength: 1, maxLength: 128 }), workflow_id: Type.String({ minLength: 1, maxLength: 128 }),
  run_id: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]), timestamp: Type.String({ format: "date-time" }),
  source: Type.Union([Type.Literal("runtime"), Type.Literal("github"), Type.Literal("operator"), Type.Literal("evaluation")]),
  execution_origin: Type.Optional(ExecutionOriginSchema),
  provenance: ProvenanceSchema, evidence_references: StringList,
  redaction_status: Type.Union([Type.Literal("redacted"), Type.Literal("not_required"), Type.Literal("reference_only")]),
};
function event<T extends string, P extends TSchema>(eventType: T, payload: P) {
  return Type.Object({ ...Common, event_type: Type.Literal(eventType), payload }, { additionalProperties: false });
}
export const RunStartedEventSchema = event("run_started", Type.Object({ mode: Type.Union([Type.Literal("shadow"), Type.Literal("draft")]), issue: Type.String({ minLength: 1, maxLength: 300 }), repository: Type.String({ minLength: 1, maxLength: 300 }), commit: Type.String({ pattern: "^[0-9a-f]{40}$" }), engagement: Type.String({ minLength: 1, maxLength: 128 }), start_time: Type.String({ format: "date-time" }) }, { additionalProperties: false }));
export const RunCompletedEventSchema = event("run_completed", Type.Object({ final_status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("timed_out"), Type.Literal("rejected")]), runtime_ms: MeasuredNumber(), cost_accounting_status: Type.Union([Type.Literal("measured"), Type.Literal("estimated"), Type.Literal("mixed"), Type.Literal("unavailable"), Type.Literal("rejected")]), measured_cost_usd: MeasuredNumber(), estimated_cost_usd: MeasuredNumber(), reserved_exposure_usd: MeasuredNumber(), model_call_count: MeasuredNumber(), tool_call_count: MeasuredNumber(), retry_count: MeasuredNumber(), timeout: Type.Boolean(), cancellation: Type.Boolean(), safety_status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("unavailable")]), validation_status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run"), Type.Literal("unavailable")]) }, { additionalProperties: false }));
export const ReadinessRecordedEventSchema = event("readiness_recorded", Type.Object({ readiness: Type.Union([Type.Literal("ready"), Type.Literal("needs_information"), Type.Literal("rejected"), Type.Literal("requires_human_decision")]), missing_information: StringList, escalations: StringList, evidence_references: StringList }, { additionalProperties: false }));
export const PlanRecordedEventSchema = event("plan_recorded", Type.Object({ time_to_first_plan_ms: MeasuredNumber(), candidate_file_count: MeasuredNumber(), proposed_test_count: MeasuredNumber(), risk_count: MeasuredNumber(), human_escalation_required: Type.Boolean() }, { additionalProperties: false }));
export const DraftPublishedEventSchema = event("draft_published", Type.Object({ pr_number: Type.Integer({ minimum: 1 }), pr_url: Type.String({ pattern: "^https://" }), branch: Type.String({ minLength: 1, maxLength: 255 }), publication: Type.Union([Type.Literal("recovered"), Type.Literal("newly_created")]), time_to_draft_ms: MeasuredNumber(), validation_status: Type.Union([Type.Literal("passed"), Type.Literal("failed_allowed")]) }, { additionalProperties: false }));
export const HumanReviewRecordedEventSchema = event("human_review_recorded", Type.Object({ reviewer: Type.String({ minLength: 1, maxLength: 300 }), outcome: Type.Union([Type.Literal("accepted"), Type.Literal("accepted_with_minor_changes"), Type.Literal("major_rework"), Type.Literal("rejected"), Type.Literal("safety_concern")]), review_minutes: MeasuredNumber(), review_cycles: MeasuredNumber(), comment_reference: Type.Union([Type.String({ minLength: 1, maxLength: 2_000 }), Type.Null()]), final_outcome: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }));
export const InterventionRecordedEventSchema = event("intervention_recorded", Type.Object({ category: Type.String({ minLength: 1, maxLength: 128 }), workflow_step: Type.String({ minLength: 1, maxLength: 200 }), reason: Type.String({ minLength: 1, maxLength: 1_000 }), actor: Type.String({ minLength: 1, maxLength: 300 }), time_spent_minutes: MeasuredNumber(), evidence: StringList }, { additionalProperties: false }));
export const IncidentRecordedEventSchema = event("incident_recorded", Type.Object({ category: Type.String({ minLength: 1, maxLength: 128 }), severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]), detection: Type.String({ minLength: 1, maxLength: 1_000 }), impact: Type.String({ minLength: 1, maxLength: 1_000 }), recovery: Type.String({ minLength: 1, maxLength: 1_000 }), status: Type.Union([Type.Literal("open"), Type.Literal("mitigated"), Type.Literal("resolved")]), evidence: StringList }, { additionalProperties: false }));
export const AdoptionRecordedEventSchema = event("adoption_recorded", Type.Object({ repeated_use: Type.Boolean(), review_completed: Type.Boolean(), abandonment: Type.Boolean(), trust_rating: Type.Union([Type.Integer({ minimum: 1, maximum: 5 }), Type.Null()]), usefulness_rating: Type.Union([Type.Integer({ minimum: 1, maximum: 5 }), Type.Null()]), support_request: Type.Union([Type.String({ minLength: 1, maxLength: 1_000 }), Type.Null()]) }, { additionalProperties: false }));
export const BaselineRecordedEventSchema = event("baseline_recorded", Type.Object({ manual_workflow_duration_minutes: MeasuredNumber(), review_duration_minutes: MeasuredNumber(), review_cycles: MeasuredNumber(), failure_rate: MeasuredNumber(), cost_usd: MeasuredNumber(), collection_method: Type.Union([Type.Literal("historical_repository_evidence"), Type.Literal("maintainer_provided"), Type.Literal("direct_observation"), Type.Literal("structured_estimate")]), sample_size: Type.Integer({ minimum: 1 }), time_window: Type.String({ minLength: 1, maxLength: 300 }), data_provenance: Type.Array(ProvenanceSchema, { minItems: 1, maxItems: 50 }) }, { additionalProperties: false }));
export const MetricEventSchema = Type.Union([RunStartedEventSchema, RunCompletedEventSchema, ReadinessRecordedEventSchema, PlanRecordedEventSchema, DraftPublishedEventSchema, HumanReviewRecordedEventSchema, InterventionRecordedEventSchema, IncidentRecordedEventSchema, AdoptionRecordedEventSchema, BaselineRecordedEventSchema]);
export type MetricEvent = Static<typeof MetricEventSchema>;
export type MetricEventInput = Omit<MetricEvent, "event_id"> & { execution_origin: ExecutionOrigin };
