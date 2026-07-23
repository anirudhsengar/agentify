import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendJsonLine, readJsonLines } from "../../evals/storage.ts";
import { Value } from "typebox/value";
import { EngagementError } from "../errors.ts";
import { engagementArtifactPath } from "../paths.ts";
import { MetricEventSchema, type ExecutionOrigin, type MetricEvent, type MetricEventInput } from "./schema.ts";

export type MetricStream = "run" | "review" | "outcome" | "adoption";
const FILES: Record<MetricStream, string> = { run: "run-events.jsonl", review: "review-events.jsonl", outcome: "outcome-events.jsonl", adoption: "adoption-events.jsonl" };
export function metricsDirectory(stateDir: string, engagementId: string): string {
  const root = path.dirname(engagementArtifactPath(stateDir, engagementId, "charter.json"));
  const result = path.join(root, "metrics");
  for (const candidate of [root, result]) { try { if (fs.lstatSync(candidate).isSymbolicLink()) throw new EngagementError("unsafe_path", `metrics path cannot be a symlink: ${candidate}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  return result;
}
function metricFile(stateDir: string, engagementId: string, stream: MetricStream): string {
  const target = path.join(metricsDirectory(stateDir, engagementId), FILES[stream]);
  try { if (fs.lstatSync(target).isSymbolicLink()) throw new EngagementError("unsafe_path", `metric stream cannot be a symlink: ${target}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return target;
}
export function metricEventId(input: MetricEventInput): string { return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
function streamFor(type: MetricEvent["event_type"]): MetricStream { if (type === "run_started" || type === "run_completed" || type === "readiness_recorded" || type === "plan_recorded" || type === "draft_published") return "run"; if (type === "human_review_recorded") return "review"; if (type === "adoption_recorded") return "adoption"; return "outcome"; }
export function readMetricEvents(stateDir: string, engagementId: string): MetricEvent[] {
  const events: MetricEvent[] = [];
  for (const stream of Object.keys(FILES).sort() as MetricStream[]) {
    const stored = readJsonLines<MetricEvent>(metricFile(stateDir, engagementId, stream), MetricEventSchema, `${stream} metric events`);
    events.push(...stored.map((event) => ({ ...event, execution_origin: event.execution_origin ?? "legacy_unspecified" as ExecutionOrigin })));
  }
  const ids = new Set<string>(); for (const event of events) { if (event.engagement_id !== engagementId) throw new EngagementError("corrupt_state", "metric engagement identity does not match storage path"); if (ids.has(event.event_id)) throw new EngagementError("corrupt_state", `duplicate metric event ${event.event_id}`); ids.add(event.event_id); }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id));
}
/**
 * Walks every MeasuredNumber field in a payload and enforces the invariant that
 * `value: null` requires `quality: "unavailable"` and that any present value is
 * not labelled unavailable. The earlier substring check could not verify the
 * per-field invariant if a single payload contained both a correctly-marked
 * unavailable field and an inconsistent one.
 */
function assertMeasuredQualityInvariants(payload: unknown, path: string): void {
  if (payload === null || typeof payload !== "object") return;
  for (const [key, child] of Object.entries(payload as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (Array.isArray(child)) { assertMeasuredQualityInvariants(child, childPath); continue; }
    if (child === null || typeof child !== "object") continue;
    const field = child as { value?: unknown; quality?: unknown };
    if ("value" in field && "quality" in field) {
      if (field.value === null && field.quality !== "unavailable") {
        throw new EngagementError("invalid_artifact", `${childPath}: missing value must use quality "unavailable"`);
      }
      if (field.value !== null && field.quality === "unavailable") {
        throw new EngagementError("invalid_artifact", `${childPath}: present value must not be marked "unavailable"`);
      }
    }
    assertMeasuredQualityInvariants(field, childPath);
  }
}

export function recordMetricEvent(stateDir: string, input: MetricEventInput): { event: MetricEvent; created: boolean } {
  if (!input.execution_origin) throw new EngagementError("invalid_artifact", "new metric events require explicit execution_origin");
  const event = { ...input, event_id: metricEventId(input) } as MetricEvent; const existing = readMetricEvents(stateDir, input.engagement_id).find(({ event_id }) => event_id === event.event_id);
  if (existing) return { event: existing, created: false };
  if (!Value.Check(MetricEventSchema, event)) {
    const detail = [...Value.Errors(MetricEventSchema, event)].slice(0, 8).map((error) => {
      const located = error as { path?: string; instancePath?: string; message: string };
      return `${located.path ?? located.instancePath ?? "(root)"}: ${located.message}`;
    }).join("; ");
    throw new EngagementError("invalid_artifact", `metric event failed schema validation: ${detail}`);
  }
  assertMeasuredQualityInvariants(event.payload, "payload");
  const file = metricFile(stateDir, input.engagement_id, streamFor(event.event_type)); appendJsonLine(file, event); return { event, created: true };
}
