import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentifyLog } from "../../src/core/audit/log.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testStreamingUpdatesAreNotPersisted(): Promise<void> {
  const configDir = tempDir("agentify-log-");
  try {
    const log = new AgentifyLog({ cwd: configDir, configDir });
    log.sessionEvent({
      pi_event_type: "message_update",
      event: { type: "message_update", repeated_payload: "x".repeat(100_000) },
    });
    log.sessionEvent({
      pi_event_type: "tool_execution_start",
      event: { type: "tool_execution_start", toolName: "write_map" },
    });
    const logPath = log.logPath;
    await log.close();

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      event: string;
      payload: string;
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.event, "agentify.session_event");
    assert.match(lines[0]?.payload ?? "", /tool_execution_start/);
    assert.doesNotMatch(lines[0]?.payload ?? "", /repeated_payload/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

await testStreamingUpdatesAreNotPersisted();
console.log("audit log tests passed (1/1).");
