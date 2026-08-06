import assert from "node:assert/strict";
import test from "node:test";
import {
  combineQualificationReceipts,
  validateQualificationReceipt,
} from "./qualification-receipts.mjs";

function receipt(script, checks = [`${script.replace(/\.mjs$/u, "")}.executed`]) {
  return { schema_version: "1", script, status: "passed", checks };
}

test("qualification receipts preserve only validated execution claims", () => {
  assert.deepEqual(
    combineQualificationReceipts([
      receipt("installed-a.mjs"),
      receipt("installed-b.mjs"),
    ], ["installed-a.mjs", "installed-b.mjs"]),
    [
      receipt("installed-a.mjs"),
      receipt("installed-b.mjs"),
    ],
  );
});

test("an injected smoke failure makes qualification evidence fail", () => {
  assert.throws(() => validateQualificationReceipt({
    ...receipt("installed-a.mjs"),
    status: "failed",
  }, "installed-a.mjs"), /did not report a passing execution/);
});

test("missing, duplicated, or ceremonial claims are rejected", () => {
  assert.throws(
    () => combineQualificationReceipts([receipt("installed-a.mjs")], ["installed-a.mjs", "installed-b.mjs"]),
    /count does not match/,
  );
  assert.throws(
    () => combineQualificationReceipts([
      receipt("installed-a.mjs", ["shared.executed"]),
      receipt("installed-b.mjs", ["shared.executed"]),
    ], ["installed-a.mjs", "installed-b.mjs"]),
    /globally unique/,
  );
  assert.throws(
    () => validateQualificationReceipt(receipt("installed-a.mjs", ["all.failure.scenarios.passed"]), "installed-b.mjs"),
    /belongs to/,
  );
});
