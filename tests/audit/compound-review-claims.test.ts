import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { addCompoundReviewChecks } from "../../src/core/audit/review-clauses.ts";
import { createSpecialistReviewSubmissionSchema } from "../../src/core/audit/schema/specialist-review.ts";

const reference = "cache.py";
const compound = "The predicate requires a stored value; callers can separately return None. Its condition is False for empty state, so empty state is reported expired.";
function claims(rule = compound): Record<string, unknown> {
  return { "invariants[4]": { rule, why: "Check the executable predicate.", reference },
    concern: "One state contract", validation: [] };
}
test("compound obligations preserve every original byte and inherited condition", () => {
  const original = claims();
  const before = structuredClone(original);
  const result = addCompoundReviewChecks(original, new Set([reference]));
  assert.deepEqual(original, before);
  for (const id of Object.keys(original)) assert.equal(result[id], original[id]);
  const fragments = Object.entries(result).filter(([id]) => id.startsWith("clause:"))
    .map(([, value]) => value as { original_claim: string; reference: string; assertion_fragment: string });
  assert.equal(fragments.length, 4);
  assert.equal(fragments.map(part => part.assertion_fragment).join(""), compound);
  assert.ok(fragments.every(part => part.original_claim === "invariants[4]" && part.reference === reference));
  assert.equal(fragments.at(-1)!.assertion_fragment, " so empty state is reported expired.");
  assert.deepEqual(addCompoundReviewChecks(original, new Set([reference])), result);
});
test("unread paths and single assertions retain the original whole-claim review", () => {
  const original = claims();
  assert.equal(addCompoundReviewChecks(original, new Set()), original);
  const single = claims("The value is 1.5 or a string containing `module.method; Next`.");
  assert.equal(addCompoundReviewChecks(single, new Set([reference])), single);
  const openCode = claims("The expression is `method; Next. It is quoted.");
  assert.equal(addCompoundReviewChecks(openCode, new Set([reference])), openCode);
});
test("only referenced assertion fields expand, never scope or compiler ownership", () => {
  const original = { ...claims("One predicate."), covers: compound,
    "touchpoints[0]": { path: reference, role: compound },
    "pitfalls[0]": { risk: "Absent data is missing. Present data may still fail.", consequence: "Handle both cases.", reference } };
  const result = addCompoundReviewChecks(original, new Set([reference]));
  assert.deepEqual(Object.keys(result).filter(id => id.startsWith("clause:")),
    ["clause:pitfalls[0].risk:0", "clause:pitfalls[0].risk:1"]);
});
test("claim ceiling and colliding auxiliary IDs fail rather than discard checks", () => {
  const crowded = Object.fromEntries(Array.from({ length: 510 }, (_, index) => [`claim${index}`, "Kept."]));
  assert.throws(() => addCompoundReviewChecks({ ...crowded, ...claims() }, new Set([reference])), /claim budget/);
  assert.throws(() => addCompoundReviewChecks({ ...claims(), "clause:invariants[4].rule:0": "spoof" }, new Set([reference])), /conflicts/);
});
test("supported checklists include fragments but rejection retains the exact original target", () => {
  const original = claims();
  const expanded = addCompoundReviewChecks(original, new Set([reference]));
  const schema = createSpecialistReviewSubmissionSchema(Object.keys(expanded), Object.keys(original));
  assert.equal(Value.Check(schema, { verdict: "supported", checked_claims: Object.keys(expanded) }), true);
  const finding = { claim: "invariants[4]", path: reference, excerpt: "return value is not None", reason: "Empty state returns False." };
  assert.equal(Value.Check(schema, { verdict: "unsupported", checked_claims: [], finding }), true);
  assert.equal(Value.Check(schema, { verdict: "unsupported", checked_claims: [], finding: { ...finding, claim: "clause:invariants[4].rule:0" } }), false);
});
