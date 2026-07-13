import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  StateMigrationInterruptedError,
  migrateRetainedState,
  recoverInterruptedStateTransactions,
} from "../../src/core/state-transaction.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testCommittedMigrationRecoveryKeepsBothTrees(): Promise<void> {
  const cwd = tempDir("agentify-state-committed-recovery-");
  const runId = "committed-migration-crash";
  const sourceFile = path.join(cwd, ".pi/agentify/codebase_map.json");
  const destinationFile = path.join(cwd, ".claude/agentify/codebase_map.json");
  try {
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, '{"marker":"legacy"}\n');
    assert.throws(() => migrateRetainedState({
      cwd,
      sourceRelativeDir: ".pi/agentify",
      destinationRelativeDir: ".claude/agentify",
      runId,
      interruptAfterPhase: "committed",
    }), StateMigrationInterruptedError);

    assert.ok(fs.existsSync(sourceFile));
    assert.ok(fs.existsSync(destinationFile));
    assert.deepEqual(recoverInterruptedStateTransactions(cwd), [runId]);
    assert.equal(fs.readFileSync(sourceFile, "utf-8"), '{"marker":"legacy"}\n');
    assert.equal(fs.readFileSync(destinationFile, "utf-8"), '{"marker":"legacy"}\n');
    assert.deepEqual(recoverInterruptedStateTransactions(cwd), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await testCommittedMigrationRecoveryKeepsBothTrees();
console.log("state-transaction committed recovery test passed.");
