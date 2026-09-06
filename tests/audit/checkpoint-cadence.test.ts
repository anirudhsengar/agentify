import assert from "node:assert/strict";
import test from "node:test";
import { AuditCheckpointCadence } from "../../src/core/audit/checkpoint-cadence.ts";

const inspect = (toolName = "read") => ({ type: "tool_execution_end", toolName, isError: false });
const checkpoint = () => ({ type: "tool_execution_end", toolName: "write_map_delta", isError: false,
  result: { details: { path: ".agentify/runtime/audit/codebase_map.json" } } });

test("four completed inspections schedule a checkpoint, then a validated write starts the next interval", () => {
  const cadence = new AuditCheckpointCadence();
  for (const tool of ["read", "grep", "find"]) {
    cadence.observe(inspect(tool));
    assert.equal(cadence.due, false);
  }
  cadence.observe(inspect("ls"));
  assert.equal(cadence.due, true);
  cadence.observe(checkpoint());
  assert.equal(cadence.due, false);
  for (let index = 0; index < 4; index += 1) cadence.observe(inspect());
  assert.equal(cadence.due, true, "checkpointing must recur after the first successful map write");
});

test("failed, proposed and incomplete writes cannot release the checkpoint requirement", () => {
  const cadence = new AuditCheckpointCadence();
  for (let index = 0; index < 4; index += 1) cadence.observe(inspect());
  for (const event of [
    { ...checkpoint(), type: "tool_execution_start" },
    { ...checkpoint(), isError: true },
    { ...checkpoint(), result: { isError: true, details: { path: "map.json" } } },
    { ...checkpoint(), result: { content: [{ type: "text", text: "saved" }] } },
    { ...checkpoint(), result: { details: { path: "" } } },
    { type: "message_end", message: { content: "coverage complete" } },
    inspect("spawn_explorer"),
  ]) {
    cadence.observe(event);
    assert.equal(cadence.due, true);
  }
});

test("failed reads and model prose do not count as observed evidence", () => {
  const cadence = new AuditCheckpointCadence();
  for (let index = 0; index < 20; index += 1) {
    cadence.observe({ ...inspect(), isError: true });
    cadence.observe({ ...inspect(), type: "tool_execution_start" });
    cadence.observe({ type: "message_end", message: { role: "assistant" } });
  }
  assert.equal(cadence.due, false);
});

test("the captured long read-only tail requests checkpoints instead of silently accumulating history", () => {
  const cadence = new AuditCheckpointCadence();
  cadence.observe(checkpoint());
  for (let index = 0; index < 83; index += 1) {
    cadence.observe(inspect());
    assert.equal(cadence.due, index >= 3);
  }
  cadence.observe({ ...checkpoint(), toolName: "write_map" });
  assert.equal(cadence.due, false);
});
