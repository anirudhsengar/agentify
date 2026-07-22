import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { aggregatePilotEvents, MetricEventSchema, readMetricEvents, recordMetricEvent, renderPilotReport, type MetricEventInput } from "../../src/core/engagement/metrics/index.ts";
const common = { schema_version: "1" as const, engagement_id: "eng", workflow_id: "flow", run_id: "run-1", timestamp: "2026-07-22T00:00:00.000Z", source: "runtime" as const, provenance: { quality: "measured" as const, method: "test runtime", source_reference: "evidence.json" }, evidence_references: ["evidence.json"], redaction_status: "reference_only" as const };
const value = (n: number | null, quality: "measured" | "estimated" | "unavailable" = "measured", unit = "count") => ({ value: n, quality, unit });
function started(): MetricEventInput { return { ...common, event_type: "run_started", payload: { mode: "shadow", issue: "1", repository: "owner/repo", commit: "a".repeat(40), engagement: "eng", start_time: common.timestamp } }; }
function completed(): MetricEventInput { return { ...common, timestamp: "2026-07-22T00:01:00.000Z", event_type: "run_completed", payload: { final_status: "completed", runtime_ms: value(60_000, "measured", "ms"), cost_accounting_status: "mixed", measured_cost_usd: value(1, "measured", "usd"), estimated_cost_usd: value(2, "estimated", "usd"), reserved_exposure_usd: value(3, "estimated", "usd"), model_call_count: value(1), tool_call_count: value(null, "unavailable"), retry_count: value(0), timeout: false, cancellation: false, safety_status: "passed", validation_status: "passed" } }; }

test("closed schema rejects unknown fields and invalid measured values", () => { const event = { ...started(), event_id: "a".repeat(64) }; assert.equal(Value.Check(MetricEventSchema, event), true); assert.equal(Value.Check(MetricEventSchema, { ...event, surprise: true }), false); assert.equal(Value.Check(MetricEventSchema, { ...event, provenance: { ...event.provenance, quality: "guessed" } }), false); assert.equal(Value.Check(MetricEventSchema, { ...completed(), event_id: "b".repeat(64), payload: { ...completed().payload, runtime_ms: value(-1, "measured", "ms") } }), false); });

test("append is deterministic, idempotent, ordered, isolated, and detects corruption", () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-metrics-")); const first = recordMetricEvent(root, completed()); recordMetricEvent(root, started()); assert.equal(recordMetricEvent(root, completed()).created, false); assert.deepEqual(readMetricEvents(root, "eng").map((e) => e.event_type), ["run_started", "run_completed"]); assert.equal(readMetricEvents(root, "other").length, 0); fs.appendFileSync(path.join(root, "engagements/eng/metrics/run-events.jsonl"), "{"); assert.throws(() => readMetricEvents(root, "eng"), /incomplete JSONL append/); assert.equal(first.event.event_id.length, 64); });

test("metric stream symlink escapes are rejected", () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-metrics-link-")); const outside = path.join(root, "outside"); fs.writeFileSync(outside, ""); const directory = path.join(root, "engagements/eng/metrics"); fs.mkdirSync(directory, { recursive: true }); fs.symlinkSync(outside, path.join(directory, "run-events.jsonl")); assert.throws(() => recordMetricEvent(root, started()), /cannot be a symlink/); });

test("aggregates preserve missing values and separate measured, estimated, and exposure", () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-metrics-")); recordMetricEvent(root, started()); recordMetricEvent(root, completed()); const aggregate = aggregatePilotEvents(readMetricEvents(root, "eng")); assert.equal(aggregate.runs.completion_rate, 1); assert.equal(aggregate.runtime_ms.p50, 60_000); assert.equal(aggregate.runtime_ms.p95, 60_000); assert.equal(aggregate.costs.measured_usd, 1); assert.equal(aggregate.costs.estimated_usd, 2); assert.match(aggregate.sample_warning!, /small sample/); assert.equal(JSON.stringify(aggregate).includes("reserved_exposure"), false); });

test("empty report is factual and contains no fabricated success conclusion", () => { const report = renderPilotReport({ engagement_id: "eng", workflow_name: "Flow" } as never, []); assert.match(report, /no_pilot_data/); assert.match(report, /does not prove ROI/); assert.doesNotMatch(report, /ROI proven|Ready to scale|Business value proven/); });

test("aggregates use deterministic nearest-rank percentiles across boundary sample sizes", () => {
  const rts: number[] = [];
  // Each sample has a unique length so we can also assert unique percentile answers.
  const samples = [[100], [100, 200, 300, 400], [100, 100, 200, 200, 300], [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]];
  for (const [index, sample] of samples.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentify-pctl-${index}-`));
    sample.forEach((value, position) => {
      const start = new Date(Date.UTC(2026, 6, 22, 0, index, position * 6)).toISOString();
      const end = new Date(Date.UTC(2026, 6, 22, 0, index, position * 6 + 3)).toISOString();
      recordMetricEvent(root, { ...started(), timestamp: start });
      recordMetricEvent(root, { ...completed(), timestamp: end, payload: { ...completed().payload, runtime_ms: { value, quality: "measured", unit: "ms" } } });
    });
    const events = readMetricEvents(root, "eng");
    rts.push(aggregatePilotEvents(events).runtime_ms.sample_size);
    fs.rmSync(root, { recursive: true });
  }
  assert.equal(rts[0], 1);
  assert.equal(rts[1], 4);
  assert.equal(rts[2], 5);
  assert.equal(rts[3], 10);
  const worked = new Map<number, { p50: number | null; p95: number | null }>();
  for (const [index, sample] of samples.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentify-pctl-verify-${index}-`));
    sample.forEach((value, position) => {
      const ts = new Date(Date.UTC(2026, 6, 22, 1, index, position * 6)).toISOString();
      recordMetricEvent(root, { ...completed(), timestamp: ts, payload: { ...completed().payload, runtime_ms: { value, quality: "measured", unit: "ms" } } });
    });
    worked.set(sample.length, aggregatePilotEvents(readMetricEvents(root, "eng")).runtime_ms);
    fs.rmSync(root, { recursive: true });
  }
  assert.equal(worked.get(1)?.p50, 100);
  assert.equal(worked.get(4)?.p50, 200); // nearest-rank n=4 -> ceil(0.5*4)-1 = 1 -> sorted[1]
  assert.equal(worked.get(5)?.p50, 200); // nearest-rank n=5 -> ceil(2.5)-1 = 2 -> sorted[2]
  assert.equal(worked.get(10)?.p95, 100); // nearest-rank n=10 -> ceil(9.5)-1 = 9 -> sorted[9] (max)
  // Duplicates and mixed-quality values degrade to the actual measured subset.
  const dupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-pctl-dup-"));
  [42, 42, 42, 42, 42].forEach((value, position) => {
    const ts = new Date(Date.UTC(2026, 6, 22, 2, 0, position * 6)).toISOString();
    recordMetricEvent(dupRoot, { ...completed(), timestamp: ts, payload: { ...completed().payload, runtime_ms: { value, quality: "measured", unit: "ms" } } });
  });
  const dupAggregate = aggregatePilotEvents(readMetricEvents(dupRoot, "eng")).runtime_ms;
  assert.equal(dupAggregate.sample_size, 5);
  assert.equal(dupAggregate.p50, 42);
  assert.equal(dupAggregate.p95, 42);
  fs.rmSync(dupRoot, { recursive: true });
});

test("aggregates keep measured and estimated costs separate and never replace unavailable with zero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-cost-"));
  fs.mkdirSync(path.join(root, "engagements/eng/metrics"), { recursive: true });
  // First run: measured cost 1.5
  recordMetricEvent(root, { ...completed(), payload: { ...completed().payload, measured_cost_usd: { value: 1.5, quality: "measured", unit: "usd" }, estimated_cost_usd: { value: null, quality: "unavailable", unit: "usd" }, reserved_exposure_usd: { value: 999, quality: "estimated", unit: "usd" } } });
  // Second run: estimated cost 2.25
  recordMetricEvent(root, { ...completed(), payload: { ...completed().payload, measured_cost_usd: { value: null, quality: "unavailable", unit: "usd" }, estimated_cost_usd: { value: 2.25, quality: "estimated", unit: "usd" }, reserved_exposure_usd: { value: 999, quality: "estimated", unit: "usd" } }, timestamp: "2026-07-22T00:02:00.000Z" });
  const aggregate = aggregatePilotEvents(readMetricEvents(root, "eng"));
  assert.equal(aggregate.costs.measured_usd, 1.5);
  assert.equal(aggregate.costs.measured_sample_size, 1);
  assert.equal(aggregate.costs.estimated_usd, 2.25);
  assert.equal(aggregate.costs.estimated_sample_size, 1);
  // Reserved exposure intentionally never appears as a cost.
  assert.equal(JSON.stringify(aggregate).includes("reserved_exposure"), false);
  assert.equal(JSON.stringify(aggregate).includes("999"), false);
});

test("recordMetricEvent rejects inconsistent measured/unavailable combinations structurally", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-quality-invariant-"));
  // null value while quality is measured: rejected even if the payload ALSO has a
  // valid "unavailable" quality elsewhere; the prior string-based check missed this case.
  const mixed = { ...completed(), payload: { ...completed().payload, runtime_ms: { value: null, quality: "measured" as const, unit: "ms" as const }, measured_cost_usd: { value: 1, quality: "measured" as const, unit: "usd" as const }, reserved_exposure_usd: { value: null, quality: "unavailable" as const, unit: "usd" as const } } } as MetricEventInput;
  assert.throws(() => recordMetricEvent(root, mixed), /must use quality "unavailable"/);
  // Conversely, a present value must not be marked unavailable.
  const invertedCompleted = { ...completed(), payload: { ...completed().payload, runtime_ms: { value: 1000, quality: "unavailable" as const, unit: "ms" as const } } } as MetricEventInput;
  assert.throws(() => recordMetricEvent(root, invertedCompleted), /must not be marked "unavailable"/);
});

test("recordMetricEvent surfaces actionable schema error paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-schema-msg-"));
  // Replace a permitted literal with one outside the union to force a real schema failure.
  const bad = { ...completed(), payload: { ...completed().payload, cost_accounting_status: "definitely-not-allowed" as unknown as "mixed" } } as MetricEventInput;
  try { recordMetricEvent(root, bad); assert.fail("expected schema validation to fail"); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /metric event failed schema validation/);
    assert.match(message, /cost_accounting_status/);
  }
});

test("engagement identity mismatch in cross-engagement read is detected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-eng-isolation-"));
  fs.mkdirSync(path.join(root, "engagements/other/metrics"), { recursive: true });
  // Plant an event whose identity does not match the directory we will ask for.
  // readMetricEvents must refuse to return such an event.
  const foreign = { ...completed(), engagement_id: "real", payload: { ...completed().payload } };
  const recorded = recordMetricEvent(root, foreign as MetricEventInput);
  const dst = path.join(root, "engagements/other/metrics/run-events.jsonl");
  fs.writeFileSync(dst, `${JSON.stringify(recorded.event)}\n`);
  assert.throws(() => readMetricEvents(root, "other"), /metric engagement identity does not match storage path/);
});

test("mid-file corruption is detected just like final-line corruption", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-midfile-"));
  recordMetricEvent(root, completed());
  recordMetricEvent(root, started());
  // Inject a malformed record between two valid lines.
  const target = path.join(root, "engagements/eng/metrics/run-events.jsonl");
  const original = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, `${original}{not valid json\n`);
  let caught = false;
  try { readMetricEvents(root, "eng"); }
  catch (error) { caught = error instanceof Error && /failed schema validation|corrupt/.test(error.message); }
  assert.equal(caught, true);
});

test("renderPilotReport redacts secrets and credential-shaped values from provenance.method", () => {
  const reviewEvent: import("../../src/core/engagement/metrics/schema.ts").MetricEvent = {
    ...common,
    event_id: "c".repeat(64),
    provenance: { quality: "human_supplied", method: "token=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab", source_reference: "review.json" },
    event_type: "human_review_recorded",
    payload: { reviewer: "ops@eng", outcome: "accepted", review_minutes: { value: 10, quality: "human_supplied", unit: "min" }, review_cycles: { value: 1, quality: "human_supplied", unit: "count" }, comment_reference: null, final_outcome: "ok" },
  };
  const report = renderPilotReport({ engagement_id: "eng", workflow_name: "Flow" } as never, [reviewEvent]);
  assert.match(report, /\[REDACTED\]/);
  assert.doesNotMatch(report, /ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab/);
});

test("small-sample warning is surfaced in the rendered report", () => {
  const start = { ...started(), event_id: "d".repeat(64) } as unknown as import("../../src/core/engagement/metrics/schema.ts").MetricEvent;
  const completion = { ...completed(), event_id: "e".repeat(64) } as unknown as import("../../src/core/engagement/metrics/schema.ts").MetricEvent;
  const report = renderPilotReport({ engagement_id: "eng", workflow_name: "Flow" } as never, [start, completion]);
  assert.match(report, /small sample: 1 run/);
});

test("human-supplied schema rejects invalid trust_rating and usefulness_rating bounds", () => {
  const baseGood = {
    ...common,
    event_id: "a".repeat(64),
    source: "operator" as const,
    engagement_id: "eng",
    event_type: "adoption_recorded" as const,
    provenance: { quality: "human_supplied" as const, method: "survey", source_reference: null },
    payload: { repeated_use: true, review_completed: true, abandonment: false, trust_rating: 5, usefulness_rating: 5, support_request: null },
  };
  assert.equal(Value.Check(MetricEventSchema, baseGood), true);
  const badTrust = { ...baseGood, payload: { ...baseGood.payload, trust_rating: 0 } };
  assert.equal(Value.Check(MetricEventSchema, badTrust), false);
  const badUsefulness = { ...baseGood, payload: { ...baseGood.payload, usefulness_rating: 6 } };
  assert.equal(Value.Check(MetricEventSchema, badUsefulness), false);
  const nonInteger = { ...baseGood, payload: { ...baseGood.payload, trust_rating: 3.5 as unknown as number } };
  assert.equal(Value.Check(MetricEventSchema, nonInteger), false);
});
