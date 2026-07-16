import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { inspectStateTree } from "./state-layout.ts";

const TRANSACTION_ROOT_RELATIVE = ".agentify/state-transactions";
const JOURNAL_FILE = "journal.json";
const BACKUP_DIR = "backup";
const BACKUP_COPY_DIR = "backup.copying";
const CANDIDATE_DIR = "candidate";
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

interface LegacyStateTransactionJournal {
  schema_version: "1";
  run_id: string;
  source_relative_dir: string;
  destination_relative_dir: string;
  had_existing_state: boolean;
  phase: "prepared" | "backup_created" | "destination_ready" | "committed";
}

export type StateMigrationPhase =
  | "prepared"
  | "candidate_copy_started"
  | "candidate_copy_complete"
  | "candidate_verified"
  | "destination_installed"
  | "committed"
  | "cleanup_complete";

interface StateMigrationJournal {
  schema_version: "2";
  operation: "retained_legacy_migration";
  run_id: string;
  repository_root: string;
  source_relative_dir: string;
  destination_relative_dir: string;
  candidate_relative_dir: string;
  source_fingerprint: string;
  destination_expected_absent: true;
  candidate_fingerprint: string | null;
  installed_fingerprint: string | null;
  rewrite_manifest_state_dir: boolean;
  retain_source: true;
  creation_version: string;
  phase: StateMigrationPhase;
}

type StateTransactionJournal = LegacyStateTransactionJournal | StateMigrationJournal;

export interface BeginStateTransactionOptions {
  cwd: string;
  /** Existing state location. May be the legacy `.pi/agentify` directory. */
  sourceRelativeDir: string;
  /** Provider-selected location where the new run writes state. */
  destinationRelativeDir: string;
  runId?: string;
  /**
   * Copy the existing source into the transaction backup and update it in
   * place. Retained for Phase A/source-checkout compatibility.
   */
  preserveExistingSource?: boolean;
}

export interface StateTransaction {
  readonly runId: string;
  readonly sourceRelativeDir: string;
  readonly destinationRelativeDir: string;
  readonly destinationAbsoluteDir: string;
  commit(): void;
  rollback(): void;
}

export interface MigrateRetainedStateOptions {
  cwd: string;
  sourceRelativeDir: string;
  destinationRelativeDir: string;
  runId?: string;
  creationVersion?: string;
  /** Rewrite a copied provider manifest so it names the new canonical path. */
  rewriteManifestStateDir?: boolean;
  /** Test-only durable-phase interruption hook. */
  interruptAfterPhase?: StateMigrationPhase;
}

export interface StateMigrationResult {
  runId: string;
  sourceRelativeDir: string;
  destinationRelativeDir: string;
  sourceFingerprint: string;
  candidateFingerprint: string;
  installedFingerprint: string;
}

export class StateMigrationInterruptedError extends Error {
  readonly phase: StateMigrationPhase;

  constructor(phase: StateMigrationPhase) {
    super(`simulated interruption after state migration phase ${phase}`);
    this.name = "StateMigrationInterruptedError";
    this.phase = phase;
  }
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

function repositoryIdentity(cwd: string): string {
  return fs.realpathSync.native(path.resolve(cwd));
}

function transactionRoot(cwd: string): string {
  return path.join(path.resolve(cwd), TRANSACTION_ROOT_RELATIVE);
}

function transactionDir(cwd: string, runId: string): string {
  return path.join(transactionRoot(cwd), runId);
}

function transactionRelativeDir(runId: string): string {
  return `${TRANSACTION_ROOT_RELATIVE}/${runId}`;
}

function journalPath(cwd: string, runId: string): string {
  return path.join(transactionDir(cwd, runId), JOURNAL_FILE);
}

function backupPath(cwd: string, runId: string): string {
  return path.join(transactionDir(cwd, runId), BACKUP_DIR);
}

function backupCopyPath(cwd: string, runId: string): string {
  return path.join(transactionDir(cwd, runId), BACKUP_COPY_DIR);
}

function candidateRelativeDir(runId: string): string {
  return `${transactionRelativeDir(runId)}/${CANDIDATE_DIR}`;
}

function candidatePath(cwd: string, runId: string): string {
  return path.join(transactionDir(cwd, runId), CANDIDATE_DIR);
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is not supported on every platform. File fsync remains durable.
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
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
  fsyncDirectory(path.dirname(filePath));
}

function isStateMigrationPhase(value: unknown): value is StateMigrationPhase {
  return value === "prepared"
    || value === "candidate_copy_started"
    || value === "candidate_copy_complete"
    || value === "candidate_verified"
    || value === "destination_installed"
    || value === "committed"
    || value === "cleanup_complete";
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
  const value = parsed as Record<string, unknown>;
  if (value.schema_version === "1") {
    if (
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
    return value as unknown as LegacyStateTransactionJournal;
  }
  if (
    value.schema_version !== "2" ||
    value.operation !== "retained_legacy_migration" ||
    typeof value.run_id !== "string" ||
    typeof value.repository_root !== "string" ||
    typeof value.source_relative_dir !== "string" ||
    typeof value.destination_relative_dir !== "string" ||
    typeof value.candidate_relative_dir !== "string" ||
    typeof value.source_fingerprint !== "string" ||
    value.destination_expected_absent !== true ||
    (value.candidate_fingerprint !== null && typeof value.candidate_fingerprint !== "string") ||
    (value.installed_fingerprint !== null && typeof value.installed_fingerprint !== "string") ||
    typeof value.rewrite_manifest_state_dir !== "boolean" ||
    value.retain_source !== true ||
    typeof value.creation_version !== "string" ||
    !isStateMigrationPhase(value.phase)
  ) {
    throw new Error(`invalid Agentify state transaction journal: ${filePath}`);
  }
  return value as unknown as StateMigrationJournal;
}

function removeTransactionDirectory(cwd: string, runId: string): void {
  fs.rmSync(transactionDir(cwd, runId), { recursive: true, force: true });
  try {
    fs.rmdirSync(transactionRoot(cwd));
    fsyncDirectory(path.dirname(transactionRoot(cwd)));
  } catch {
    // Other transactions may remain, or the directory may already be gone.
  }
}

function assertSafeAncestors(cwd: string, relativePath: string, label: string): void {
  const normalized = normalizeRelativeDir(relativePath, label);
  const root = path.resolve(cwd);
  let current = root;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`${label} is unreadable at ${path.relative(root, current)}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} is unsafe: ancestor ${path.relative(root, current)} is a symlink`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${label} is unsafe: ${path.relative(root, current)} is not a directory`);
    }
  }
}

function assertDestinationAbsentAndSafe(cwd: string, relativeDir: string): void {
  assertSafeAncestors(cwd, relativeDir, "state migration destination");
  const absolute = resolveRelative(cwd, relativeDir);
  if (fs.existsSync(absolute)) {
    throw new Error(`cannot migrate Agentify state to occupied destination: ${relativeDir}`);
  }
}

function assertTransactionRootSafe(cwd: string): void {
  assertSafeAncestors(cwd, TRANSACTION_ROOT_RELATIVE, "state transaction root");
}

function copyTreeWithoutSymlinks(source: string, destination: string): void {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`state migration source contains a symlink: ${source}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`state migration source is not a directory: ${source}`);
  }
  fs.mkdirSync(destination, { recursive: false, mode: sourceStat.mode & 0o777 });
  const entries = fs.readdirSync(source, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourceChild = path.join(source, entry.name);
    const destinationChild = path.join(destination, entry.name);
    const stat = fs.lstatSync(sourceChild);
    if (stat.isSymbolicLink()) {
      throw new Error(`state migration source contains a symlink: ${sourceChild}`);
    }
    if (stat.isDirectory()) {
      copyTreeWithoutSymlinks(sourceChild, destinationChild);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`state migration source contains unsupported entry: ${sourceChild}`);
    }
    fs.copyFileSync(sourceChild, destinationChild, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destinationChild, stat.mode & 0o777);
    const descriptor = fs.openSync(destinationChild, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  fs.chmodSync(destination, sourceStat.mode & 0o777);
  fsyncDirectory(destination);
}

function requireFingerprint(cwd: string, relativeDir: string, label: string): string {
  const inspection = inspectStateTree(cwd, relativeDir);
  if (inspection.status !== "valid" || inspection.fingerprint === null) {
    throw new Error(
      `${label} is not a complete readable Agentify state tree at ${relativeDir}: ${inspection.detail ?? inspection.status}`,
    );
  }
  return inspection.fingerprint;
}

function assertRepositoryBinding(cwd: string, journal: StateMigrationJournal): void {
  const actual = repositoryIdentity(cwd);
  if (journal.repository_root !== actual) {
    throw new Error(
      `Agentify state migration ${journal.run_id} belongs to a different repository root; no files were changed`,
    );
  }
  const expectedCandidate = candidateRelativeDir(journal.run_id);
  if (normalizeRelativeDir(journal.candidate_relative_dir, "candidate_relative_dir") !== expectedCandidate) {
    throw new Error(`invalid Agentify state migration candidate path for ${journal.run_id}`);
  }
}

function writeMigrationPhase(
  cwd: string,
  journal: StateMigrationJournal,
  phase: StateMigrationPhase,
  interruptAfterPhase?: StateMigrationPhase,
): StateMigrationJournal {
  const next = { ...journal, phase };
  writeJsonAtomic(journalPath(cwd, journal.run_id), next);
  if (interruptAfterPhase === phase) {
    throw new StateMigrationInterruptedError(phase);
  }
  return next;
}

function removeCandidateSafely(cwd: string, journal: StateMigrationJournal): void {
  const candidate = candidatePath(cwd, journal.run_id);
  if (!fs.existsSync(candidate)) return;
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `cannot clean state migration ${journal.run_id}: candidate path was replaced by a symlink`,
    );
  }
  fs.rmSync(candidate, { recursive: true, force: true });
}

function verifyMigrationSource(cwd: string, journal: StateMigrationJournal): void {
  const sourceFingerprint = requireFingerprint(
    cwd,
    journal.source_relative_dir,
    "state migration source",
  );
  if (sourceFingerprint !== journal.source_fingerprint) {
    throw new Error(
      `state migration source changed during transaction ${journal.run_id}; no source files were modified by Agentify`,
    );
  }
}

function verifyCandidate(cwd: string, journal: StateMigrationJournal): string {
  const fingerprint = requireFingerprint(
    cwd,
    journal.candidate_relative_dir,
    "state migration candidate",
  );
  if (fingerprint !== journal.source_fingerprint) {
    throw new Error(`state migration candidate verification failed for ${journal.run_id}`);
  }
  if (journal.candidate_fingerprint !== null && fingerprint !== journal.candidate_fingerprint) {
    throw new Error(`state migration candidate fingerprint changed for ${journal.run_id}`);
  }
  return fingerprint;
}

function rewriteInstalledManifestStateDir(
  cwd: string,
  sourceRelativeDir: string,
  destinationRelativeDir: string,
): void {
  const filePath = path.join(resolveRelative(cwd, destinationRelativeDir), "manifest.json");
  const manifestLabel = `${destinationRelativeDir}/manifest.json`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`provider-switch migration requires a manifest at ${manifestLabel}`);
    }
    if (code === "ELOOP") {
      throw new Error(`unsafe provider-switch manifest at ${manifestLabel}`);
    }
    throw new Error(`invalid provider-switch manifest at ${manifestLabel}`);
  }

  let stat: fs.Stats;
  let payload: string;
  try {
    stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`unsafe provider-switch manifest at ${manifestLabel}`);
    }
    try {
      payload = fs.readFileSync(descriptor, "utf-8");
    } catch {
      throw new Error(`invalid provider-switch manifest at ${manifestLabel}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`invalid provider-switch manifest at ${manifestLabel}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid provider-switch manifest at ${destinationRelativeDir}/manifest.json`);
  }
  const manifest = parsed as Record<string, unknown>;
  const files = Array.isArray(manifest.files)
    ? manifest.files.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const file = entry as Record<string, unknown>;
      const currentPath = file.path;
      const sourcePrefix = `${sourceRelativeDir}/`;
      return typeof currentPath === "string" && currentPath.startsWith(sourcePrefix)
        ? { ...file, path: `${destinationRelativeDir}/${currentPath.slice(sourcePrefix.length)}` }
        : file;
    })
    : manifest.files;
  writeJsonAtomic(filePath, {
    ...manifest,
    ...(files === undefined ? {} : { files }),
    state_dir: destinationRelativeDir,
  });
  fs.chmodSync(filePath, stat.mode & 0o777);
}

function ensureInstalledMigrationFingerprint(
  cwd: string,
  journal: StateMigrationJournal,
): string {
  const current = requireFingerprint(
    cwd,
    journal.destination_relative_dir,
    "installed state migration destination",
  );
  if (!journal.rewrite_manifest_state_dir) {
    if (journal.candidate_fingerprint !== null && current !== journal.candidate_fingerprint) {
      throw new Error(`installed state migration destination differs from candidate for ${journal.run_id}`);
    }
    return current;
  }
  const inspection = inspectStateTree(cwd, journal.destination_relative_dir);
  if (inspection.manifestStateDir !== journal.destination_relative_dir) {
    if (journal.candidate_fingerprint === null || current !== journal.candidate_fingerprint) {
      throw new Error(`cannot recover provider-switch migration ${journal.run_id}: destination is neither the verified candidate nor explicitly canonical`);
    }
    rewriteInstalledManifestStateDir(
      cwd,
      journal.source_relative_dir,
      journal.destination_relative_dir,
    );
  }
  return requireFingerprint(
    cwd,
    journal.destination_relative_dir,
    "installed provider-switch destination",
  );
}

function installVerifiedCandidate(
  cwd: string,
  journal: StateMigrationJournal,
  interruptAfterPhase?: StateMigrationPhase,
): StateMigrationJournal {
  verifyMigrationSource(cwd, journal);
  const candidateFingerprint = verifyCandidate(cwd, journal);
  assertDestinationAbsentAndSafe(cwd, journal.destination_relative_dir);
  const destination = resolveRelative(cwd, journal.destination_relative_dir);
  const candidate = resolveRelative(cwd, journal.candidate_relative_dir);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  assertSafeAncestors(cwd, journal.destination_relative_dir, "state migration destination");
  if (fs.existsSync(destination)) {
    throw new Error(`cannot migrate Agentify state to occupied destination: ${journal.destination_relative_dir}`);
  }
  fs.renameSync(candidate, destination);
  fsyncDirectory(path.dirname(destination));
  if (journal.rewrite_manifest_state_dir) {
    rewriteInstalledManifestStateDir(
      cwd,
      journal.source_relative_dir,
      journal.destination_relative_dir,
    );
  }
  const installedFingerprint = ensureInstalledMigrationFingerprint(cwd, {
    ...journal,
    candidate_fingerprint: candidateFingerprint,
  });
  let next = writeMigrationPhase(cwd, {
    ...journal,
    candidate_fingerprint: candidateFingerprint,
    installed_fingerprint: installedFingerprint,
  }, "destination_installed", interruptAfterPhase);
  verifyMigrationSource(cwd, next);
  next = writeMigrationPhase(cwd, next, "committed", interruptAfterPhase);
  next = writeMigrationPhase(cwd, next, "cleanup_complete", interruptAfterPhase);
  removeTransactionDirectory(cwd, journal.run_id);
  return next;
}

function rollbackMigrationJournal(cwd: string, journal: StateMigrationJournal): void {
  assertRepositoryBinding(cwd, journal);
  verifyMigrationSource(cwd, journal);
  const destination = resolveRelative(cwd, journal.destination_relative_dir);
  if (journal.phase === "destination_installed") {
    if (journal.installed_fingerprint === null) {
      throw new Error(`cannot roll back state migration ${journal.run_id}: installed fingerprint is missing`);
    }
    const installedFingerprint = requireFingerprint(
      cwd,
      journal.destination_relative_dir,
      "installed state migration destination",
    );
    if (installedFingerprint !== journal.installed_fingerprint) {
      throw new Error(
        `cannot roll back state migration ${journal.run_id}: destination no longer matches the journaled install`,
      );
    }
    fs.rmSync(destination, { recursive: true, force: true });
  } else if (journal.phase !== "committed" && journal.phase !== "cleanup_complete") {
    if (fs.existsSync(destination)) {
      throw new Error(
        `cannot roll back state migration ${journal.run_id}: destination became occupied; manual recovery is required`,
      );
    }
  } else {
    throw new Error(`state migration ${journal.run_id} is committed and cannot be rolled back`);
  }
  removeCandidateSafely(cwd, journal);
  removeTransactionDirectory(cwd, journal.run_id);
}

function recoverMigrationJournal(cwd: string, journal: StateMigrationJournal): void {
  assertRepositoryBinding(cwd, journal);
  verifyMigrationSource(cwd, journal);
  const destination = resolveRelative(cwd, journal.destination_relative_dir);
  const candidate = resolveRelative(cwd, journal.candidate_relative_dir);

  if (journal.phase === "prepared" || journal.phase === "candidate_copy_started") {
    if (fs.existsSync(destination)) {
      throw new Error(
        `cannot recover state migration ${journal.run_id}: destination is unexpectedly occupied`,
      );
    }
    removeCandidateSafely(cwd, journal);
    removeTransactionDirectory(cwd, journal.run_id);
    return;
  }

  if (journal.phase === "candidate_copy_complete" || journal.phase === "candidate_verified") {
    if (!fs.existsSync(candidate) && fs.existsSync(destination)) {
      if (journal.candidate_fingerprint === null) {
        throw new Error(`cannot recover state migration ${journal.run_id}: candidate fingerprint is missing`);
      }
      const installedFingerprint = ensureInstalledMigrationFingerprint(cwd, journal);
      let next = writeMigrationPhase(cwd, {
        ...journal,
        installed_fingerprint: installedFingerprint,
      }, "destination_installed");
      next = writeMigrationPhase(cwd, next, "committed");
      writeMigrationPhase(cwd, next, "cleanup_complete");
      removeTransactionDirectory(cwd, journal.run_id);
      return;
    }
    if (fs.existsSync(destination)) {
      throw new Error(`cannot recover state migration ${journal.run_id}: destination is occupied`);
    }
    const fingerprint = verifyCandidate(cwd, journal);
    const verified = writeMigrationPhase(cwd, {
      ...journal,
      candidate_fingerprint: fingerprint,
    }, "candidate_verified");
    installVerifiedCandidate(cwd, verified);
    return;
  }

  if (journal.phase === "destination_installed") {
    if (journal.installed_fingerprint === null) {
      throw new Error(`cannot recover state migration ${journal.run_id}: installed fingerprint is missing`);
    }
    const installedFingerprint = requireFingerprint(
      cwd,
      journal.destination_relative_dir,
      "installed state migration destination",
    );
    if (installedFingerprint !== journal.installed_fingerprint) {
      throw new Error(`cannot recover state migration ${journal.run_id}: installed destination changed`);
    }
    let next = writeMigrationPhase(cwd, journal, "committed");
    writeMigrationPhase(cwd, next, "cleanup_complete");
    removeTransactionDirectory(cwd, journal.run_id);
    return;
  }

  // committed and cleanup_complete are authoritative. Retain both trees and finish cleanup.
  if (!fs.existsSync(destination)) {
    throw new Error(`cannot recover committed state migration ${journal.run_id}: destination is missing`);
  }
  if (journal.installed_fingerprint !== null) {
    const installedFingerprint = requireFingerprint(
      cwd,
      journal.destination_relative_dir,
      "installed state migration destination",
    );
    if (installedFingerprint !== journal.installed_fingerprint) {
      throw new Error(`cannot recover committed state migration ${journal.run_id}: destination fingerprint changed`);
    }
  }
  removeTransactionDirectory(cwd, journal.run_id);
}

function restoreLegacyJournal(cwd: string, journal: LegacyStateTransactionJournal): void {
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
    fs.rmSync(destination, { recursive: true, force: true });
  } else if (source !== destination) {
    fs.rmSync(destination, { recursive: true, force: true });
  }

  removeTransactionDirectory(cwd, journal.run_id);
}

export function recoverInterruptedStateTransactions(cwd: string): string[] {
  const root = transactionRoot(cwd);
  if (!fs.existsSync(root)) return [];
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`unsafe Agentify state transaction root: ${TRANSACTION_ROOT_RELATIVE}`);
  }

  const recovered: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) {
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
    if (journal.schema_version === "2") recoverMigrationJournal(cwd, journal);
    else restoreLegacyJournal(cwd, journal);
    recovered.push(entry.name);
  }
  return recovered;
}

/**
 * Return interrupted transaction IDs without changing repository state.
 * Callers can use this to ask an interactive user how they want to proceed
 * before the mandatory crash-recovery pass restores a safe filesystem state.
 */
export function listInterruptedStateTransactions(cwd: string): string[] {
  const root = transactionRoot(cwd);
  if (!fs.existsSync(root)) return [];
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`unsafe Agentify state transaction root: ${TRANSACTION_ROOT_RELATIVE}`);
  }

  return fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) {
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
      return entry.name;
    });
}

export function migrateRetainedState(
  options: MigrateRetainedStateOptions,
): StateMigrationResult {
  const cwd = path.resolve(options.cwd);
  recoverInterruptedStateTransactions(cwd);
  assertTransactionRootSafe(cwd);

  const runId = options.runId ?? crypto.randomUUID();
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(`invalid Agentify state transaction run ID: ${runId}`);
  }
  const sourceRelativeDir = normalizeRelativeDir(options.sourceRelativeDir, "sourceRelativeDir");
  const destinationRelativeDir = normalizeRelativeDir(
    options.destinationRelativeDir,
    "destinationRelativeDir",
  );
  if (sourceRelativeDir === destinationRelativeDir) {
    throw new Error("retained state migration requires different source and destination paths");
  }
  const sourceFingerprint = requireFingerprint(cwd, sourceRelativeDir, "state migration source");
  assertDestinationAbsentAndSafe(cwd, destinationRelativeDir);
  if (fs.existsSync(transactionDir(cwd, runId))) {
    throw new Error(`Agentify state transaction already exists: ${runId}`);
  }
  fs.mkdirSync(transactionDir(cwd, runId), { recursive: true, mode: 0o700 });

  let journal: StateMigrationJournal = {
    schema_version: "2",
    operation: "retained_legacy_migration",
    run_id: runId,
    repository_root: repositoryIdentity(cwd),
    source_relative_dir: sourceRelativeDir,
    destination_relative_dir: destinationRelativeDir,
    candidate_relative_dir: candidateRelativeDir(runId),
    source_fingerprint: sourceFingerprint,
    destination_expected_absent: true,
    candidate_fingerprint: null,
    installed_fingerprint: null,
    rewrite_manifest_state_dir: options.rewriteManifestStateDir ?? false,
    retain_source: true,
    creation_version: options.creationVersion ?? "unknown",
    phase: "prepared",
  };

  try {
    journal = writeMigrationPhase(cwd, journal, "prepared", options.interruptAfterPhase);
    journal = writeMigrationPhase(
      cwd,
      journal,
      "candidate_copy_started",
      options.interruptAfterPhase,
    );
    copyTreeWithoutSymlinks(
      resolveRelative(cwd, sourceRelativeDir),
      candidatePath(cwd, runId),
    );
    verifyMigrationSource(cwd, journal);
    const candidateFingerprint = requireFingerprint(
      cwd,
      journal.candidate_relative_dir,
      "state migration candidate",
    );
    if (candidateFingerprint !== sourceFingerprint) {
      throw new Error(`state migration candidate verification failed for ${runId}`);
    }
    journal = writeMigrationPhase(cwd, {
      ...journal,
      candidate_fingerprint: candidateFingerprint,
    }, "candidate_copy_complete", options.interruptAfterPhase);
    journal = writeMigrationPhase(
      cwd,
      journal,
      "candidate_verified",
      options.interruptAfterPhase,
    );
    installVerifiedCandidate(cwd, journal, options.interruptAfterPhase);
    const installedFingerprint = requireFingerprint(
      cwd,
      destinationRelativeDir,
      "installed state migration destination",
    );
    return {
      runId,
      sourceRelativeDir,
      destinationRelativeDir,
      sourceFingerprint,
      candidateFingerprint,
      installedFingerprint,
    };
  } catch (error) {
    if (error instanceof StateMigrationInterruptedError) throw error;
    try {
      const durable = readJournal(journalPath(cwd, runId));
      if (durable.schema_version === "2" && durable.phase !== "committed" && durable.phase !== "cleanup_complete") {
        rollbackMigrationJournal(cwd, durable);
      }
    } catch (rollbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; automatic migration rollback stopped: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw error;
  }
}

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
  if (source !== destination) {
    throw new Error(
      "cross-directory state moves are retired; use migrateRetainedState for copy-verify-install migration",
    );
  }
  const transaction = transactionDir(cwd, runId);
  const backup = backupPath(cwd, runId);
  const backupCopy = backupCopyPath(cwd, runId);
  if (fs.existsSync(transaction)) {
    throw new Error(`Agentify state transaction already exists: ${runId}`);
  }
  if (source !== destination && fs.existsSync(destination)) {
    throw new Error(
      `cannot migrate Agentify state to occupied destination: ${destinationRelativeDir}`,
    );
  }
  if (options.preserveExistingSource && source !== destination) {
    throw new Error("preserveExistingSource requires identical source and destination paths");
  }

  const hadExistingState = fs.existsSync(source);
  let journal: LegacyStateTransactionJournal = {
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
      if (options.preserveExistingSource) {
        fs.cpSync(source, backupCopy, {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        });
        fs.renameSync(backupCopy, backup);
      } else {
        fs.renameSync(source, backup);
      }
      journal = { ...journal, phase: "backup_created" };
      writeJsonAtomic(journalPath(cwd, runId), journal);
    }
    if (!options.preserveExistingSource || !hadExistingState) {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    }
    journal = { ...journal, phase: "destination_ready" };
    writeJsonAtomic(journalPath(cwd, runId), journal);
  } catch (error) {
    restoreLegacyJournal(cwd, journal);
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
        restoreLegacyJournal(cwd, journal);
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
        // The committed journal is durable. Recovery will finish cleanup.
      }
    },
    rollback(): void {
      if (!active) return;
      restoreLegacyJournal(cwd, journal);
      active = false;
    },
  };
}
