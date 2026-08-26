import {
  type InitializeTeamMemoryInput,
  type MemoryStoreOptions,
  TeamMemoryError,
} from "../contracts.ts";
import {
  TEAM_MEMORY_IGNORE_RELATIVE,
  TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE,
  TEAM_MEMORY_ROOT_RELATIVE,
} from "../paths.ts";
import {
  acquireStoreLock,
  assertInitializationOwnershipAvailable,
  assertVisibleLayout,
  createInitializationJournal,
  persistVersionedEntityInternal,
  readInitializationJournalIfPresent,
  readManifestIfPresent,
  readTeamMemoryManifest,
  removeInitializationJournal,
  repositoryRoot,
  TEAM_IGNORE_CONTENT,
  visibleStateExistsWithoutManifest,
  writeInitializationJournal,
  writeManifest,
  writeTextAtomic,
} from "../persistence.ts";
import {
  validateEvidenceProvenance,
} from "../provenance.ts";
import {
  TEAM_MEMORY_MANIFEST_TYPE,
  type TeamMemoryInitializationJournal,
  type TeamMemoryManifest,
} from "../schema.ts";
import { assertNoPersistedSecrets } from "../serialization.ts";
import {
  makeIdentity,
  nowIso,
} from "../validation.ts";
import {
  recoverTeamMemoryStoreInternal,
} from "./recovery.ts";
import {
  hasRecognizedUninitializedStoreLock,
} from "./preflight.ts";
import {
  DEFAULT_IDENTITIES,
  validateWriteEvidence,
} from "./shared.ts";
import * as path from "node:path";

export function materializeTeamMemoryInitialization(
  cwd: string,
  journal: TeamMemoryInitializationJournal,
  options?: MemoryStoreOptions,
): TeamMemoryManifest {
  validateEvidenceProvenance(cwd, journal.evidence, options);
  assertVisibleLayout(cwd);
  writeTextAtomic(cwd, TEAM_MEMORY_IGNORE_RELATIVE, TEAM_IGNORE_CONTENT, options);
  for (const definition of DEFAULT_IDENTITIES) {
    const identity = makeIdentity({
      ...definition,
      supportingCommit: journal.supporting_commit,
      evidence: journal.evidence,
    }, journal.created_at);
    persistVersionedEntityInternal(
      cwd,
      identity,
      "create",
      journal.actor,
      `initialize persistent ${definition.role} identity`,
      journal.created_at,
      null,
      options,
    );
  }
  const manifest = writeManifest(cwd, {
    format: TEAM_MEMORY_MANIFEST_TYPE,
    schema_version: "1",
    revision: 1,
    root: TEAM_MEMORY_ROOT_RELATIVE,
    repository_id: journal.repository_id,
    history_mode: options?.deferInitialHistory === true ? "snapshot-v1" : "full",
    created_at: journal.created_at,
    updated_at: journal.created_at,
  }, options);
  removeInitializationJournal(cwd);
  return manifest;
}

export function initializeTeamMemoryStore(
  input: InitializeTeamMemoryInput,
): TeamMemoryManifest {
  const repositoryId = input.repositoryId.trim();
  if (!repositoryId) {
    throw new TeamMemoryError("invalid_input", "repository ID cannot be empty");
  }
  assertNoPersistedSecrets({ repository_id: repositoryId });
  const preflightManifest = readManifestIfPresent(input.cwd);
  const preflightJournal = readInitializationJournalIfPresent(input.cwd);
  if (
    preflightManifest === null
    && preflightJournal === null
    && !hasRecognizedUninitializedStoreLock(input.cwd)
  ) {
    assertInitializationOwnershipAvailable(input.cwd);
  }
  return acquireStoreLock(input.cwd, input.options, () => {
    const existing = readManifestIfPresent(input.cwd);
    if (existing) {
      if (existing.repository_id !== repositoryId) {
        throw new TeamMemoryError(
          "policy_violation",
          `team memory belongs to ${existing.repository_id}, not ${repositoryId}`,
        );
      }
      recoverTeamMemoryStoreInternal(input.cwd, input.options);
      return readTeamMemoryManifest(input.cwd);
    }

    const pending = readInitializationJournalIfPresent(input.cwd);
    if (pending) {
      if (pending.repository_id !== repositoryId) {
        throw new TeamMemoryError(
          "policy_violation",
          `pending team-memory initialization belongs to ${pending.repository_id}, not ${repositoryId}`,
        );
      }
      return materializeTeamMemoryInitialization(input.cwd, pending, input.options);
    }

    if (visibleStateExistsWithoutManifest(input.cwd)) {
      throw new TeamMemoryError(
        "corrupt_state",
        ".agentify contains visible memory files without a manifest; no files were changed",
      );
    }

    const timestamp = nowIso(input.options);
    const evidence = validateWriteEvidence(
      input.cwd,
      input.evidence,
      input.supportingCommit,
      input.options,
      "team memory bootstrap",
    );
    const journal = createInitializationJournal({
      repositoryId,
      supportingCommit: input.supportingCommit,
      evidence,
      actor: input.actor ?? "agentify-installer",
      createdAt: timestamp,
    });
    writeInitializationJournal(input.cwd, journal, input.options);
    input.options?.afterInitializationJournalWrite?.(
      path.join(repositoryRoot(input.cwd), ...TEAM_MEMORY_INITIALIZATION_JOURNAL_RELATIVE.split("/")),
    );
    return materializeTeamMemoryInitialization(input.cwd, journal, input.options);
  });
}
