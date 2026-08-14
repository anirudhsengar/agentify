import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

function files(root: string): string[] {
  const absolute = path.join(REPO_ROOT, root);
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) result.push(path.relative(REPO_ROOT, child).split(path.sep).join("/"));
    }
  };
  visit(absolute);
  return result.sort();
}

test("task lifecycle remains internal while the build emits the installed runtime", () => {
  const packageJson = JSON.parse(read("package.json")) as { exports?: Record<string, string>; files?: string[]; scripts?: Record<string, string> };
  assert.deepEqual(packageJson.exports, { "./package.json": "./package.json" });
  assert.ok(!(packageJson.files ?? []).includes("src"));
  assert.match(packageJson.scripts?.["test:lifecycle"] ?? "", /task-lifecycle/);
  assert.match(packageJson.scripts?.["test:package"] ?? "", /exact-artifact-qualification\.mjs/);
  assert.match(read("tests/package/exact-artifact-qualification.mjs"), /installed-task-lifecycle-smoke\.mjs/);

  const build = read("scripts/build.mjs");
  assert.match(build, /source:\s*path\.join\(repoRoot, "src", "core", "task-lifecycle", "cli\.ts"\)/);
  assert.match(build, /outfile:\s*path\.join\(distDir, "task-runtime\.mjs"\)/);
});

test("task lifecycle owns the writable application runtime without duplicating learning schemas", () => {
  const schema = read("src/core/task-lifecycle/schema.ts");
  assert.match(schema, /AcceptedTaskEvidenceSchema.*\.\.\/learning\/schema\.ts/s);
  assert.doesNotMatch(schema, /export const AcceptedTaskEvidenceSchema/);
  for (const file of files("src/core/learning")) {
    assert.doesNotMatch(read(file), /task-lifecycle/,
      `${file} must not import the application task lifecycle`);
  }
});

test("generated workflow is trusted-default-branch, issue-only, serialized, and draft-only", () => {
  const workflow = read("scaffold/.github/workflows/agentify-issue.yml");
  const controller = read("scaffold/.github/scripts/run-task-lifecycle.mjs");
  const publisher = read("scaffold/.github/scripts/publish-task-draft.mjs");
  assert.match(workflow, /issues:\s*\n\s*types: \[labeled\]/);
  assert.match(workflow, /issue_comment:\s*\n\s*types: \[created\]/);
  assert.doesNotMatch(workflow, /pull_request_target|pull_request:/);
  assert.match(workflow, /github\.event\.repository\.default_branch/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm install --global npm@11\.19\.0 --ignore-scripts --no-audit --no-fund/);
  assert.match(workflow, /hashFiles\('package-lock\.json', 'npm-shrinkwrap\.json'\)/);
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(workflow, /github\.event\.sender\.type == 'User'/);
  assert.match(workflow, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.match(workflow, /AGENTIFY_PR_TOKEN:\s*\$\{\{ secrets\.AGENT_PAT \}\}/);
  assert.match(workflow, /agentify-issue-\$\{\{ github\.repository_id \}\}-\$\{\{ github\.event\.issue\.number \}\}/);
  assert.match(publisher, /"pr", "create"/);
  assert.match(publisher, /"--draft"/);
  const combined = `${workflow}\n${controller}\n${publisher}`;
  assert.match(publisher, /--find-copies-harder/);
  assert.doesNotMatch(combined, /\bgh\s+pr\s+merge\b|enablePullRequestAutoMerge|--auto(?:-merge)?\b|\/deployments\b|git\s+push[^\n]*--force/);
  assert.match(controller, /\.\.\.this\.policy\.protected_paths/);
  assert.doesNotMatch(controller, /policyConfig\.protected_paths/);
});

test("post-merge workflow finalizes trusted task state and hands evidence to credential-free learning", () => {
  const workflow = read("scaffold/.github/workflows/agentify-learn.yml");
  const controller = read("scaffold/.github/scripts/complete-accepted-task-merge.mjs");
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /complete-accepted-task-merge\.mjs/);
  assert.match(workflow, /--task-evidence/);
  assert.match(controller, /validate-accepted-evidence/);
  assert.match(controller, /expected_current_state: "draft-pr-open"/);
  assert.match(controller, /transition_to: "completed"/);
  assert.match(controller, /state\.draft_pr\.head_commit !== headCommit/);
  const processStep = workflow.slice(workflow.indexOf("- name: Process accepted merge"), workflow.indexOf("- name: Reconcile missed accepted commits"));
  assert.doesNotMatch(processStep, /GH_TOKEN|GITHUB_TOKEN|secrets\./);
});

test("model runtimes have no GitHub credential path", () => {
  const modelRuntime = read("src/core/task-lifecycle/model-runtime.ts");
  const controller = read("scaffold/.github/scripts/run-task-lifecycle.mjs");
  const validation = read("src/core/task-lifecycle/validation-runner.ts");
  assert.match(controller, /key === "GITHUB_TOKEN"/);
  assert.match(controller, /key === "GH_TOKEN"/);
  assert.match(controller, /key === "AGENT_PAT"/);
  assert.match(controller, /trustedPublicationEnvironment/);
  assert.match(controller, /process\.env\.AGENTIFY_PR_TOKEN/);
  assert.doesNotMatch(modelRuntime, /github_write:\s*true|GITHUB_TOKEN|GH_TOKEN|AGENT_PAT/);
  assert.match(validation, /SECRET_ENVIRONMENT/);
  assert.match(validation, /DENIED_EXECUTABLES/);
  assert.match(modelRuntime, /findings are advisory evidence/);
  assert.doesNotMatch(controller, /specialist-blocked|consultation\.unresolved_questions/);
});

test("task execution uses a stable facade over downward-only focused modules", () => {
  const facade = read("src/core/task-lifecycle/execution.ts");
  const modules = files("src/core/task-lifecycle/execution");
  assert.ok(modules.length >= 5, "execution responsibilities should remain separated");
  assert.doesNotMatch(facade, /\bfunction\b|\bclass\b/, "the stable facade must not regain implementation logic");
  assert.ok(facade.split(/\r?\n/).filter(Boolean).every((line) => line.startsWith("export ")));
  for (const file of modules) {
    assert.doesNotMatch(read(file), /from ["']\.\.\/execution\.ts["']/,
      `${file} must not import upward through the execution facade`);
  }
});

test("installed readiness consumes installer-attested policy and service facts", () => {
  const controller = read("scaffold/.github/scripts/run-task-lifecycle.mjs");
  const taskPolicy = read("src/core/installer/task-policy.ts");
  const runtime = read("src/core/task-lifecycle/cli.ts");
  assert.match(controller, /protected_path_policy_known: this\.policyConfig\.protected_path_policy_known === true/);
  assert.match(controller, /validation_services_attested: this\.policyConfig\.validation_services_attested === true/);
  assert.match(controller, /validation_policy_current: validationApprovalCurrent\(this\.root, this\.policyConfig\)/);
  assert.match(controller, /validation_consent_required/);
  assert.match(controller, /validation_policy_stale/);
  assert.match(controller, /decision: readiness/);
  assert.doesNotMatch(controller, /readiness: readinessInput/);
  assert.match(controller, /for \(const intermediate of result\.intermediate_states \?\? \[\]\)/);
  assert.match(controller, /publication:\$\{this\.validation\.final_commit\}:\$\{this\.runId\}/);
  assert.match(taskPolicy, /protected_path_policy_known: policy\.protected_paths\.length > 0/);
  assert.match(taskPolicy, /validation_services_attested: true/);
  assert.match(taskPolicy, /schema_version: "2"/);
  assert.match(runtime, /case "render-state"/);
  assert.match(read("src/core/task-lifecycle/planning.ts"), /AUDIT_STATE_RELATIVE_DIR/);
  assert.match(read("src/core/audit/paths.ts"), /\.agentify\/runtime\/audit/);
});

test("fresh scaffold installation uses an exact focused allowlist", () => {
  const installer = read("src/core/scaffold-installer.ts");
  const managedPaths = read("src/core/artifacts/managed-installation-paths.ts");
  assert.match(installer, /AGENTIFY_INSTALLED_CONTROL_PATHS/);
  for (const unrelated of [
    "agent-command.yml", "agent-implement.yml", "agent-implement-pr.yml",
    "agent-review.yml", "agent-update-branch.yml",
  ]) {
    assert.doesNotMatch(managedPaths, new RegExp(unrelated.replace(".", "\\.")));
  }
  assert.match(installer, /dist", "task-runtime\.mjs"/);
  assert.match(installer, /\.github", "agentify", "task-runtime\.mjs"/);
});
