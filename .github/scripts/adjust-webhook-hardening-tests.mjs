import * as fs from "node:fs";

const file = "tests/webhook/server.test.ts";
const source = fs.readFileSync(file, "utf-8");
const before = `    const body = JSON.parse(res.body);
    assert.match(body.reason, /missing/);`;
const after = `    const body = JSON.parse(res.body);
    assert.equal(body.error, "unauthorized");
    assert.ok(!("reason" in body));`;
if (!source.includes(before)) {
  throw new Error("unsigned webhook assertion marker not found");
}
fs.writeFileSync(file, source.replace(before, after));
console.log("webhook server assertions migrated");
