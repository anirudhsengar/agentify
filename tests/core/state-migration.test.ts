import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  StateMigrationInterruptedError,
  migrateRetainedState,
  recoverInterruptedStateTransactions,
  type StateMigrationPhase,
} from "../../src/core/state-transaction.ts";
import { inspectStateTree } from "../../src/core/state-dir.ts";

const SOURCE = ".pi/agentify";
const DESTINATION = ".claude/agentify";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-migration-${name}-`));
}

function writeFile(cwd: string, relativePath: string, content: string, mode = 0o644): void {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode });
  fs.chmodSync(filePath, mode);
}

function seedState(cwd: string): void {
  writeFile(cwd, `${SOURCE}/codebase_map.json`, '{"schema_version":"1","marker":"legacy"}\n', 0o640);
  writeFile(cwd, `${SOURCE}/manifest.json`, JSON.stringify({
    schema_version: "2",
    agentify_version: "0.0.9",
    generated_at: "2026-07-01T00:00:00.000Z",
    mode: "brownfield",
    run_id: "old-run",
    files: [],
  }, null, 2) + "\n");
  writeFile(cwd, `${SOURCE}/history/old.json`, '{"old":true}\n');
  writeFile(cwd, `${SOURCE}/runs/old-run/snapshot.json`, '{"AGENTS.md":{"content":"","mode":420}}\n');
  writeFile(cwd, `${SOURCE}/runs/old-run/manifest.previous.json`, '{"schema_version":"1"}\n');
  writeFile(cwd, `${SOURCE}/unknown/retained.bin`, "retained\n", 0o600);
}

function snapshot(cwd: string, relativeDir: string): Map<string, { content: Buffer; mode: number }> {
  const root = path.join(cwd, relativeDir);
  const result = new Map<string, { content: Buffer; mode: number }>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assert.equal(entry.isSymbolicLink(), false, relative);
      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      const descriptor = fs.openSync(
        absolute,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        const stat = fs.fstatSync(descriptor);
        assert.equal(stat.isFile(), true, relative);
        result.set(relative, {
          content: fs.readFileSync(descriptor),
          mode: stat.mode & 0o777,
        });
      } finally {
        fs.closeSync(descriptor);
      }
    }
  };
  walk(root, "");
  return result;
}

function assertTreesEqual(cwd: string): void {
  const source = snapshot(cwd, SOURCE);
  const destination = snapshot(cwd, DESTINATION);
  assert.deepEqual([...destination.keys()], [...source.keys()]);
  for (const [relative, expected] of source) {
    const actual = destination.get(relative);
    assert.ok(actual, relative);
    assert.deepEqual(actual.content, expected.content, relative);
    assert.equal(actual.mode, expected.mode, relative);
  }
  assert.equal(inspectStateTree(cwd, SOURCE).fingerprint, inspectStateTree(cwd, DESTINATION).fingerprint);
}

async function testSuccessfulMigrationRetainsCompleteSource(): Promise<void> {
  const cwd = tempDir("success");
  try {
    seedState(cwd);
    const before = snapshot(cwd, SOURCE);
    const result = migrateRetainedState({
      cwd,
      sourceRelativeDir: SOURCE,
      destinationRelativeDir: DESTINATION,
      runId: "success",
      creationVersion: "0.1.0",
    });
    assert.equal(result.runId, "success");
    assert.ok(fs.existsSync(path.join(cwd, SOURCE)));
    assert.ok(fs.existsSync(path.join(cwd, DESTINATION)));
    assert.deepEqual(snapshot(cwd, SOURCE), before);
    assertTreesEqual(cwd);
    assert.ok(!fs.existsSync(path.join(cwd, ".agentify/state-transactions")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRecoveryAtEveryPhase(): Promise<void> {
  const phases: StateMigrationPhase[] = [
    "prepared",
    "candidate_copy_started",
    "candidate_copy_complete",
    "candidate_verified",
    "destination_installed",
    "committed",
    "cleanup_complete",
  ];
  for (const phase of phases) {
    const cwd = tempDir(`phase-${phase}`);
    try {
      seedState(cwd);
      assert.throws(
        () => migrateRetainedState({
          cwd,
          sourceRelativeDir: SOURCE,
          destinationRelativeDir: DESTINATION,
          runId: `phase-${phase}`,
          interruptAfterPhase: phase,
        }),
        (error: unknown) => error instanceof StateMigrationInterruptedError && error.phase === phase,
      );
      const recovered = recoverInterruptedStateTransactions(cwd);
      assert.deepEqual(recovered, [`phase-${phase}`]);
      assert.deepEqual(recoverInterruptedStateTransactions(cwd), []);
      assert.ok(fs.existsSync(path.join(cwd, SOURCE)));
      if (phase === "prepared" || phase === "candidate_copy_started") {
        assert.ok(!fs.existsSync(path.join(cwd, DESTINATION)));
      } else {
        assert.ok(fs.existsSync(path.join(cwd, DESTINATION)));
        assertTreesEqual(cwd);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}

async function testSourceMutationStopsRecovery(): Promise<void> {
  const cwd = tempDir("source-change");
  try {
    seedState(cwd);
    assert.throws(() => migrateRetainedState({
      cwd,
      sourceRelativeDir: SOURCE,
      destinationRelativeDir: DESTINATION,
      runId: "source-change",
      interruptAfterPhase: "candidate_copy_complete",
    }), StateMigrationInterruptedError);
    writeFile(cwd, `${SOURCE}/changed-after-copy.txt`, "changed\n");
    assert.throws(
      () => recoverInterruptedStateTransactions(cwd),
      /source changed during transaction/,
    );
    assert.ok(!fs.existsSync(path.join(cwd, DESTINATION)));
    assert.ok(fs.existsSync(path.join(cwd, SOURCE, "changed-after-copy.txt")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testUnsafeAndOccupiedPathsAreRefused(): Promise<void> {
  const occupied = tempDir("occupied");
  try {
    seedState(occupied);
    writeFile(occupied, `${DESTINATION}/codebase_map.json`, '{"occupied":true}\n');
    assert.throws(() => migrateRetainedState({
      cwd: occupied,
      sourceRelativeDir: SOURCE,
      destinationRelativeDir: DESTINATION,
    }), /occupied destination/);
    assert.ok(fs.existsSync(path.join(occupied, SOURCE)));
  } finally {
    fs.rmSync(occupied, { recursive: true, force: true });
  }

  const sourceSymlink = tempDir("source-symlink");
  try {
    const outside = path.join(sourceSymlink, "outside");
    fs.mkdirSync(outside);
    writeFile(sourceSymlink, "outside/codebase_map.json", '{"outside":true}\n');
    fs.mkdirSync(path.join(sourceSymlink, ".pi"));
    fs.symlinkSync(outside, path.join(sourceSymlink, SOURCE));
    assert.throws(() => migrateRetainedState({
      cwd: sourceSymlink,
      sourceRelativeDir: SOURCE,
      destinationRelativeDir: DESTINATION,
    }), /symlink|not a complete readable/);
  } finally {
    fs.rmSync(sourceSymlink, { recursive: true, force: true });
  }

  const destinationSymlink = tempDir("destination-symlink");
  try {
    seedState(destinationSymlink);
    fs.mkdirSync(path.join(destinationSymlink, "outside"));
    fs.symlinkSync(path.join(destinationSymlink, "outside"), path.join(destinationSymlink, ".claude"));
    assert.throws(() => migrateRetainedState({
      cwd: destinationSymlink,
      sourceRelativeDir: SOURCE,
      destinationRelativeDir: DESTINATION,
    }), /symlink/);
  } finally {
    fs.rmSync(destinationSymlink, { recursive: true, force: true });
  }

  const transactionSymlink = tempDir("transaction-symlink");
  try {
    seedState(transactionSymlink);
    fs.mkdirSync(path.join(transactionSymlink, "outside"));
    fs.symlinkSync(path.join(transactionSymlink, "outside"), path.join(transactionSymlink, ".agentify"));
    assert.throws(() => migrateRetainedState({
      cwd: transactionSymlink,
      sourceRelativeDir: SOURCE,
      destinationRelativeDir: DESTINATION,
    }), /transaction root.*symlink|unsafe Agentify state transaction root/);
  } finally {
    fs.rmSync(transactionSymlink, { recursive: true, force: true });
  }
}


async function testProviderSwitchRewritesOnlyDestinationManifest(): Promise<void> {
  const cwd = tempDir("provider-switch");
  try {
    const source = ".claude/agentify";
    const destination = ".agents/agentify";
    writeFile(cwd, `${source}/codebase_map.json`, '{"marker":"claude"}\n');
    writeFile(cwd, `${source}/manifest.json`, JSON.stringify({
      schema_version: "2",
      agentify_version: "0.1.0",
      generated_at: "2026-07-13T00:00:00.000Z",
      mode: "brownfield",
      run_id: "claude-run",
      state_dir: source,
      files: [],
    }, null, 2) + "\n");
    const originalManifest = fs.readFileSync(path.join(cwd, source, "manifest.json"), "utf-8");
    const result = migrateRetainedState({
      cwd,
      sourceRelativeDir: source,
      destinationRelativeDir: destination,
      rewriteManifestStateDir: true,
      runId: "provider-switch",
    });
    assert.notEqual(result.installedFingerprint, result.candidateFingerprint);
    assert.equal(fs.readFileSync(path.join(cwd, source, "manifest.json"), "utf-8"), originalManifest);
    const installed = JSON.parse(fs.readFileSync(path.join(cwd, destination, "manifest.json"), "utf-8")) as { state_dir?: string };
    assert.equal(installed.state_dir, destination);
    assert.equal(fs.readFileSync(path.join(cwd, destination, "codebase_map.json"), "utf-8"), '{"marker":"claude"}\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testProviderSwitchRecoveryAfterRename(): Promise<void> {
  const cwd = tempDir("provider-switch-recovery");
  try {
    const source = ".agents/agentify";
    const destination = ".pi/agentify";
    writeFile(cwd, `${source}/codebase_map.json`, '{"marker":"codex"}\n');
    writeFile(cwd, `${source}/manifest.json`, JSON.stringify({
      schema_version: "2", agentify_version: "0.1.0", generated_at: "2026-07-13T00:00:00.000Z",
      mode: "brownfield", run_id: "codex-run", state_dir: source, files: [],
    }) + "\n");
    assert.throws(() => migrateRetainedState({
      cwd, sourceRelativeDir: source, destinationRelativeDir: destination,
      rewriteManifestStateDir: true, runId: "provider-switch-recovery",
      interruptAfterPhase: "destination_installed",
    }), StateMigrationInterruptedError);
    assert.deepEqual(recoverInterruptedStateTransactions(cwd), ["provider-switch-recovery"]);
    const installed = JSON.parse(fs.readFileSync(path.join(cwd, destination, "manifest.json"), "utf-8")) as { state_dir?: string };
    assert.equal(installed.state_dir, destination);
    assert.ok(fs.existsSync(path.join(cwd, source, "manifest.json")));
    assert.deepEqual(recoverInterruptedStateTransactions(cwd), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await testSuccessfulMigrationRetainsCompleteSource();
await testRecoveryAtEveryPhase();
await testSourceMutationStopsRecovery();
await testUnsafeAndOccupiedPathsAreRefused();
await testProviderSwitchRewritesOnlyDestinationManifest();
await testProviderSwitchRecoveryAfterRename();
console.log("state migration tests passed");
