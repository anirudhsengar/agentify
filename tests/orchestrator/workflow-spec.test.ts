// tests/orchestrator/workflow-spec.test.ts — schema + structural checks.

import assert from "node:assert/strict";
import {
  validateWorkflowSpec,
  validateInputs,
  defaultSmokeSpec,
  checkWorkflowStructural,
} from "../../src/core/orchestrator/workflow-spec.ts";

async function testSmokeSpecValidates(): Promise<void> {
  const result = validateWorkflowSpec(defaultSmokeSpec());
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
}

async function testRejectsMissingName(): Promise<void> {
  const raw = {
    description: "no name",
    steps: [{ id: "x", handler: "subagent", user_prompt: "x" }],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
}

async function testRejectsUnknownHandler(): Promise<void> {
  const raw = {
    name: "bad",
    description: "x",
    steps: [{ id: "x", handler: "BAD" }],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
}

async function testRejectsCycle(): Promise<void> {
  const raw = {
    name: "cycle",
    description: "x",
    steps: [
      { id: "a", handler: "subagent", user_prompt: "a", depends_on: ["b"] },
      { id: "b", handler: "subagent", user_prompt: "b", depends_on: ["a"] },
    ],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("cycle")));
}

async function testRejectsDuplicateIds(): Promise<void> {
  const raw = {
    name: "dup",
    description: "x",
    steps: [
      { id: "x", handler: "subagent", user_prompt: "x" },
      { id: "x", handler: "subagent", user_prompt: "y" },
    ],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("duplicate")));
}

async function testRejectsUnknownDep(): Promise<void> {
  const raw = {
    name: "missing-dep",
    description: "x",
    steps: [
      { id: "a", handler: "subagent", user_prompt: "x", depends_on: ["ghost"] },
    ],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /ghost/.test(e)));
}

async function testSubagentRequiresPromptOrTemplate(): Promise<void> {
  const raw = {
    name: "subagent-empty",
    description: "x",
    steps: [{ id: "x", handler: "subagent" }],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
}

async function testAiwRequiresWorkflowTypeAndPrompt(): Promise<void> {
  const raw = {
    name: "aiw-empty",
    description: "x",
    steps: [{ id: "x", handler: "aiw" }],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
}

async function testComposeRequiresSteps(): Promise<void> {
  const raw = {
    name: "compose-empty",
    description: "x",
    steps: [{ id: "x", handler: "compose" }],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
}

async function testBranchRequiresSteps(): Promise<void> {
  const raw = {
    name: "branch-empty",
    description: "x",
    steps: [{ id: "x", handler: "branch" }],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
}

async function testNestedValidation(): Promise<void> {
  // Outer level passes; inner compose step fails.
  const raw = {
    name: "outer",
    description: "x",
    steps: [
      {
        id: "outer1",
        handler: "compose",
        steps: [
          { id: "inner_dup", handler: "subagent", user_prompt: "a" },
          { id: "inner_dup", handler: "subagent", user_prompt: "b" },
        ],
      },
    ],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /duplicate/.test(e)));
}

async function testParallelGroupRaceDetected(): Promise<void> {
  const raw = {
    name: "race",
    description: "x",
    steps: [
      {
        id: "a",
        handler: "subagent",
        user_prompt: "a",
        parallel_group: "g1",
        depends_on: ["b"],
      },
      {
        id: "b",
        handler: "subagent",
        user_prompt: "b",
        parallel_group: "g1",
      },
    ],
  };
  const result = validateWorkflowSpec(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /parallel_group|race/.test(e)));
}

async function testInputsCoercionAndDefaults(): Promise<void> {
  const spec = validateWorkflowSpec({
    name: "with-inputs",
    description: "x",
    inputs: {
      prompt: { type: "string" },
      n: { type: "number", default: 3, min: 1, max: 5 },
      enabled: { type: "boolean", default: true },
    },
    steps: [{ id: "x", handler: "subagent", user_prompt: "${inputs.prompt}" }],
  });
  assert.equal(spec.ok, true);
  const r = validateInputs(spec.value!, { prompt: "hi" });
  assert.equal(r.ok, true);
  assert.equal(r.coerced["prompt"], "hi");
  assert.equal(r.coerced["n"], 3);
  assert.equal(r.coerced["enabled"], true);
}

async function testInputsRejectsOutOfRange(): Promise<void> {
  const spec = validateWorkflowSpec({
    name: "with-inputs",
    description: "x",
    inputs: { n: { type: "number", min: 1, max: 5 } },
    steps: [{ id: "x", handler: "subagent", user_prompt: "x" }],
  });
  assert.equal(spec.ok, true);
  const r = validateInputs(spec.value!, { n: 100 });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0]?.includes(">= 5") || r.errors[0]?.includes("<= 5"));
}

async function testStructuralOk(): Promise<void> {
  const raw = defaultSmokeSpec();
  const result = checkWorkflowStructural(raw);
  assert.deepEqual(result.errors, []);
}

async function testMain(): Promise<void> {
  await testSmokeSpecValidates();
  await testRejectsMissingName();
  await testRejectsUnknownHandler();
  await testRejectsCycle();
  await testRejectsDuplicateIds();
  await testRejectsUnknownDep();
  await testSubagentRequiresPromptOrTemplate();
  await testAiwRequiresWorkflowTypeAndPrompt();
  await testComposeRequiresSteps();
  await testBranchRequiresSteps();
  await testNestedValidation();
  testParallelGroupRaceDetected();
  await testInputsCoercionAndDefaults();
  testInputsRejectsOutOfRange();
  testStructuralOk();
  console.log("workflow-spec tests passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testMain().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
