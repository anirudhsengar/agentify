import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

interface CorpusCase {
  repository: string;
  target_commit: string;
  fixture_kind: "reduced-deterministic" | "captured-policy-and-audit-replay";
  replay_modules: string[];
  audit_events: string[];
  expected_core_ownership: string[];
  expected_rejected_candidates: string[];
  expected_unresolved_obligations: string[];
  expected_readiness: string;
  expected_installation_disposition: string;
  budgets: {
    runtime_ms: number;
    model_calls: number;
    turns: number;
    tokens: number;
    cost_usd: number;
    output_bytes: number;
  };
}

interface CorpusFixture {
  schema_version: "1";
  captured_at: string;
  cases: CorpusCase[];
}

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURE_PATH = path.join(ROOT, "tests/fixtures/stabilization-corpus.json");
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as CorpusFixture;

test("the stabilization corpus is pinned, explicit, and machine-readable", () => {
  assert.equal(FIXTURE.schema_version, "1");
  assert.equal(FIXTURE.cases.length, 9);
  assert.equal(new Set(FIXTURE.cases.map((entry) => entry.repository)).size, 9);
  assert.deepEqual(
    FIXTURE.cases.map((entry) => entry.repository).sort(),
    ["aqa-tests", "axum", "click", "cobra", "commander.js", "gin", "hono", "lobsters", "spring-petclinic"],
  );
  for (const entry of FIXTURE.cases) {
    assert.match(entry.target_commit, /^[0-9a-f]{40}$/);
    assert.ok(entry.replay_modules.length > 0, `${entry.repository}: no replay modules`);
    assert.ok(entry.audit_events.length > 0, `${entry.repository}: no audit events`);
    assert.ok(entry.expected_readiness.length > 0, `${entry.repository}: no readiness outcome`);
    assert.ok(entry.expected_installation_disposition.length > 0, `${entry.repository}: no installation outcome`);
    assert.ok(entry.budgets.runtime_ms > 0, `${entry.repository}: no runtime budget`);
    assert.equal(entry.budgets.model_calls, 0, `${entry.repository}: deterministic replay must make no model calls`);
    assert.equal(entry.budgets.turns, 0);
    assert.equal(entry.budgets.tokens, 0);
    assert.equal(entry.budgets.cost_usd, 0);
  }
});

for (const entry of FIXTURE.cases) {
  test(`${entry.repository}: deterministic historical replay passes within budget`, () => {
    const startedAt = Date.now();
    const command = path.join(ROOT, "node_modules/.bin/tsx");
    const outputLimit = Math.max(entry.budgets.output_bytes, 64 * 1024);
    let outputBytes = 0;
    for (const module of entry.replay_modules) {
      const remainingMs = entry.budgets.runtime_ms - (Date.now() - startedAt);
      assert.ok(remainingMs > 0, `${entry.repository}: runtime budget exceeded`);
      const result = spawnSync(command, [path.join(ROOT, module)], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: remainingMs,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
        },
        maxBuffer: outputLimit,
      });
      assert.equal(result.signal, null, `${entry.repository}: ${module} exceeded its runtime budget`);
      assert.equal(
        result.status,
        0,
        `${entry.repository}: ${module} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      outputBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    }
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs <= entry.budgets.runtime_ms, `${entry.repository}: runtime budget exceeded`);
    assert.ok(outputBytes <= outputLimit, `${entry.repository}: output budget exceeded`);
  });
}
