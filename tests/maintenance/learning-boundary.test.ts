import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

function walk(relativeRoot: string): string[] {
  const output: string[] = [];
  const visit = (relativeDirectory: string): void => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile()) output.push(relativePath);
    }
  };
  visit(relativeRoot);
  return output.sort((left, right) => left.localeCompare(right));
}

test("learning remains internal and dependency direction stays downward", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    exports?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.exports, { "./package.json": "./package.json" });
  assert.ok(!(packageJson.files ?? []).includes("src"));
  assert.match(packageJson.scripts?.["test:learning"] ?? "", /tests\/learning/);
  assert.match(packageJson.scripts?.["test:package"] ?? "", /exact-artifact-qualification\.mjs/);
  assert.match(read("tests/package/exact-artifact-qualification.mjs"), /installed-learning-smoke\.mjs/);

  for (const sourcePath of [
    ...walk("src/core/memory"),
    ...walk("src/core/specialists"),
  ].filter((entry) => entry.endsWith(".ts"))) {
    assert.doesNotMatch(
      read(sourcePath),
      /from ["'][^"']*\/learning(?:\/|["'])/,
      `${sourcePath} must not import the higher-level learning runtime`,
    );
  }

  const cliParser = read("src/core/cli-parser.ts");
  const publicContract = read("src/core/public-cli-contract.ts");
  assert.doesNotMatch(cliParser, /\blearning\b|\blearn\b/);
  assert.doesNotMatch(publicContract, /\blearning\b|\blearn\b/);
});

test("trusted workflow publishes only an unmerged knowledge-maintenance PR", () => {
  const workflow = read("scaffold/.github/workflows/agentify-learn.yml");
  const architecture = read("docs/architecture/continuous-learning.md");

  assert.match(workflow, /pull_request_target:\s*\n\s*types: \[closed\]/);
  assert.match(workflow, /schedule:\s*\n\s*- cron:/);
  assert.match(workflow, /github\.event\.pull_request\.merged == true/);
  assert.match(workflow, /verify-diff/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, /node-version: "22\.19\.0"/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /agentify\/knowledge-maintenance/);
  assert.match(workflow, /force-with-lease/);
  assert.match(workflow, /adopt-proposal/);
  assert.match(workflow, /Agentify-Proposal-Version: 1/);
  assert.match(workflow, /EXPECTED_REMOTE_SHA/);
  assert.match(workflow, /PROPOSAL_PR_NUMBER/);
  assert.match(workflow, /closed_unmerged/);
  assert.match(workflow, /metrics\.patch_bytes/);
  assert.ok(
    workflow.indexOf("adopt-proposal") < workflow.indexOf("learning-runtime.mjs reconcile"),
    "pending knowledge must be resumed before reconciliation",
  );
  assert.ok(
    workflow.indexOf("gh auth setup-git") < workflow.indexOf("git ls-remote"),
    "private-repository Git access must be authenticated before proposal discovery",
  );
  assert.doesNotMatch(workflow, /outputs\.current|current=true|current=false/);
  assert.match(workflow, /git write-tree/);
  const publishStep = workflow.slice(
    workflow.indexOf("- name: Publish a dedicated knowledge-maintenance pull request"),
  );
  assert.doesNotMatch(publishStep, /git ls-remote/);
  assert.doesNotMatch(publishStep, /gh pr list/);
  assert.match(workflow, /steps\.commit\.outputs\.created == 'true'/);
  assert.doesNotMatch(workflow, /gh pr merge|--auto|auto-merge|push --force(?:\s|$)/);
  assert.doesNotMatch(workflow, /PI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|MINIMAX_API_KEY/);
  assert.doesNotMatch(workflow, /run-pi|setup-pi|model:/);

  assert.match(architecture, /accepted diff/i);
  assert.match(architecture, /self-update allowlist/i);
  assert.match(architecture, /application source/i);
  assert.match(architecture, /Knowledge-only changes/i);
  assert.match(architecture, /cannot expand.*permissions/is);
});

test("package carries the trusted learning runtime while installation stays compact and pinned", () => {
  const build = read("scripts/build.mjs");
  const installer = read("src/core/scaffold-installer.ts");
  const launcher = read("scaffold/.github/agentify/learning-runtime.mjs");
  const loader = read("scaffold/.github/agentify/runtime-loader.mjs");
  const packageSmoke = read("tests/package/installed-learning-smoke.mjs");

  assert.match(build, /src["'], "core", "learning", "cli\.ts/);
  assert.match(build, /distDir, "learning-runtime\.mjs"/);
  assert.doesNotMatch(installer, /dist["'], "learning-runtime\.mjs/);
  assert.match(installer, /RUNTIME_VERSION_PLACEHOLDER/);
  assert.match(launcher, /runAgentifyRuntime\("learning-runtime\.mjs"/);
  assert.match(loader, /PACKAGE_NAME = "@anirudhsengar\/agentify"/);
  assert.match(loader, /PACKAGE_VERSION = "__AGENTIFY_RUNTIME_VERSION__"/);
  assert.match(loader, /\$\{PACKAGE_NAME\}@\$\{PACKAGE_VERSION\}/);
  assert.match(packageSmoke, /dist["'], "learning-runtime\.mjs/);
});
