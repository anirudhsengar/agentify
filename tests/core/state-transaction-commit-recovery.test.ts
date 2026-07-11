import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recoverInterruptedStateTransactions } from "../../src/core/state-transaction.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function testCommittedMigrationRecoveryKeepsDestination(): Promise<void> {
  const cwd = tempDir("agentify-state-committed-recovery-");
  const runId = "committed-migration-crash";
  const transactionDir = path.join(cwd, ".agentify", "state-transactions", runId);
  const destination = path.join(cwd, ".claude", "agentify");
  const legacySource = path.join(cwd, ".pi", "agentify");
  const backup = path.join(transactionDir, "backup");

  try {
    write(path.join(destination, "codebase_map.json"), "committed-map\n");
    write(path.join(backup, "codebase_map.json"), "legacy-map\n");
    write(
      path.join(transactionDir, "journal.json"),
      `${JSON.stringify({
        schema_version: "1",
        run_id: runId,
        source_relative_dir: ".pi/agentify",
        destination_relative_dir: ".claude/agentify",
        had_existing_state: true,
        phase: "committed",
      }, null, 2)}\n`,
    );

    assert.deepEqual(recoverInterruptedStateTransactions(cwd), [runId]);
    assert.equal(
      fs.readFileSync(path.join(destination, "codebase_map.json"), "utf-8"),
      "committed-map\n",
    );
    assert.ok(!fs.existsSync(legacySource), "legacy state must not be restored after commit");
    assert.ok(!fs.existsSync(transactionDir), "committed recovery must finish cleanup");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await testCommittedMigrationRecoveryKeepsDestination();
console.log("state-transaction committed recovery test passed.");
