import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const workflowsRoot = path.join(REPO_ROOT, ".github", "workflows");
const ci = fs.readFileSync(path.join(workflowsRoot, "ci.yml"), "utf8");

test("the primary Node matrix owns full-suite diagnostics", () => {
  assert.equal((ci.match(/npm run test:all/g) ?? []).length, 1);
  assert.match(ci, /node: \["22\.19\.0", "24"\]/);
  assert.match(ci, /id: test_all/);
  assert.match(ci, /npm run test:all > test-all\.log 2>&1/);
  assert.match(ci, /tail -n 240 test-all\.log/);
  assert.match(ci, /if: failure\(\) && steps\.test_all\.outcome == 'failure'/);
  assert.match(ci, /uses: actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(ci, /name: test-all-failure-node-\$\{\{ matrix\.node \}\}/);
  assert.match(ci, /retention-days: 7/);
  assert.doesNotMatch(ci, /continue-on-error: true/);
});

test("no second pull-request workflow reruns the complete suite for diagnostics", () => {
  assert.equal(fs.existsSync(path.join(workflowsRoot, "phase-a-debug.yml")), false);
  const workflowFiles = fs.readdirSync(workflowsRoot)
    .filter((name) => name.endsWith(".yml"))
    .sort();
  const duplicateDiagnostics = workflowFiles.filter((name) => {
    const content = fs.readFileSync(path.join(workflowsRoot, name), "utf8");
    return /phase-a-failure-diagnostics|test-diagnostics/.test(content);
  });
  assert.deepEqual(duplicateDiagnostics, []);
});
