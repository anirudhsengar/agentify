import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { RepositoryTaskPolicyConfiguration } from "../src/core/installer/contracts.ts";
import { packageRoot } from "../src/core/pi-sdk-runtime.ts";
import { installScaffoldRuntime } from "../src/core/scaffold-installer.ts";
import { AGENTIFY_ANALYSIS_CONTROL_PATHS, AGENTIFY_INSTALLED_CONTROL_PATHS } from "../src/core/artifacts/managed-installation-paths.ts";

function configuration(configured: boolean): RepositoryTaskPolicyConfiguration {
  return {
    format: "agentify_task_policy_configuration",
    schema_version: "2",
    configured,
    repository: null,
    model_network_posture: "denied-by-default",
    dependency_change_policy: "maintainer-approval-required",
    application_merge: "disabled",
    application_deployment: "disabled",
    protected_path_policy_known: configured,
    validation_services_attested: configured,
    validation_execution: {
      mode: "maintainer-approved-unsandboxed",
      child_environment_credentials: "removed",
      repository_mutation: "disposable-checkout",
      network_isolation: "not-provided",
      os_sandbox: "not-provided",
    },
    validation_approval: null,
    policy: configured ? ({} as never) : null,
    instructions: configured ? "ready" : "blocked",
  };
}

test("managed instructions reflect disabled issue execution and recover when policy becomes ready", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-readiness-docs-"));
  try {
    installScaffoldRuntime({
      cwd,
      packageRoot: packageRoot(),
      taskPolicyConfiguration: configuration(false),
    });

    const agentsPath = path.join(cwd, "AGENTS.md");
    const setupPath = path.join(cwd, "SETUP.md");
    const blockedAgents = fs.readFileSync(agentsPath, "utf8");
    const blockedSetup = fs.readFileSync(setupPath, "utf8");
    assert.match(blockedAgents, /analysis-ready/);
    assert.match(blockedAgents, /read-only analysis/);
    assert.doesNotMatch(blockedSetup, /^## Queue work$/m);
    assert.match(blockedSetup, /learning are disabled/);
    assert.doesNotMatch(blockedSetup, /gh secret set|## Credentials/);
    for (const relative of AGENTIFY_INSTALLED_CONTROL_PATHS) {
      assert.equal(fs.existsSync(path.join(cwd, relative)), AGENTIFY_ANALYSIS_CONTROL_PATHS.has(relative));
    }

    installScaffoldRuntime({
      cwd,
      packageRoot: packageRoot(),
      taskPolicyConfiguration: configuration(true),
    });
    const readyAgents = fs.readFileSync(agentsPath, "utf8");
    const readySetup = fs.readFileSync(setupPath, "utf8");
    assert.match(readyAgents, /Use GitHub issues with the `agentify:queue` label/);
    assert.match(readySetup, /^## Queue work$/m);
    assert.doesNotMatch(readySetup, /^## Issue execution disabled$/m);
    for (const relative of AGENTIFY_INSTALLED_CONTROL_PATHS) assert.ok(fs.existsSync(path.join(cwd, relative)));
    installScaffoldRuntime({ cwd, packageRoot: packageRoot(), taskPolicyConfiguration: configuration(false) });
    for (const relative of AGENTIFY_INSTALLED_CONTROL_PATHS) {
      assert.equal(fs.existsSync(path.join(cwd, relative)), AGENTIFY_ANALYSIS_CONTROL_PATHS.has(relative));
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("disabled installation never removes an unrecognized or symlinked execution path", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-disable-ownership-"));
  try {
    const runtime = path.join(cwd, ".github/agentify/task-runtime.mjs");
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    fs.writeFileSync(runtime, "// user-owned runtime\n");
    const install = () => installScaffoldRuntime({ cwd, packageRoot: packageRoot(), taskPolicyConfiguration: configuration(false) });
    assert.throws(install, /user-owned path/);
    assert.equal(fs.readFileSync(runtime, "utf8"), "// user-owned runtime\n");
    if (process.platform !== "win32") {
      const target = path.join(cwd, "retained.mjs");
      fs.writeFileSync(target, "// agentify:managed\n// must not remove\n");
      fs.unlinkSync(runtime);
      fs.symlinkSync(target, runtime);
      assert.throws(install, /symlink/);
      assert.ok(fs.lstatSync(runtime).isSymbolicLink());
      assert.equal(fs.readFileSync(target, "utf8"), "// agentify:managed\n// must not remove\n");
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
