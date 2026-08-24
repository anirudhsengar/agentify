import * as fs from "node:fs";
import * as path from "node:path";
import {
  TeamMemoryInitializationJournalSchema,
  type EvidenceReference,
  type TeamMemoryInitializationJournal,
} from "../schema.ts";
import {
  TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE,
  TEAM_MEMORY_MANIFEST_RELATIVE,
  TEAM_MEMORY_INSTALLATION_REPORT_ENTRY,
  TEAM_MEMORY_ROOT_ALLOWED_ENTRIES,
  teamMemoryInitializationJournalPath,
  teamMemoryRoot,
} from "../paths.ts";
import {
  assertNoPersistedSecrets,
  canonicalJson,
  digestCanonical,
  normalizeEvidence,
} from "../serialization.ts";
import { TeamMemoryError, type MemoryStoreOptions } from "../contracts.ts";
import {
  assertEvidenceSemantics,
  assertNonEmpty,
  validateSchema,
} from "../validation.ts";
import {
  MAX_MANIFEST_BYTES,
  errorCode,
  fsyncDirectory,
  isRecord,
  readJsonFile,
  resolveExistingSafeFile,
  writeJsonAtomic,
} from "./files.ts";

export function createInitializationJournal(input: {
  repositoryId: string;
  supportingCommit: string;
  evidence: ReadonlyArray<EvidenceReference>;
  actor: string;
  createdAt: string;
}): TeamMemoryInitializationJournal {
  const evidence = normalizeEvidence(input.evidence);
  assertEvidenceSemantics(evidence, "team memory initialization");
  if (!evidence.some((entry) => entry.commit_sha === input.supportingCommit)) {
    throw new TeamMemoryError(
      "invalid_input",
      "bootstrap evidence must include the supporting repository commit",
    );
  }
  const withoutDigest: Omit<TeamMemoryInitializationJournal, "journal_digest"> = {
    format: "agentify_team_memory_initialization",
    schema_version: "1",
    repository_id: assertNonEmpty(input.repositoryId, "repository ID"),
    supporting_commit: input.supportingCommit,
    evidence,
    actor: assertNonEmpty(input.actor, "initialization actor"),
    created_at: input.createdAt,
  };
  const journal: TeamMemoryInitializationJournal = {
    ...withoutDigest,
    journal_digest: digestCanonical(withoutDigest),
  };
  validateSchema<TeamMemoryInitializationJournal>(
    TeamMemoryInitializationJournalSchema,
    journal,
    "team memory initialization journal",
  );
  assertNoPersistedSecrets(journal);
  return journal;
}

export function validateInitializationJournal(
  journal: TeamMemoryInitializationJournal,
): TeamMemoryInitializationJournal {
  const { journal_digest: _digest, ...withoutDigest } = journal;
  if (digestCanonical(withoutDigest) !== journal.journal_digest) {
    throw new TeamMemoryError(
      "corrupt_state",
      "team memory initialization journal digest mismatch",
    );
  }
  const normalizedEvidence = normalizeEvidence(journal.evidence);
  if (canonicalJson(normalizedEvidence) !== canonicalJson(journal.evidence)) {
    throw new TeamMemoryError(
      "corrupt_state",
      "team memory initialization journal evidence is not normalized",
    );
  }
  assertEvidenceSemantics(journal.evidence, "team memory initialization");
  if (!journal.evidence.some((entry) => entry.commit_sha === journal.supporting_commit)) {
    throw new TeamMemoryError(
      "corrupt_state",
      "team memory initialization journal lacks evidence for its supporting commit",
    );
  }
  assertNoPersistedSecrets(journal);
  return journal;
}

export function readInitializationJournalIfPresent(
  cwd: string,
): TeamMemoryInitializationJournal | null {
  let parsed: unknown;
  try {
    parsed = readJsonFile(
      resolveExistingSafeFile(cwd, TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE),
      TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE,
    );
  } catch (error) {
    if (error instanceof TeamMemoryError && error.code === "not_found") return null;
    throw error;
  }
  return validateInitializationJournal(
    validateSchema<TeamMemoryInitializationJournal>(
      TeamMemoryInitializationJournalSchema,
      parsed,
      "team memory initialization journal",
    ),
  );
}

export function writeInitializationJournal(
  cwd: string,
  journal: TeamMemoryInitializationJournal,
  options?: MemoryStoreOptions,
): void {
  validateInitializationJournal(journal);
  writeJsonAtomic(cwd, TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE, journal, options);
}

export function removeInitializationJournal(cwd: string): void {
  const journalPath = teamMemoryInitializationJournalPath(cwd);
  try {
    const stat = fs.lstatSync(journalPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TeamMemoryError(
        "unsafe_path",
        `${TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE} must be a regular file`,
      );
    }
    fs.unlinkSync(journalPath);
    fsyncDirectory(path.dirname(journalPath));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export function hasRecognizedManifestMarker(cwd: string): boolean {
  const manifestPath = path.join(teamMemoryRoot(cwd), "manifest.json");
  let parsed: unknown;
  try {
    parsed = readJsonFile(
      manifestPath,
      TEAM_MEMORY_MANIFEST_RELATIVE,
      MAX_MANIFEST_BYTES,
    );
  } catch (error) {
    if (error instanceof TeamMemoryError && error.code === "not_found") return false;
    if (error instanceof TeamMemoryError && error.code === "corrupt_state") return false;
    throw error;
  }
  return isRecord(parsed) && parsed.format === "agentify_team_memory";
}

export function assertInitializationOwnershipAvailable(cwd: string): void {
  const root = teamMemoryRoot(cwd);
  let entries: fs.Dirent[];
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TeamMemoryError("unsafe_path", ".agentify must be a non-symlink directory");
    }
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (hasRecognizedManifestMarker(cwd) || readInitializationJournalIfPresent(cwd) !== null) {
    return;
  }
  // A refused installation writes its report before memory exists. That record
  // is Agentify-owned, so it must not read as user-owned state on the rerun the
  // report itself asks for.
  const unrecognized = entries.filter((entry) => entry.name !== TEAM_MEMORY_INSTALLATION_REPORT_ENTRY);
  if (unrecognized.length > 0) {
    throw new TeamMemoryError(
      "unsafe_path",
      `.agentify contains user-owned or unrecognized state (${unrecognized.map((entry) => entry.name).sort().join(", ")}); no memory files were changed`,
    );
  }
}

export function assertRootEntriesSafe(cwd: string): void {
  const root = teamMemoryRoot(cwd);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new TeamMemoryError("unsafe_path", "cannot inspect .agentify root", { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TeamMemoryError("unsafe_path", ".agentify must be a non-symlink directory");
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!TEAM_MEMORY_ROOT_ALLOWED_ENTRIES.has(entry.name)) {
      throw new TeamMemoryError(
        "unsafe_path",
        `.agentify contains unrecognized user-owned entry ${entry.name}; no memory files were changed`,
      );
    }
    const child = path.join(root, entry.name);
    const childStat = fs.lstatSync(child);
    if (childStat.isSymbolicLink()) {
      throw new TeamMemoryError(
        "unsafe_path",
        `.agentify entry cannot be a symlink: ${entry.name}`,
      );
    }
  }
}
