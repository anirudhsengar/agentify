import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Concern } from "../../src/core/audit/schema/concerns.ts";
import { createConcernSubmissionTool } from "../../src/core/audit/spawn-explorer-tool.ts";

// Reduced from an installed held-out team's false numeric-string rejection.
// The error-message wording does not override the executable int() coercion.
const SOURCE = 'def normalize_time(value):\n    try:\n        return int(value)\n    except ValueError:\n        raise ValueError("Time must be an integer")\n';
const FALSE_CLAIM = "Numeric-string time values cannot be accepted.";
const CORRECTION = "Numeric strings are accepted by int(); nonnumeric strings raise ValueError.";
type Review = (concern: Concern, signal?: AbortSignal) => Promise<string | null>;
const reviewedTool: (
  at: string, onSubmit: (concern: Concern) => void, cwd: string, name: string,
  required: string[], map: undefined, observed: Set<string>, review: Review,
) => ReturnType<typeof createConcernSubmissionTool> = createConcernSubmissionTool;

test("source-backed narrative contradictions block submission without deleting verified flows", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-narrative-review-"));
  try {
    fs.writeFileSync(path.join(cwd, "clock.py"), SOURCE);
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "add", "clock.py"]);
    execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-qm", "clock coercion"]);
    const concern: Concern = {
      concern: "Deadline value normalization", one_line: "Normalizes caller-supplied time values.",
      covers: "Time value conversion and malformed-input rejection.", excludes: "Clock sampling and task scheduling.",
      flows: [{ name: "Normalize a time value", description: "Convert input or reject malformed values.", steps: [
        { path: "clock.py", what_happens: "normalize_time receives a caller value." },
        { path: "clock.py", what_happens: "int(value) returns a converted integer or raises ValueError." },
      ] }],
      touchpoints: [{ path: "clock.py", symbol: "normalize_time", role: "Owns conversion and invalid-input errors.",
        line_range: null, centrality: "core" }],
      invariants: [], pitfalls: [{ risk: FALSE_CLAIM, consequence: "String-encoded deadlines fail.", reference: "clock.py" }],
      entry_questions: ["Must callers supply numeric strings?"], validation: [], spans_subtrees: [],
      stability: "high", recurrence: "high", confidence: "high", last_updated: "2026-08-31T00:00:00.000Z",
    };
    const recorded: Concern[] = [];
    let reviews = 0;
    const tool = reviewedTool(concern.last_updated, value => recorded.push(value), cwd, concern.concern,
      [], undefined, new Set(["clock.py"]), async candidate => {
        reviews += 1;
        assert.deepEqual(candidate.flows, concern.flows);
        return candidate.pitfalls[0]?.risk === FALSE_CLAIM ? `clock.py: return int(value). ${CORRECTION}` : null;
      });
    const rejected = await tool.execute("bad-narrative", { report_json: JSON.stringify(concern) },
      undefined, undefined, { cwd } as never);
    assert.equal(reviews, 1, `grounding must review narrative; recorded=${recorded.length}; result=${JSON.stringify(rejected)}`);
    assert.equal((rejected as { isError?: boolean }).isError, true);
    assert.equal(recorded.length, 0, "a contradicted body cannot receive a successful tracer checkpoint");
    const corrected = { ...concern, pitfalls: [{ ...concern.pitfalls[0]!, risk: CORRECTION,
      consequence: "Nonnumeric strings fail conversion." }] };
    const accepted = await tool.execute("corrected-narrative", { report_json: JSON.stringify(corrected) },
      undefined, undefined, { cwd } as never);
    assert.notEqual((accepted as { isError?: boolean }).isError, true);
    assert.equal(reviews, 2);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]?.flows, concern.flows);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
