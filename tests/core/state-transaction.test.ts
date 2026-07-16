import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  beginStateTransaction,
  listInterruptedStateTransactions,
  recoverInterruptedStateTransactions,
} from "../../src/core/state-transaction.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(cwd: string, relativePath: string, content: string): void {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function read(cwd: string, relativePath: string): string {
  return fs.readFileSync(path.join(cwd, relativePath), "utf-8");
}

function transactionRoot(cwd: string): string {
  return path.join(cwd, ".agentify", "state-transactions");
}

async function testRollbackRestoresProviderState(): Promise<void> {
  const cwd = tempDir("agentify-state-rollback-");
  try {
    write(cwd, ".claude/agentify/codebase_map.json", "old-map\n");
    write(cwd, ".claude/agentify/history/run.json", "old-history\n");
    const transaction = beginStateTransaction({
      cwd,
      sourceRelativeDir: ".claude/agentify",
      destinationRelativeDir: ".claude/agentify",
      runId: "rollback-provider",
    });

    assert.ok(fs.existsSync(path.join(cwd, ".claude/agentify")));
    assert.equal(fs.readdirSync(path.join(cwd, ".claude/agentify")).length, 0);
    write(cwd, ".claude/agentify/codebase_map.json", "partial-map\n");
    transaction.rollback();

    assert.equal(read(cwd, ".claude/agentify/codebase_map.json"), "old-map\n");
    assert.equal(read(cwd, ".claude/agentify/history/run.json"), "old-history\n");
    assert.ok(!fs.existsSync(transactionRoot(cwd)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testCommitKeepsNewProviderState(): Promise<void> {
  const cwd = tempDir("agentify-state-commit-");
  try {
    write(cwd, ".agents/agentify/codebase_map.json", "old-map\n");
    const transaction = beginStateTransaction({
      cwd,
      sourceRelativeDir: ".agents/agentify",
      destinationRelativeDir: ".agents/agentify",
      runId: "commit-provider",
    });
    write(cwd, ".agents/agentify/codebase_map.json", "new-map\n");
    transaction.commit();

    assert.equal(read(cwd, ".agents/agentify/codebase_map.json"), "new-map\n");
    assert.ok(!fs.existsSync(transactionRoot(cwd)));
    transaction.commit();
    transaction.rollback();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testLegacyCrossDirectoryMovesAreRetired(): Promise<void> {
  const cwd = tempDir("agentify-state-migrate-retired-");
  try {
    write(cwd, ".pi/agentify/codebase_map.json", "legacy-map\n");
    assert.throws(
      () => beginStateTransaction({
        cwd,
        sourceRelativeDir: ".pi/agentify",
        destinationRelativeDir: ".claude/agentify",
        runId: "migrate-retired",
      }),
      /cross-directory state moves are retired/,
    );
    assert.equal(read(cwd, ".pi/agentify/codebase_map.json"), "legacy-map\n");
    assert.ok(!fs.existsSync(path.join(cwd, ".claude/agentify")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testInterruptedTransactionRecovery(): Promise<void> {
  const cwd = tempDir("agentify-state-recovery-");
  try {
    write(cwd, ".agents/agentify/manifest.json", "old-manifest\n");
    beginStateTransaction({
      cwd,
      sourceRelativeDir: ".agents/agentify",
      destinationRelativeDir: ".agents/agentify",
      runId: "interrupted-run",
    });
    write(cwd, ".agents/agentify/manifest.json", "partial-manifest\n");

    assert.deepEqual(listInterruptedStateTransactions(cwd), ["interrupted-run"]);
    assert.equal(read(cwd, ".agents/agentify/manifest.json"), "partial-manifest\n");
    assert.deepEqual(recoverInterruptedStateTransactions(cwd), ["interrupted-run"]);
    assert.equal(read(cwd, ".agents/agentify/manifest.json"), "old-manifest\n");
    assert.deepEqual(listInterruptedStateTransactions(cwd), []);
    assert.deepEqual(recoverInterruptedStateTransactions(cwd), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRollbackRemovesNewStateWhenNoPreviousState(): Promise<void> {
  const cwd = tempDir("agentify-state-new-rollback-");
  try {
    const transaction = beginStateTransaction({
      cwd,
      sourceRelativeDir: ".pi/agentify",
      destinationRelativeDir: ".pi/agentify",
      runId: "new-state-rollback",
    });
    write(cwd, ".pi/agentify/codebase_map.json", "partial\n");
    transaction.rollback();
    assert.ok(!fs.existsSync(path.join(cwd, ".pi/agentify")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testCommitMissingDestinationRestoresOldState(): Promise<void> {
  const cwd = tempDir("agentify-state-missing-destination-");
  try {
    write(cwd, ".claude/agentify/codebase_map.json", "old-map\n");
    const transaction = beginStateTransaction({
      cwd,
      sourceRelativeDir: ".claude/agentify",
      destinationRelativeDir: ".claude/agentify",
      runId: "missing-destination",
    });
    fs.rmSync(path.join(cwd, ".claude/agentify"), { recursive: true, force: true });
    assert.throws(() => transaction.commit(), /destination disappeared/);
    assert.equal(read(cwd, ".claude/agentify/codebase_map.json"), "old-map\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testOccupiedMigrationDestinationRejected(): Promise<void> {
  const cwd = tempDir("agentify-state-occupied-");
  try {
    write(cwd, ".pi/agentify/codebase_map.json", "legacy\n");
    write(cwd, ".claude/agentify/codebase_map.json", "occupied\n");
    assert.throws(
      () => beginStateTransaction({
        cwd,
        sourceRelativeDir: ".pi/agentify",
        destinationRelativeDir: ".claude/agentify",
        runId: "occupied-destination",
      }),
      /cross-directory state moves are retired/,
    );
    assert.equal(read(cwd, ".pi/agentify/codebase_map.json"), "legacy\n");
    assert.equal(read(cwd, ".claude/agentify/codebase_map.json"), "occupied\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRejectsEscapingPathsAndUnsafeRunIds(): Promise<void> {
  const cwd = tempDir("agentify-state-validation-");
  try {
    assert.throws(
      () => beginStateTransaction({
        cwd,
        sourceRelativeDir: "../outside",
        destinationRelativeDir: ".pi/agentify",
      }),
      /inside the repository/,
    );
    assert.throws(
      () => beginStateTransaction({
        cwd,
        sourceRelativeDir: ".pi/agentify",
        destinationRelativeDir: ".pi/agentify",
        runId: "bad/run-id",
      }),
      /invalid Agentify state transaction run ID/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "rollbackRestoresProviderState", fn: testRollbackRestoresProviderState },
  { name: "commitKeepsNewProviderState", fn: testCommitKeepsNewProviderState },
  { name: "legacyCrossDirectoryMovesAreRetired", fn: testLegacyCrossDirectoryMovesAreRetired },
  { name: "interruptedTransactionRecovery", fn: testInterruptedTransactionRecovery },
  { name: "rollbackRemovesNewStateWhenNoPreviousState", fn: testRollbackRemovesNewStateWhenNoPreviousState },
  { name: "commitMissingDestinationRestoresOldState", fn: testCommitMissingDestinationRestoresOldState },
  { name: "occupiedMigrationDestinationRejected", fn: testOccupiedMigrationDestinationRejected },
  { name: "rejectsEscapingPathsAndUnsafeRunIds", fn: testRejectsEscapingPathsAndUnsafeRunIds },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`  ok ${test.name}`);
  } catch (error) {
    console.error(`  FAIL ${test.name}: ${(error as Error).message}`);
    if ((error as Error).stack) console.error((error as Error).stack);
    process.exit(1);
  }
}
console.log(`state-transaction tests passed (${passed}/${tests.length}).`);
