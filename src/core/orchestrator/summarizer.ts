// summarizer.ts — event → one-line digest heuristics.
//
// Per the lessons: "every individual event here is getting summarized
// by summary agent". In this implementation we don't run a real
// summary agent — the digests are templated from event payloads.
// This keeps the orchestrator's context cheap (one line per event)
// while preserving the audit trail in `events.jsonl` for the full
// payloads.
//
// The orchestrator (or any consumer) reads the digest stream via
// `WorkflowRunner.tailSummary()` or via the orchestrator's own
// `summary.jsonl` (added elsewhere). The template functions here
// are pure: they take a known event shape and return one string.

import * as fs from "node:fs";

export interface SummaryEvent {
  at: string;
  kind: string;
  digest: string;
  agent_id?: string;
}

/**
 * Map an internal event payload into a one-line digest.
 * Returns `null` if the event kind is uninteresting (the caller
 * drops the line and keeps `events.jsonl` as the canonical record).
 */
export function summarizeEvent(event: {
  at?: string;
  kind: string;
  fields?: Record<string, unknown>;
}): string | null {
  const { kind, fields } = event;
  const f = fields ?? {};

  switch (kind) {
    case "step_started": {
      const id = (f["step_id"] as string | undefined) ?? "?";
      const handler = (f["handler"] as string | undefined) ?? "?";
      return `[${id}] starting ${handler}`;
    }
    case "step_ended": {
      const id = (f["step_id"] as string | undefined) ?? "?";
      const status = (f["status"] as string | undefined) ?? "?";
      const cost = typeof f["cost_usd"] === "number" ? (f["cost_usd"] as number) : 0;
      return `[${id}] ${status} ($${cost.toFixed(4)})`;
    }
    case "step_skipped": {
      const id = (f["step_id"] as string | undefined) ?? "?";
      const reason = (f["reason"] as string | undefined) ?? "?";
      return `[${id}] skipped (${reason})`;
    }
    case "step_retry_scheduled": {
      const id = (f["step_id"] as string | undefined) ?? "?";
      const attempt = (f["attempt"] as number | undefined) ?? 0;
      return `[${id}] retry attempt ${attempt}`;
    }
    case "step_retry_exhausted": {
      const id = (f["step_id"] as string | undefined) ?? "?";
      const attempts = (f["attempts"] as number | undefined) ?? 0;
      return `[${id}] retry exhausted (${attempts})`;
    }
    case "parallel_group_started": {
      const g = (f["group"] as string | undefined) ?? "?";
      const ids = (f["step_ids"] as string[] | undefined) ?? [];
      return `parallel[${g}] ${ids.join(",")}`;
    }
    case "parallel_group_finished": {
      const g = (f["group"] as string | undefined) ?? "?";
      const cost = typeof f["cost_usd"] === "number" ? (f["cost_usd"] as number) : 0;
      return `parallel[${g}] done ($${cost.toFixed(4)})`;
    }
    case "step_fanout_spawned": {
      const id = (f["step_id"] as string | undefined) ?? "?";
      const agentId = (f["agent_id"] as string | undefined) ?? "?";
      return `[${id}] fanout spawn ${agentId}`;
    }
    case "subagent_spawned": {
      const id = (f["step_id"] as string | undefined) ?? "?";
      const agentId = (f["agent_id"] as string | undefined) ?? "?";
      return `[${id}] spawn subagent ${agentId}`;
    }
    case "aiw_started": {
      const id = (f["step_id"] as string | undefined) ?? "?";
      const aiwId = (f["aiw_id"] as string | undefined) ?? "?";
      return `[${id}] AIW ${aiwId}`;
    }
    case "workflow_started": {
      const wf = (f["workflow"] as string | undefined) ?? "?";
      const steps = (f["steps"] as number | undefined) ?? 0;
      return `${wf} started (${steps} steps)`;
    }
    case "workflow_completed":
    case "workflow_failed": {
      const cost = typeof f["cost_usd"] === "number" ? (f["cost_usd"] as number) : 0;
      return `${kind === "workflow_completed" ? "OK" : "FAIL"} ($${cost.toFixed(4)})`;
    }
    case "workflow_dry_run_completed":
      return `dry-run OK`;
    case "workflow_validation_failed": {
      const errs = (f["errors"] as string[] | undefined) ?? [];
      return `validation failed: ${errs.slice(0, 2).join("; ")}${errs.length > 2 ? "..." : ""}`;
    }
    case "workflow_cancelled_no_live":
      return `cancelled (no live run)`;
    default:
      return null;
  }
}

/**
 * Append a digest entry to a summary.jsonl file. Writes via the
 * `summarizeEvent` heuristic; if the event isn't interesting enough,
 * no line is appended.
 */
export function appendSummaryDigest(
  filePath: string,
  event: { kind: string; digest?: string; agent_id?: string; fields?: Record<string, unknown> },
): void {
  if (event.digest) {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      kind: event.kind,
      digest: event.digest,
      agent_id: event.agent_id,
    }) + "\n";
    fs.appendFileSync(filePath, line);
    return;
  }
  const digest = summarizeEvent({ ...event, at: new Date().toISOString() });
  if (!digest) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    kind: event.kind,
    digest,
    agent_id: event.agent_id,
  }) + "\n";
  fs.appendFileSync(filePath, line);
}
