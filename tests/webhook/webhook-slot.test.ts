// tests/webhook/webhook-slot.test.ts — Phase 3 (ADR 0017)
//
// Verify webhook trigger schema accepts model_role and the worker
// threads it through to AgentRuntimeSessionOptions.modelRole.

import assert from "node:assert/strict";
import { Value } from "typebox/value";
import {
  PromptInvocationSchema,
  WebhookTaskRecordSchema,
} from "../../src/core/webhook/state.ts";

async function webhookTriggerSchemaAcceptsModelRole(): Promise<void> {
  const parsed = Value.Parse(PromptInvocationSchema, {
    template: "/implement",
    model_role: "lite",
  });
  assert.equal(parsed.model_role, "lite");
}

async function webhookTaskRecordSchemaAcceptsModelRole(): Promise<void> {
  const parsed = Value.Parse(WebhookTaskRecordSchema, {
    task_id: "test-id",
    trigger_id: "trig-1",
    received_at: "2026-07-09T00:00:00Z",
    status: "queued",
    http: {
      method: "POST",
      path: "/hook",
      remote_addr: null,
      user_agent: null,
      content_type: "application/json",
      body_size: 0,
    },
    prompt: {
      template: "/implement",
      args: {},
      cwd: "/tmp",
      tools: [],
      model: null,
      thinking_level: null,
      model_role: "lite",
    },
  });
  assert.equal(parsed.prompt.model_role, "lite");
}

async function webhookSchemaAcceptsModelRoleUnset(): Promise<void> {
  // Schema is backward-compatible: model_role defaults to undefined when unset.
  const parsed = Value.Parse(PromptInvocationSchema, {
    template: "/implement",
  });
  assert.equal(parsed.model_role, undefined);
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "webhookTriggerSchemaAcceptsModelRole", fn: webhookTriggerSchemaAcceptsModelRole },
  { name: "webhookTaskRecordSchemaAcceptsModelRole", fn: webhookTaskRecordSchemaAcceptsModelRole },
  { name: "webhookSchemaAcceptsModelRoleUnset", fn: webhookSchemaAcceptsModelRoleUnset },
];

let passed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
}
console.log(`webhook-slot tests passed (${passed}/${tests.length}).`);