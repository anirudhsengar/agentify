import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

const SCRIPT_ROOTS = [
  "scripts",
  "src/core/scripts",
  "src/core/audit/scripts",
  "src/core/orchestrator/scripts",
] as const;

const SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".py",
  ".sh",
]);

interface RetainedScriptClassification {
  consumers: readonly string[];
  classification: string;
}

const RETAINED_STANDALONE_SCRIPTS: Readonly<Record<string, RetainedScriptClassification>> = {
  "scripts/build.mjs": {
    consumers: ["package.json"],
    classification: "build/package root",
  },
  "src/core/audit/scripts/aggregate-kpis.mjs": {
    consumers: ["tests/scripts/aggregate-kpis.test.mjs"],
    classification: "test-only root",
  },
  "src/core/audit/scripts/inspect-log.mjs": {
    consumers: ["package.json"],
    classification: "maintainer utility root",
  },
  "src/core/scripts/qualify-release-evidence.ts": {
    consumers: ["package.json"],
    classification: "maintainer evidence root",
  },
  "src/core/scripts/score-expert-outcomes.ts": {
    consumers: ["package.json"],
    classification: "maintainer evidence root",
  },
  "src/core/scripts/verify-smoke-evidence.ts": {
    consumers: ["package.json"],
    classification: "maintainer evidence root",
  },
};

const REMOVED_UNREACHABLE_SCRIPTS = [
  "scripts/patch-tools.py",
  "src/core/audit/scripts/compare-runs.mjs",
  "src/core/audit/scripts/coverage-trend.mjs",
  "src/core/orchestrator/scripts/seed-workflows.mjs",
] as const;

function normalizeRepoPath(value: string): string {
  return value.split(path.sep).join("/");
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

function discoverStandaloneScripts(): string[] {
  const scripts: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && SCRIPT_EXTENSIONS.has(path.extname(entry.name))) {
        scripts.push(normalizeRepoPath(path.relative(REPO_ROOT, absolute)));
      }
    }
  };

  for (const root of SCRIPT_ROOTS) {
    const absoluteRoot = path.join(REPO_ROOT, root);
    if (fs.existsSync(absoluteRoot)) visit(absoluteRoot);
  }

  return scripts.sort((left, right) => left.localeCompare(right));
}

test("standalone source and maintenance scripts have explicit retained consumers", () => {
  const expected = Object.keys(RETAINED_STANDALONE_SCRIPTS)
    .sort((left, right) => left.localeCompare(right));

  assert.deepEqual(
    discoverStandaloneScripts(),
    expected,
    "new standalone scripts require a documented reachability classification and retained consumer",
  );

  for (const [script, classification] of Object.entries(RETAINED_STANDALONE_SCRIPTS)) {
    const scriptName = path.basename(script);
    assert.ok(classification.classification.length > 0, `${script} must have a classification`);
    assert.ok(classification.consumers.length > 0, `${script} must name at least one consumer`);

    const hasDirectConsumer = classification.consumers.some((consumer) => {
      const content = read(consumer);
      return content.includes(script) || content.includes(scriptName);
    });

    assert.ok(
      hasDirectConsumer,
      `${script} must be named directly by at least one retained package, workflow, documentation, or test consumer`,
    );
  }
});

test("proven unreachable script deletions remain documented and absent", () => {
  const reachability = read("docs/refactors/runtime-reachability.md");

  for (const removedPath of REMOVED_UNREACHABLE_SCRIPTS) {
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, removedPath)),
      false,
      `${removedPath} was classified as proven unreachable and must not silently return`,
    );
    assert.ok(
      reachability.includes(`\`${removedPath}\``),
      `reachability evidence must document ${removedPath}`,
    );
  }
});
