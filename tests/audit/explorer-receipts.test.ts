import assert from "node:assert/strict";
import test from "node:test";
import type { CodebaseMap } from "../../src/core/audit/schema.ts";
import { ExplorerReceiptTracker } from "../../src/core/audit/explorer-receipts.ts";

function mapWithConcerns(...concerns: string[]): CodebaseMap {
  return {
    concern_evidence: {
      concerns: concerns.map((concern) => ({ concern })),
      not_concerns: [],
    },
  } as unknown as CodebaseMap;
}

function explorerEvent(input: {
  mode: "concern_scout" | "concern_tracer";
  success: boolean;
  focus?: string;
  reportConcern?: string;
  targetPath?: string;
  failureKind?: string;
}): unknown {
  const text = input.success
    ? `Sub-agent (mode=${input.mode}) explored ${input.targetPath ?? "."} in 10ms.\n\n`
      + (input.reportConcern ? `## Report\nconcern: ${input.reportConcern}\n` : "## Report\n")
    : `Error: sub-agent (mode=${input.mode}) for ${input.targetPath ?? "."} failed: timeout`;
  return {
    type: "tool_execution_end",
    toolName: "spawn_explorer",
    ...(input.success ? {} : { isError: true }),
    resultText: text,
    details: {
      mode: input.mode,
      target_path: input.targetPath ?? ".",
      focus: input.focus ?? null,
      report_concern: input.reportConcern ?? null,
      failure_kind: input.failureKind ?? (input.success ? null : "timeout"),
    },
  };
}

test("semantic closure requires successful scout and per-concern tracer receipts", () => {
  const tracker = new ExplorerReceiptTracker();
  const map = mapWithConcerns("Routing and route composition", "Request extraction");

  let assessment = tracker.assess(map);
  assert.equal(assessment.complete, false);
  assert.ok(assessment.reasons.some((reason) => reason.includes("concern_scout")));
  assert.deepEqual(assessment.missing_concern_tracers, [
    "Routing and route composition",
    "Request extraction",
  ]);

  tracker.observe(explorerEvent({ mode: "concern_scout", success: true }));
  tracker.observe(explorerEvent({
    mode: "concern_tracer",
    success: true,
    focus: "Routing and route composition",
    reportConcern: "Routing and route composition",
  }));
  tracker.observe(explorerEvent({
    mode: "concern_tracer",
    success: true,
    focus: "Request extraction",
    reportConcern: "Request extraction, rejection, and body parsing",
  }));

  assessment = tracker.assess(map);
  assert.equal(assessment.complete, true, assessment.reasons.join("; "));
});

test("a timed-out tracer remains unresolved instead of becoming a rejection", () => {
  const tracker = new ExplorerReceiptTracker();
  tracker.observe(explorerEvent({ mode: "concern_scout", success: true }));
  tracker.observe(explorerEvent({
    mode: "concern_tracer",
    success: false,
    focus: "Procedural macro derives and diagnostics",
    targetPath: "axum-macros",
  }));

  const incomplete = tracker.assess(mapWithConcerns(), { requiredConcerns: [] });
  assert.equal(incomplete.complete, false);
  assert.deepEqual(
    incomplete.unresolved_tracer_failures,
    ["Procedural macro derives and diagnostics (timed out)"],
  );

  tracker.observe(explorerEvent({
    mode: "concern_tracer",
    success: true,
    focus: "Procedural macro derives and diagnostics",
    reportConcern: "Procedural macro derives and diagnostics",
    targetPath: "axum-macros",
  }));
  const complete = tracker.assess(mapWithConcerns(), { requiredConcerns: [] });
  assert.equal(complete.complete, true, complete.reasons.join("; "));
});
