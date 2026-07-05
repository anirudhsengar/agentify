// tests/orchestrator/workflow-registry.test.ts — workflow discovery tiers.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverWorkflows,
  WorkflowRegistry,
} from "../../src/core/orchestrator/workflow-registry.ts";
import type { WorkflowSpec } from "../../src/core/orchestrator/workflow-spec.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeWorkflow(dir: string, spec: WorkflowSpec): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${spec.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(spec, null, 2), { mode: 0o600 });
  return filePath;
}

function spec(name: string, description: string): WorkflowSpec {
  return {
    name,
    description,
    steps: [
      {
        id: "one",
        handler: "subagent",
        user_prompt: "do one thing",
      },
    ],
  };
}

async function testPackagedWorkflowsLoad(): Promise<void> {
  const cwd = tempDir("agentify-wf-cwd-");
  const configDir = tempDir("agentify-wf-cfg-");
  try {
    const registry = WorkflowRegistry.fromCwd(cwd, configDir);
    assert.ok(registry.packagedWorkflowsDir?.endsWith(path.join("src", "core", "orchestrator", "workflows")));
    assert.ok(registry.has("scout_then_build"));
    assert.ok(registry.list().length >= 5);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testProjectOverridesUser(): Promise<void> {
  const cwd = tempDir("agentify-wf-cwd-");
  const configDir = tempDir("agentify-wf-cfg-");
  try {
    const userDir = path.join(configDir, "workflows");
    const projectDir = path.join(cwd, ".pi", "workflows");
    writeWorkflow(userDir, spec("custom_flow", "user version"));
    writeWorkflow(projectDir, spec("custom_flow", "project version"));

    const result = discoverWorkflows(cwd, configDir);
    const found = result.workflows.find((workflow) => workflow.name === "custom_flow");
    assert.ok(found);
    assert.equal(found?.description, "project version");
    assert.equal(result.sources["custom_flow"]?.source, "project");
    assert.equal(result.projectWorkflowsDir, projectDir);
    assert.equal(result.userWorkflowsDir, userDir);
    assert.ok(result.errors.some((msg) => msg.includes("duplicate workflow name 'custom_flow'")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

await testPackagedWorkflowsLoad();
await testProjectOverridesUser();

console.log("workflow-registry tests passed.");
