import { listMemoryRecords } from "../memory/index.ts";
import { TeamMemoryError } from "../memory/contracts.ts";
import type {
  AcceptedMergeEvent,
  ReconciliationInput,
  ReconciliationReport,
} from "./contracts.ts";
import {
  LEARNING_SCHEMA_VERSION,
  MAX_RECONCILIATION_COMMITS,
} from "./contracts.ts";
import {
  listRecentFirstParentCommits,
  readCommitMetadata,
  readFirstParent,
  readLearningInstallationCommit,
  readLearningHead,
} from "./git.ts";
import { processAcceptedMerge } from "./engine.ts";

function boundedCommitCount(value: number | undefined): number {
  const resolved = value ?? 20;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_RECONCILIATION_COMMITS) {
    throw new TeamMemoryError(
      "invalid_input",
      `reconciliation max_commits must be between 1 and ${MAX_RECONCILIATION_COMMITS}`,
    );
  }
  return resolved;
}

function isCompleted(cwd: string, commit: string): boolean {
  return listMemoryRecords(cwd, {
    kind: "orchestrator",
    tag: `learning-run-${commit}`,
  }).length > 0;
}

export function reconcileAcceptedMerges(
  input: ReconciliationInput,
): ReconciliationReport {
  const maximum = boundedCommitCount(input.max_commits);
  const head = readLearningHead(input.cwd);
  const installationCommit = readLearningInstallationCommit(input.cwd);
  const recent = listRecentFirstParentCommits(input.cwd, maximum);
  const installationIndex = recent.indexOf(installationCommit);
  const available = installationIndex < 0
    ? recent
    : recent.slice(installationIndex);
  const considered: string[] = [];
  const processed: ReconciliationReport["processed"] = [];
  const skipped: string[] = [];

  for (const commit of available) {
    considered.push(commit);
    if (isCompleted(input.cwd, commit)) {
      skipped.push(commit);
      continue;
    }
    let firstParent: string;
    try {
      firstParent = readFirstParent(input.cwd, commit);
    } catch (error) {
      if (error instanceof TeamMemoryError && error.code === "invalid_input") {
        skipped.push(commit);
        continue;
      }
      throw error;
    }
    const metadata = readCommitMetadata(input.cwd, commit);
    const event: AcceptedMergeEvent = {
      schema_version: LEARNING_SCHEMA_VERSION,
      repository_id: input.repository_id,
      default_branch: input.default_branch,
      accepted_commit: commit,
      first_parent_commit: firstParent,
      expected_repository_head: head,
      pull_request_number: null,
      issue_number: null,
      pull_request_url: null,
      actor: metadata.actor,
      author_kind: "unknown",
      accepted_at: metadata.accepted_at,
    };
    const report = processAcceptedMerge({
      cwd: input.cwd,
      event,
      options: input.options,
    });
    if (report.status === "knowledge-only") {
      skipped.push(commit);
    } else {
      processed.push(report);
      if (processed.length >= maximum) break;
    }
  }

  return {
    considered_commits: considered,
    processed,
    skipped_commits: skipped.sort((left, right) => left.localeCompare(right)),
  };
}
