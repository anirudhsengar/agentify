import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

export const QUALIFICATION_RECEIPT_ENV = "AGENTIFY_QUALIFICATION_RECEIPT_DIR";

const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

function validateChecks(checks) {
  assert.ok(Array.isArray(checks) && checks.length > 0, "qualification receipt requires executed checks");
  assert.equal(new Set(checks).size, checks.length, "qualification receipt checks must be unique");
  for (const check of checks) {
    assert.equal(typeof check, "string", "qualification receipt check must be a string");
    assert.match(check, IDENTIFIER, `invalid qualification check identifier '${check}'`);
  }
  return [...checks].sort();
}

export function validateQualificationReceipt(value, expectedScript) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "qualification receipt must be an object");
  assert.equal(value.schema_version, "1", "qualification receipt schema is unsupported");
  assert.equal(value.script, expectedScript, `qualification receipt belongs to ${value.script ?? "an unknown script"}`);
  assert.equal(value.status, "passed", `${expectedScript} did not report a passing execution`);
  return {
    schema_version: "1",
    script: expectedScript,
    status: "passed",
    checks: validateChecks(value.checks),
  };
}

export function qualificationReceiptPath(directory, script) {
  assert.match(script, /^[a-z0-9-]+\.mjs$/u, "unsafe qualification script name");
  return path.join(directory, `${script}.json`);
}

export function writeQualificationReceipt(script, checks) {
  const directory = process.env[QUALIFICATION_RECEIPT_ENV]?.trim();
  if (!directory) return;
  const receipt = validateQualificationReceipt({
    schema_version: "1",
    script,
    status: "passed",
    checks,
  }, script);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    qualificationReceiptPath(directory, script),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

export function readQualificationReceipt(directory, script) {
  const filePath = qualificationReceiptPath(directory, script);
  assert.ok(fs.existsSync(filePath), `${script} completed without a qualification receipt`);
  return validateQualificationReceipt(JSON.parse(fs.readFileSync(filePath, "utf8")), script);
}

export function combineQualificationReceipts(receipts, expectedScripts) {
  assert.equal(receipts.length, expectedScripts.length, "qualification receipt count does not match executed scripts");
  const byScript = new Map(receipts.map((receipt) => [receipt.script, receipt]));
  assert.equal(byScript.size, receipts.length, "qualification receipts contain duplicate scripts");
  const combined = expectedScripts.map((script) => {
    const receipt = byScript.get(script);
    assert.ok(receipt, `qualification receipt is missing for ${script}`);
    return validateQualificationReceipt(receipt, script);
  });
  const checks = combined.flatMap((receipt) => receipt.checks);
  assert.equal(new Set(checks).size, checks.length, "qualification check identifiers must be globally unique");
  return combined;
}
