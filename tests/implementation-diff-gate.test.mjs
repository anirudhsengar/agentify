import assert from "node:assert/strict";
import test from "node:test";
import {
  assessImplementationDiff,
  isTemporaryImplementationArtifact,
  parseNameStatusZ,
} from "../scripts/verify-implementation-diff.mjs";

test("temporary implementation payloads and one-shot workflows are rejected", () => {
  const entries = [
    { status: "A", paths: [".github/implementation/fix.patch.gz.b64.part00"] },
    { status: "A", paths: [".github/workflows/qualify-fix.yml"] },
  ];
  const violations = assessImplementationDiff(entries);
  assert.equal(violations.length, 2);
  assert.match(violations[0], /temporary implementation artifacts/i);
  assert.match(violations[1], /only temporary payload\/workflow artifacts/i);
});

test("production changes may delete stale staging artifacts", () => {
  const entries = [
    { status: "M", paths: ["src/core/audit/specialist-completion.ts"] },
    { status: "A", paths: ["tests/audit/locality-aware-semantic-closure.test.ts"] },
    { status: "D", paths: [".github/implementation/fix.patch.gz.b64.part00"] },
    { status: "D", paths: [".github/workflows/apply-fix.yml"] },
  ];
  assert.deepEqual(assessImplementationDiff(entries), []);
});

test("a temporary workflow remains forbidden even beside production source", () => {
  const violations = assessImplementationDiff([
    { status: "M", paths: ["src/core/runs/repository-audit-run.ts"] },
    { status: "M", paths: [".github/workflows/export-workspace.yaml"] },
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /export-workspace\.yaml/);
});


test("rename and copy entries evaluate only their active destination", () => {
  assert.deepEqual(assessImplementationDiff([
    { status: "R100", paths: [".github/workflows/apply-old.yml", "src/core/replacement.ts"] },
  ]), []);
  const violations = assessImplementationDiff([
    { status: "R100", paths: ["src/core/old.ts", ".github/workflows/materialize-fix.yml"] },
  ]);
  assert.equal(violations.length, 2);
});

test("name-status parsing preserves rename source and destination", () => {
  assert.deepEqual(
    parseNameStatusZ("M\0src/a.ts\0R100\0old.ts\0new.ts\0D\0gone.ts\0"),
    [
      { status: "M", paths: ["src/a.ts"] },
      { status: "R100", paths: ["old.ts", "new.ts"] },
      { status: "D", paths: ["gone.ts"] },
    ],
  );
});

test("artifact classification is narrow and explicit", () => {
  assert.equal(isTemporaryImplementationArtifact(".github/implementation/patch.py"), true);
  assert.equal(isTemporaryImplementationArtifact(".github/workflows/apply-fix.yml"), true);
  assert.equal(isTemporaryImplementationArtifact(".github/workflows/ci.yml"), false);
  assert.equal(isTemporaryImplementationArtifact("src/core/apply-policy.ts"), false);
});
