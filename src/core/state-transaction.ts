import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const TRANSACTION_ROOT_RELATIVE = ".agentify/state-transactions";
const JOURNAL_FILE = "journal.json";
const BACKUP_DIR = "backup";
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

interface StateTransactionJournal {
  schema_version: "1";
  run_id: string;
  source_relative_dir: string;
  destination_relative_dir: string;
  had_existing_state: boolean;
  phase: "prepared" | "backup_created" | "destination_ready" | "committed";
}

export interface BeginStateTransactionOptions {
  cwd: string;
  /** Existing state location. May be the legacy `.pi/agentify` directory. */
  sourceRelativeDir: string;
  /** Provider-selected location where the new run writes state. */
  destinationRelativeDir: string;
  runId?: string;
}

export interface StateTransaction {
  readonly runId: string;
  readonly sourceRelativeDir: string;
  readonly destinationRelativeDir: string;
  readonly destinationAbsoluteDir: string;
  commit(): void;
  rollback(): void;
}

function normalizeRelativeDir(value: string, label: string): string {
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must be repository-relative`);
  }
  const normalized = path.normalize(value);
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${label} must remain inside the repository`);
  }
  return normalized.split(path.sep).join("/");
}

function resolveRelative(cwd: string, relativeDir: string): string {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, relativeDir);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`state path escapes repository: ${relativeDir}`);
  }
  return absolute;
}

function transactionRoot(cwd: string): string {
  return path.join(path.resolve(cwd), TRANSACTION_ROOT_RELATIVE);
}

function transactionDir(cwd: string, runId: string): string {
  return path.join(transactionRoot(cwd), runId);
}

function journalPath(cwd: string, runId: string): string {
  return path.join(transactionDir(cwd, runId), JOURNAL_FILE);
}

function backupPath(cwd: string, runId: string): string {
  return path.join(transactionDir(cwd, runId), BACKUP_DIR);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, payload, "utf-8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
}

function readJournal(filePath: string): StateTransactionJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new Error(
      `cannot recover Agentify state transaction at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid Agentify state transaction journal: ${filePath}`);
  }
  const value = parsed as Partial<StateTransactionJournal>;
  if (
    value.schema_version !== "1" ||
    typeof value.run_id !== "string" ||
    typeof value.source_relative_dir !== "string" ||
    typeof value.destination_relative_dir !== "string" ||
    typeof value.had_existing_state !== "boolean" ||
    (value.phase !== "prepared" &&
      value.phase !== "backup_created" &&
      value.phase !== "destination_ready" &&
      value.phase !== "committed")
  ) {
    throw new Error(`invalid Agentify state transaction journal: ${filePath}`);
  }
  return value as StateTransactionJournal;
}

function removeTransactionDirectory(cwd: string, runId: string): void {
  fs.rmSync(transactionDir(cwd, runId), { recursive: true, force: true });
  try {
    fs.rmdirSync(transactionRoot(cwd));
  } catch {
    // Other transactions may remain, or the directory may already be gone.
  }
}

function restoreJournal(cwd: string, journal: StateTransactionJournal): void {
  const sourceRelativeDir = normalizeRelativeDir(
    journal.source_relative_dir,
    "journal source_relative_dir",
  );
  const destinationRelativeDir = normalizeRelativeDir(
    journal.destination_relative_dir,
    "journal destination_relative_dir",
  );
  const source = resolveRelative(cwd, sourceRelativeDir);
  const destination = resolveRelative(cwd, destinationRelativeDir);
  const backup = backupPath(cwd, journal.run_id);

  if (journal.phase === "committed") {
    // The durable commit marker is the commit point. Cleanup may have been
    // interrupted, but the destination is authoritative and must survive.
    fs.rmSync(backup, { recursive: true, force: true });
    removeTransactionDirectory(cwd, journal.run_id);
    return;
  }

  if (fs.existsSync(backup)) {
    fs.rmSync(destination, { recursive: true, force: true });
    if (source !== destination && fs.existsSync(source)) {
      throw new Error(
        `cannot recover Agentify state transaction ${journal.run_id}: source path is occupied`,
      );
    }
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.renameSync(backup, source);
  } else if (!journal.had_existing_state) {
    // A new repository had no prior state. Any destination is partial output.
    fs.rmSync(destination, { recursive: true, force: true });
  } else if (source !== destination) {
    // The process may have failed after preparing a migration but before the
    // legacy source was moved. The destination cannot contain committed state.
    fs.rmSync(destination, { recursive: true, force: true });
  }

  removeTransactionDirectory(cwd, journal.run_id);
}

/**
 * Restore every interrupted transaction found in the repository.
 * Returns recovered run IDs in deterministic order.
 */
export function recoverInterruptedStateTransactions(cwd: string): string[] {
  const root = transactionRoot(cwd);
  if (!fs.existsSync(root)) return [];

  const recovered: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!SAFE_RUN_ID.test(entry.name)) {
      throw new Error(`invalid Agentify state transaction directory: ${entry.name}`);
    }
    const filePath = journalPath(cwd, entry.name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Agentify state transaction is missing its journal: ${filePath}`);
    }
    const journal = readJournal(filePath);
    if (journal.run_id !== entry.name) {
      throw new Error(`Agentify state transaction run ID mismatch: ${filePath}`);
    }
    restoreJournal(cwd, journal);
    recovered.push(entry.name);
  }
  return recovered;
}

/**
 * Move the previous state tree into a durable repository-local backup and
 * create a fresh provider-scoped destination for the new audit. The caller
 * must finish with exactly one of `commit()` or `rollback()`.
 */
export function beginStateTransaction(
  options: BeginStateTransactionOptions,
): StateTransaction {
  const cwd = path.resolve(options.cwd);
  recoverInterruptedStateTransactions(cwd);

  const runId = options.runId ?? crypto.randomUUID();
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(`invalid Agentify state transaction run ID: ${runId}`);
  }

  const sourceRelativeDir = normalizeRelativeDir(
    options.sourceRelativeDir,
    "sourceRelativeDir",
  );
  const destinationRelativeDir = normalizeRelativeDir(
    options.destinationRelativeDir,
    "destinationRelativeDir",
  );
  const source = resolveRelative(cwd, sourceRelativeDir);
  const destination = resolveRelative(cwd, destinationRelativeDir);
  const transaction = transactionDir(cwd, runId);
  const backup = backupPath(cwd, runId);
  if (fs.existsSync(transaction)) {
    throw new Error(`Agentify state transaction already exists: ${runId}`);
  }
  if (source !== destination && fs.existsSync(destination)) {
    throw new Error(
      `cannot migrate Agentify state to occupied destination: ${destinationRelativeDir}`,
    );
  }

  const hadExistingState = fs.existsSync(source);
  let journal: StateTransactionJournal = {
    schema_version: "1",
    run_id: runId,
    source_relative_dir: sourceRelativeDir,
    destination_relative_dir: destinationRelativeDir,
    had_existing_state: hadExistingState,
    phase: "prepared",
  };
  writeJsonAtomic(journalPath(cwd, runId), journal);

  try {
    if (hadExistingState) {
      fs.renameSync(source, backup);
      journal = { ...journal, phase: "backup_created" };
      writeJsonAtomic(journalPath(cwd, runId), journal);
    }
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    journal = { ...journal, phase: "destination_ready" };
    writeJsonAtomic(journalPath(cwd, runId), journal);
  } catch (error) {
    restoreJournal(cwd, journal);
    throw error;
  }

  let active = true;
  return {
    runId,
    sourceRelativeDir,
    destinationRelativeDir,
    destinationAbsoluteDir: destination,
    commit(): void {
      if (!active) return;
      if (!fs.existsSync(destination)) {
        restoreJournal(cwd, journal);
        active = false;
        throw new Error(
          `cannot commit Agentify state transaction ${runId}: destination disappeared`,
        );
      }
      journal = { ...journal, phase: "committed" };
      writeJsonAtomic(journalPath(cwd, runId), journal);
      active = false;
      try {
        fs.rmSync(backup, { recursive: true, force: true });
        removeTransactionDirectory(cwd, runId);
      } catch {
        // The committed journal is durable. Recovery will finish cleanup on
        // the next run without rolling back the authoritative destination.
      }
    },
    rollback(): void {
      if (!active) return;
      restoreJournal(cwd, journal);
      active = false;
    },
  };
}
