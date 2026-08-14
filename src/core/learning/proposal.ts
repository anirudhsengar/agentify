import { spawnSync } from "node:child_process";
import {
  recoverTeamMemoryStore,
  readTeamMemoryManifest,
} from "../memory/index.ts";
import { scanVisibleEntries } from "../memory/persistence.ts";
import { canonicalJson } from "../memory/serialization.ts";
import { TeamMemoryError } from "../memory/contracts.ts";
import {
  learningRepositoryRoot,
  readLearningHead,
  resolveLearningCommit,
} from "./git.ts";
import {
  verifyCommittedLearningDiff,
  verifyLearningSelfUpdateDiff,
  type LearningPublicationMetrics,
} from "./self-update.ts";

export const LEARNING_PROPOSAL_VERSION = "1" as const;

const PROPOSAL_TRAILERS = {
  version: "Agentify-Proposal-Version",
  repository: "Agentify-Proposal-Repository",
  base: "Agentify-Proposal-Base",
} as const;

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new TeamMemoryError(
      "persistence_failed",
      `cannot execute git while resuming learning proposal: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim().replace(/\s+/g, " ").slice(0, 240);
    throw new TeamMemoryError(
      "invalid_input",
      `cannot resume learning proposal: ${detail || `git exited ${result.status ?? "unknown"}`}`,
    );
  }
  return result.stdout.trim();
}

function proposalParent(cwd: string, proposalCommit: string): string {
  const fields = runGit(cwd, ["rev-list", "--parents", "-n", "1", proposalCommit])
    .split(/\s+/)
    .filter(Boolean);
  if (fields.length !== 2 || fields[0] !== proposalCommit) {
    throw new TeamMemoryError(
      "policy_violation",
      "learning proposal must contain exactly one commit with exactly one parent",
    );
  }
  return resolveLearningCommit(cwd, fields[1]!);
}

function trailer(message: string, key: string): string {
  const prefix = `${key}:`;
  const values = message.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
  if (values.length !== 1 || !values[0]) {
    throw new TeamMemoryError(
      "policy_violation",
      `learning proposal requires exactly one ${key} trailer`,
    );
  }
  return values[0];
}

function assertFirstParentAncestor(cwd: string, ancestor: string, descendant: string): void {
  const ancestry = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], {
    encoding: "utf-8",
    windowsHide: true,
  });
  if (ancestry.error || ancestry.status !== 0) {
    throw new TeamMemoryError(
      "revision_conflict",
      `learning proposal base ${ancestor} is not an ancestor of ${descendant}`,
    );
  }
  const distanceValue = runGit(cwd, [
    "rev-list",
    "--first-parent",
    "--count",
    `${ancestor}..${descendant}`,
  ]);
  const distance = Number(distanceValue);
  if (!Number.isSafeInteger(distance) || distance < 0) {
    throw new TeamMemoryError("invalid_input", "git returned an invalid proposal base distance");
  }
  const firstParentAtDistance = resolveLearningCommit(cwd, `${descendant}~${distance}`);
  if (firstParentAtDistance !== ancestor) {
    throw new TeamMemoryError(
      "revision_conflict",
      `learning proposal base ${ancestor} is outside the default branch first-parent history`,
    );
  }
}

export interface LearningProposalAdoption {
  schema_version: typeof LEARNING_PROPOSAL_VERSION;
  repository_id: string;
  proposal_commit: string;
  proposal_parent: string;
  expected_head: string;
  paths: string[];
  metrics: LearningPublicationMetrics;
}

export function adoptLearningProposal(input: {
  cwd: string;
  repository_id: string;
  proposal_commit: string;
  expected_head: string;
}): LearningProposalAdoption {
  const cwd = learningRepositoryRoot(input.cwd);
  const expectedHead = resolveLearningCommit(cwd, input.expected_head);
  if (readLearningHead(cwd) !== expectedHead) {
    throw new TeamMemoryError(
      "revision_conflict",
      `learning proposal expected HEAD ${expectedHead}, found ${readLearningHead(cwd)}`,
    );
  }
  if (runGit(cwd, ["status", "--porcelain"]) !== "") {
    throw new TeamMemoryError(
      "revision_conflict",
      "learning proposal adoption requires a clean default-branch checkout",
    );
  }
  const baseManifest = readTeamMemoryManifest(cwd);
  if (baseManifest.repository_id !== input.repository_id) {
    throw new TeamMemoryError(
      "policy_violation",
      `default-branch memory belongs to ${baseManifest.repository_id}, not ${input.repository_id}`,
    );
  }
  const proposalCommit = resolveLearningCommit(cwd, input.proposal_commit);
  const parent = proposalParent(cwd, proposalCommit);
  assertFirstParentAncestor(cwd, parent, expectedHead);
  const message = runGit(cwd, ["show", "-s", "--format=%B", proposalCommit]);
  if (trailer(message, PROPOSAL_TRAILERS.version) !== LEARNING_PROPOSAL_VERSION) {
    throw new TeamMemoryError("policy_violation", "learning proposal version is unsupported");
  }
  if (trailer(message, PROPOSAL_TRAILERS.repository) !== input.repository_id) {
    throw new TeamMemoryError("policy_violation", "learning proposal repository trailer does not match");
  }
  if (trailer(message, PROPOSAL_TRAILERS.base) !== parent) {
    throw new TeamMemoryError("policy_violation", "learning proposal base trailer does not match its parent");
  }
  const committed = verifyCommittedLearningDiff(cwd, parent, proposalCommit);
  runGit(cwd, [
    "-c",
    "core.hooksPath=.git/agentify-disabled-hooks",
    "cherry-pick",
    "--no-commit",
    proposalCommit,
  ]);
  const adopted = verifyLearningSelfUpdateDiff(cwd, expectedHead);
  const manifest = readTeamMemoryManifest(cwd);
  const immutableManifestIdentity = [
    "format",
    "schema_version",
    "root",
    "repository_id",
    "created_at",
  ] as const;
  for (const field of immutableManifestIdentity) {
    if (manifest[field] !== baseManifest[field]) {
      throw new TeamMemoryError(
        "policy_violation",
        `learning proposal changed immutable manifest identity field ${field}`,
      );
    }
  }
  const visibleEntries = scanVisibleEntries(cwd);
  if (canonicalJson(manifest.entries) !== canonicalJson(visibleEntries)) {
    const manifestPaths = new Set(manifest.entries.map((entry) => entry.path));
    const visiblePaths = new Set(visibleEntries.map((entry) => entry.path));
    const mismatch = [...new Set([
      ...manifest.entries
        .filter((entry) => !visiblePaths.has(entry.path))
        .map((entry) => `missing:${entry.path}`),
      ...visibleEntries
        .filter((entry) => !manifestPaths.has(entry.path))
        .map((entry) => `extra:${entry.path}`),
      ...visibleEntries
        .filter((entry) => {
          const recorded = manifest.entries.find((candidate) => candidate.path === entry.path);
          return recorded !== undefined && canonicalJson(recorded) !== canonicalJson(entry);
        })
        .map((entry) => `changed:${entry.path}`),
    ])].join(", ");
    throw new TeamMemoryError(
      "corrupt_state",
      `learning proposal manifest does not match its files${mismatch ? `: ${mismatch}` : ""}`,
    );
  }
  const recovery = recoverTeamMemoryStore(cwd);
  if (recovery.status !== "valid") {
    throw new TeamMemoryError(
      "corrupt_state",
      `learning proposal required memory repair and cannot be resumed automatically: ${recovery.repaired.join(", ")}`,
    );
  }
  verifyLearningSelfUpdateDiff(cwd, expectedHead);
  return {
    schema_version: LEARNING_PROPOSAL_VERSION,
    repository_id: input.repository_id,
    proposal_commit: proposalCommit,
    proposal_parent: parent,
    expected_head: expectedHead,
    paths: adopted.paths,
    metrics: committed.metrics,
  };
}
