import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  beginStateTransaction,
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

function withRepo(name: string, run: (cwd: string) => void): void {
  const cwd = tempDir(`agentify-legacy-transaction-${name}-`);
  try {
    run(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

withRepo("rollback", (cwd) => {
  write(cwd, ".pi/agentify/codebase_map.json", "old-map\n");
  write(cwd, ".pi/agentify/custom/unknown.txt", "retain-me\n");
  const transaction = beginStateTransaction({
    cwd,
    sourceRelativeDir: ".pi/agentify",
    destinationRelativeDir: ".pi/agentify",
    runId: "legacy-preserve-rollback",
    preserveExistingSource: true,
  });

  assert.equal(read(cwd, ".pi/agentify/codebase_map.json"), "old-map\n");
  assert.equal(read(cwd, ".pi/agentify/custom/unknown.txt"), "retain-me\n");
  write(cwd, ".pi/agentify/codebase_map.json", "partial-map\n");
  transaction.rollback();

  assert.equal(read(cwd, ".pi/agentify/codebase_map.json"), "old-map\n");
  assert.equal(read(cwd, ".pi/agentify/custom/unknown.txt"), "retain-me\n");
});

withRepo("commit", (cwd) => {
  write(cwd, ".pi/agentify/codebase_map.json", "old-map\n");
  write(cwd, ".pi/agentify/custom/unknown.txt", "retain-me\n");
  const transaction = beginStateTransaction({
    cwd,
    sourceRelativeDir: ".pi/agentify",
    destinationRelativeDir: ".pi/agentify",
    runId: "legacy-preserve-commit",
    preserveExistingSource: true,
  });
  write(cwd, ".pi/agentify/codebase_map.json", "new-map\n");
  transaction.commit();

  assert.equal(read(cwd, ".pi/agentify/codebase_map.json"), "new-map\n");
  assert.equal(read(cwd, ".pi/agentify/custom/unknown.txt"), "retain-me\n");
  assert.ok(!fs.existsSync(path.join(cwd, ".agentify/state-transactions")));
});

withRepo("recovery", (cwd) => {
  write(cwd, ".pi/agentify/codebase_map.json", "old-map\n");
  beginStateTransaction({
    cwd,
    sourceRelativeDir: ".pi/agentify",
    destinationRelativeDir: ".pi/agentify",
    runId: "legacy-preserve-recovery",
    preserveExistingSource: true,
  });
  write(cwd, ".pi/agentify/codebase_map.json", "partial-map\n");

  assert.deepEqual(recoverInterruptedStateTransactions(cwd), ["legacy-preserve-recovery"]);
  assert.equal(read(cwd, ".pi/agentify/codebase_map.json"), "old-map\n");
  assert.deepEqual(recoverInterruptedStateTransactions(cwd), []);
});

withRepo("invalid-cross-dir", (cwd) => {
  write(cwd, ".pi/agentify/codebase_map.json", "legacy\n");
  assert.throws(
    () => beginStateTransaction({
      cwd,
      sourceRelativeDir: ".pi/agentify",
      destinationRelativeDir: ".claude/agentify",
      preserveExistingSource: true,
    }),
    /requires identical source and destination/,
  );
});

console.log("legacy compatibility state transaction tests passed.");
