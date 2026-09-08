import assert from "node:assert/strict";
import test from "node:test";
import { expandPrecheckClauses } from "../../src/core/audit/precheck-clauses.ts";

test("compound prechecks preserve every field and bind each fragment to its original claim", () => {
  const originals = {
    "invariants[4]": {
      rule: "The guard requires a present entry; an empty entry is not present, so empty input returns True. π stays unchanged.",
      why: "The predicate evaluates presence AND age. The getter separately handles absence.",
      reference: "cache.py",
    },
    "pitfalls[2]": { risk: "A missing entry returns None.", consequence: "Do not assume presence.", reference: "cache.py" },
  };
  const before = JSON.stringify(originals);
  const plan = expandPrecheckClauses(originals)!;
  assert.ok(plan);
  assert.equal(plan.original_claim_context, originals);
  assert.ok(Object.values(plan.claims).some(clause => clause.text.startsWith("so empty input returns True.")),
    "the consequence clause must be checked independently of the true premise");
  for (const [id, original] of Object.entries(originals)) {
    for (const [field, text] of Object.entries(original)) {
      if (field === "reference") continue;
      const parts = Object.values(plan.claims).filter(clause => clause.original_claim === id && clause.field === field);
      assert.equal(parts.map(part => part.text).join(""), text, "not one source assertion character may disappear");
      assert.ok(parts.every(part => part.reference === original.reference));
    }
  }
  assert.equal(new Set(Object.keys(plan.claims)).size, Object.keys(plan.claims).length);
  assert.equal(JSON.stringify(originals), before, "formatting cannot mutate attested source claims");
  assert.deepEqual(expandPrecheckClauses(structuredClone(originals)), plan);
});

test("predicate conjunctions cannot let a true outcome rescue a false state claim", () => {
  const original = {
    "invariants[0]": {
      rule: "The absence guard is false for an empty cache, so an empty cache reports as expired and returns None from get().",
      why: "The predicate and getter have distinct return values.",
      reference: "cache.py",
    },
  };
  const plan = expandPrecheckClauses(original)!;
  assert.ok(plan);
  const rule = Object.values(plan.claims)
    .filter(clause => clause.original_claim === "invariants[0]" && clause.field === "rule")
    .map(clause => clause.text);
  assert.ok(rule.some(fragment => fragment.includes("reports as expired") && !fragment.includes("returns None")),
    "the state assertion must be independently reviewable from the getter outcome");
  assert.equal(rule.join(""), original["invariants[0]"].rule);
});

test("predicate conjunction support does not broaden lowercase semicolon boundaries", () => {
  const original = {
    "invariants[0]": {
      rule: "Caching disables expiration; cache staleness then requires explicit clearing.",
      why: "The first condition holds. The second condition remains separate.",
      reference: "cache.py",
    },
  };
  const plan = expandPrecheckClauses(original)!;
  assert.ok(plan);
  const rule = Object.values(plan.claims)
    .filter(clause => clause.original_claim === "invariants[0]" && clause.field === "rule")
    .map(clause => clause.text);
  assert.deepEqual(rule, [original["invariants[0]"].rule],
    "lowercase text after a semicolon must retain the prior presentation boundary contract");
});

test("simple assertions and source identifiers retain their original review contract", () => {
  assert.equal(expandPrecheckClauses({
    "pitfalls[0]": { risk: "time.monotonic() controls age.", consequence: "Check cache.is_expired().", reference: "cache.py" },
  }), null);
});

test("unrecognized shapes cannot turn into partial clause coverage", () => {
  for (const input of [
    { concern: "Unbound global scope" },
    { "pitfalls[0]": null },
    { "pitfalls[0]": { risk: "A. B.", reference: 4 } },
    { "pitfalls[0]": { risk: "A. B.", consequence: [], reference: "cache.py" } },
    { "pitfalls[0]": { risk: "A. B.", consequence: " ", reference: "cache.py" } },
  ]) assert.equal(expandPrecheckClauses(input), null);
});

test("an oversized fragment checklist falls back whole, never truncates claims", () => {
  assert.equal(expandPrecheckClauses({
    "invariants[0]": { rule: "A. ".repeat(150), why: "Source remains required.", reference: "cache.py" },
  }), null);
});
