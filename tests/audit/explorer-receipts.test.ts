import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  PartialCodebaseMapSchema,
  type CodebaseMap,
} from "../../src/core/audit/schema.ts";
import {
  assessExplorerReceiptAttestation,
  ExplorerReceiptTracker,
} from "../../src/core/audit/explorer-receipts.ts";

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
  scoutConcerns?: string[];
}): unknown {
  const text = input.success
    ? `Sub-agent (mode=${input.mode}) explored ${input.targetPath ?? "."} in 10ms.\n\n`
      + (input.reportConcern
        ? `## Report\nconcern: ${input.reportConcern}\n`
        : `## Report\nconcerns:\n${(input.scoutConcerns ?? []).map((concern) => ` - concern: ${concern}`).join("\n")}\n`)
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

test("every scout proposal remains an obligation until traced or substantively rejected", () => {
  const tracker = new ExplorerReceiptTracker();
  tracker.observe(explorerEvent({
    mode: "concern_scout",
    success: true,
    scoutConcerns: ["CLI argument parsing", "TypeScript declaration surface"],
  }));
  tracker.observe(explorerEvent({
    mode: "concern_tracer",
    success: true,
    focus: "CLI argument parsing",
    reportConcern: "CLI argument parsing and value coercion",
  }));

  const map = mapWithConcerns("CLI argument parsing and value coercion");
  let assessment = tracker.assess(map);
  assert.equal(assessment.complete, false);
  assert.ok(
    assessment.reasons.some((reason) => reason.includes("TypeScript declaration surface")),
    assessment.reasons.join("; "),
  );

  map.concern_evidence!.not_concerns.push({
    candidate: "TypeScript declaration surface",
    why_rejected: "Not rejected; accepted for tracing because it is a public compatibility contract.",
  });
  assessment = tracker.assess(map);
  assert.equal(
    assessment.complete,
    false,
    "a statement that explicitly accepts the candidate is not substantive negative evidence",
  );

  map.concern_evidence!.not_concerns[0] = {
    candidate: "TypeScript declaration surface",
    why_rejected: "A public surface owned across behavioral specialists, not an independent body of knowledge.",
  };
  assessment = tracker.assess(map);
  assert.equal(assessment.complete, true, assessment.reasons.join("; "));
});

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

test("persisted explorer receipts are application-authored and bound to current HEAD", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-receipt-attestation-"));
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    fs.writeFileSync(path.join(cwd, "README.md"), "# receipt fixture\n");
    git("init", "-q");
    git("config", "user.name", "Agentify Test");
    git("config", "user.email", "agentify@example.invalid");
    git("add", ".");
    git("commit", "-qm", "receipt fixture");
    const head = git("rev-parse", "HEAD");

    const tracker = new ExplorerReceiptTracker();
    tracker.observe(explorerEvent({ mode: "concern_scout", success: true }));
    tracker.observe(explorerEvent({
      mode: "concern_tracer",
      success: true,
      focus: "Routing and route composition",
      reportConcern: "Routing and route composition",
    }));
    const map = mapWithConcerns("Routing and route composition");
    map.explorer_receipts = tracker.attestation(head, "fixture-run");
    const current = assessExplorerReceiptAttestation(map, cwd);
    assert.equal(current.complete, true, current.reasons.join("; "));

    assert.equal(
      Value.Check(PartialCodebaseMapSchema, { explorer_receipts: map.explorer_receipts }),
      false,
      "model-authored map deltas must not be able to forge explorer attestation",
    );

    fs.writeFileSync(path.join(cwd, "README.md"), "# changed fixture\n");
    git("add", ".");
    git("commit", "-qm", "advance head");
    const stale = assessExplorerReceiptAttestation(map, cwd);
    assert.equal(stale.complete, false);
    assert.ok(stale.reasons.some((reason) => /not current HEAD/i.test(reason)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
