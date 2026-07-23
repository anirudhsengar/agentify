import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { aggregatePilotEvents } from "../../src/core/engagement/metrics/aggregate.ts";
import { readMetricEvents, recordMetricEvent } from "../../src/core/engagement/metrics/storage.ts";
import type { MetricEventInput } from "../../src/core/engagement/metrics/schema.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-shadow-metrics-"));
}

function baseEvent(overrides: Partial<MetricEventInput>): MetricEventInput {
  return {
    schema_version: "1",
    engagement_id: "eng",
    workflow_id: "eng",
    run_id: "local-1",
    timestamp: "2026-07-22T00:00:00.000Z",
    source: "runtime",
    provenance: { quality: "measured", method: "local shadow runner", source_reference: "evidence-packet.json" },
    evidence_references: ["evidence-packet.json"],
    redaction_status: "reference_only",
    ...overrides,
  } as MetricEventInput;
}

test("recordMetricEvent accepts local shadow run_started and run_completed events", () => {
  const root = tmp();
  try {
    const started = baseEvent({
      event_type: "run_started",
      payload: { mode: "shadow", issue: "1", repository: "owner/repo", commit: "a".repeat(40), engagement: "eng", start_time: "2026-07-22T00:00:00.000Z" },
    });
    const completed = baseEvent({
      timestamp: "2026-07-22T00:01:00.000Z",
      event_type: "run_completed",
      payload: {
        final_status: "completed",
        runtime_ms: { value: 1000, quality: "measured", unit: "ms" },
        cost_accounting_status: "measured",
        measured_cost_usd: { value: 0, quality: "measured", unit: "usd" },
        estimated_cost_usd: { value: null, quality: "unavailable", unit: "usd" },
        reserved_exposure_usd: { value: null, quality: "unavailable", unit: "usd" },
        model_call_count: { value: 0, quality: "measured", unit: "count" },
        tool_call_count: { value: null, quality: "unavailable", unit: "count" },
        retry_count: { value: 0, quality: "measured", unit: "count" },
        timeout: false,
        cancellation: false,
        safety_status: "passed",
        validation_status: "passed",
      },
    });
    recordMetricEvent(root, started);
    recordMetricEvent(root, completed);
    assert.equal(readMetricEvents(root, "eng").length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recordMetricEvent records and reads back local shadow events", () => {
  const root = tmp();
  try {
    recordMetricEvent(root, baseEvent({
      event_type: "run_started",
      payload: { mode: "shadow", issue: "1", repository: "owner/repo", commit: "a".repeat(40), engagement: "eng", start_time: "2026-07-22T00:00:00.000Z" },
    }));
    recordMetricEvent(root, baseEvent({
      timestamp: "2026-07-22T00:01:00.000Z",
      event_type: "run_completed",
      payload: {
        final_status: "completed",
        runtime_ms: { value: 1000, quality: "measured", unit: "ms" },
        cost_accounting_status: "measured",
        measured_cost_usd: { value: 0, quality: "measured", unit: "usd" },
        estimated_cost_usd: { value: null, quality: "unavailable", unit: "usd" },
        reserved_exposure_usd: { value: null, quality: "unavailable", unit: "usd" },
        model_call_count: { value: 0, quality: "measured", unit: "count" },
        tool_call_count: { value: null, quality: "unavailable", unit: "count" },
        retry_count: { value: 0, quality: "measured", unit: "count" },
        timeout: false,
        cancellation: false,
        safety_status: "passed",
        validation_status: "passed",
      },
    }));
    const events = readMetricEvents(root, "eng");
    assert.equal(events.length, 2);
    const aggregate = aggregatePilotEvents(events);
    assert.equal(aggregate.costs.measured_usd, 0);
    assert.equal(aggregate.runtime_ms.sample_size, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("local shadow measured cost of zero does not imply unavailable", () => {
  const root = tmp();
  try {
    recordMetricEvent(root, baseEvent({
      timestamp: "2026-07-22T00:00:00.000Z",
      event_type: "run_completed",
      payload: {
        final_status: "completed",
        runtime_ms: { value: 1000, quality: "measured", unit: "ms" },
        cost_accounting_status: "measured",
        measured_cost_usd: { value: 0, quality: "measured", unit: "usd" },
        estimated_cost_usd: { value: null, quality: "unavailable", unit: "usd" },
        reserved_exposure_usd: { value: null, quality: "unavailable", unit: "usd" },
        model_call_count: { value: 0, quality: "measured", unit: "count" },
        tool_call_count: { value: null, quality: "unavailable", unit: "count" },
        retry_count: { value: 0, quality: "measured", unit: "count" },
        timeout: false,
        cancellation: false,
        safety_status: "passed",
        validation_status: "passed",
      },
    }));
    const events = readMetricEvents(root, "eng");
    const aggregate = aggregatePilotEvents(events);
    assert.equal(aggregate.costs.measured_usd, 0);
    assert.equal(aggregate.costs.measured_sample_size, 1);
    assert.notEqual(aggregate.costs.measured_usd, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recordMetricEvent deduplicates identical events by content hash", () => {
  const root = tmp();
  try {
    const event = baseEvent({
      event_type: "run_started",
      payload: { mode: "shadow", issue: "1", repository: "owner/repo", commit: "a".repeat(40), engagement: "eng", start_time: "2026-07-22T00:00:00.000Z" },
    });
    const first = recordMetricEvent(root, event);
    const second = recordMetricEvent(root, event);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.event.event_id, first.event.event_id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("metric stream symlink escapes are rejected for local shadow events", () => {
  const root = tmp();
  try {
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "");
    const directory = path.join(root, "engagements/eng/metrics");
    fs.mkdirSync(directory, { recursive: true });
    fs.symlinkSync(outside, path.join(directory, "run-events.jsonl"));
    assert.throws(() => recordMetricEvent(root, baseEvent({
      event_type: "run_started",
      payload: { mode: "shadow", issue: "1", repository: "owner/repo", commit: "a".repeat(40), engagement: "eng", start_time: "2026-07-22T00:00:00.000Z" },
    })), /cannot be a symlink/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});