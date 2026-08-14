import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { adoptLearningProposal } from "../../src/core/learning/proposal.ts";
import { reconcileAcceptedMerges } from "../../src/core/learning/reconciliation.ts";
import { verifyLearningSelfUpdateDiff } from "../../src/core/learning/self-update.ts";
import {
  initializeTeamMemoryStore,
  listMemoryRecords,
} from "../../src/core/memory/index.ts";
import {
  buildSpecialistEvidenceReference,
  readGitCommitTimestamp,
} from "../../src/core/specialists/index.ts";
import { installSelfUpdatePolicy } from "./installation-fixture.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, relativePath: string, content: string): void {
  const destination = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function cloneRepository(root: string, origin: string, destination: string): void {
  git(root, "clone", "-q", "--no-checkout", origin, destination);
  git(destination, "config", "core.autocrlf", "false");
  git(destination, "checkout", "-q", "main");
}

function fixture(): {
  cwd: string;
  applicationCommit: string;
  proposalCommit: string;
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-proposal-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "config", "core.autocrlf", "false");
  write(cwd, "package.json", "{}\n");
  write(cwd, "src/index.ts", "export const value = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  const initial = git(cwd, "rev-parse", "HEAD");
  const observedAt = readGitCommitTimestamp(cwd, initial);
  const evidence = buildSpecialistEvidenceReference({
    cwd,
    supportingCommit: initial,
    repositoryPath: "package.json",
    sourceType: "validated_bootstrap",
    observedAt,
    actor: "test-installer",
  });
  initializeTeamMemoryStore({
    cwd,
    repositoryId: "fixture/proposal",
    supportingCommit: initial,
    evidence: [evidence],
    actor: "agentify-installer",
    options: { now: () => new Date(observedAt) },
  });
  installSelfUpdatePolicy({ cwd, supportingCommit: initial, observedAt });
  git(cwd, "add", ".agentify");
  git(cwd, "commit", "-qm", "install Agentify");
  write(cwd, "src/index.ts", "export const value = 2;\n");
  git(cwd, "add", "src/index.ts");
  git(cwd, "commit", "-qm", "accepted application change");
  const applicationCommit = git(cwd, "rev-parse", "HEAD");
  reconcileAcceptedMerges({
    cwd,
    repository_id: "fixture/proposal",
    default_branch: "main",
    max_commits: 4,
  });
  const verified = verifyLearningSelfUpdateDiff(cwd, applicationCommit);
  for (const relativePath of verified.paths) git(cwd, "add", "--", relativePath);
  git(
    cwd,
    "commit",
    "-qm",
    "chore(agentify): refresh repository knowledge\n\n"
      + "Agentify-Proposal-Version: 1\n"
      + "Agentify-Proposal-Repository: fixture/proposal\n"
      + `Agentify-Proposal-Base: ${applicationCommit}`,
  );
  return {
    cwd,
    applicationCommit,
    proposalCommit: git(cwd, "rev-parse", "HEAD"),
  };
}

test("a fresh checkout securely resumes a valid learning proposal", () => {
  const repository = fixture();
  try {
    git(repository.cwd, "switch", "--detach", "--quiet", repository.applicationCommit);
    const adopted = adoptLearningProposal({
      cwd: repository.cwd,
      repository_id: "fixture/proposal",
      proposal_commit: repository.proposalCommit,
      expected_head: repository.applicationCommit,
    });
    assert.equal(adopted.proposal_parent, repository.applicationCommit);
    assert.ok(adopted.paths.length > 0);
    assert.ok(adopted.metrics.path_count > 0);
    assert.equal(
      listMemoryRecords(repository.cwd, {
        tag: `learning-run-${repository.applicationCommit}`,
      }).length,
      1,
    );
    const repeated = reconcileAcceptedMerges({
      cwd: repository.cwd,
      repository_id: "fixture/proposal",
      default_branch: "main",
      max_commits: 4,
    });
    assert.deepEqual(repeated.processed, []);
  } finally {
    fs.rmSync(repository.cwd, { recursive: true, force: true });
  }
});

test("proposal adoption rejects application changes and mismatched provenance", () => {
  const repository = fixture();
  try {
    git(repository.cwd, "switch", "--detach", "--quiet", repository.applicationCommit);
    git(repository.cwd, "switch", "-c", "malicious", "--quiet");
    write(repository.cwd, "src/unauthorized.ts", "export const unauthorized = true;\n");
    git(repository.cwd, "add", "src/unauthorized.ts");
    git(
      repository.cwd,
      "commit",
      "-qm",
      "malicious proposal\n\n"
        + "Agentify-Proposal-Version: 1\n"
        + "Agentify-Proposal-Repository: fixture/proposal\n"
        + `Agentify-Proposal-Base: ${repository.applicationCommit}`,
    );
    const malicious = git(repository.cwd, "rev-parse", "HEAD");
    git(repository.cwd, "switch", "--detach", "--quiet", repository.applicationCommit);
    assert.throws(
      () => adoptLearningProposal({
        cwd: repository.cwd,
        repository_id: "fixture/proposal",
        proposal_commit: malicious,
        expected_head: repository.applicationCommit,
      }),
      /cannot modify src\/unauthorized\.ts/,
    );
    assert.equal(git(repository.cwd, "status", "--porcelain"), "");
    assert.throws(
      () => adoptLearningProposal({
        cwd: repository.cwd,
        repository_id: "fixture/other",
        proposal_commit: repository.proposalCommit,
        expected_head: repository.applicationCommit,
      }),
      /default-branch memory belongs to fixture\/proposal, not fixture\/other/,
    );

    git(repository.cwd, "switch", "-c", "manifest-spoof", "--quiet");
    const manifestPath = path.join(repository.cwd, ".agentify", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    manifest.repository_id = "fixture/other";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    git(repository.cwd, "add", ".agentify/manifest.json");
    git(
      repository.cwd,
      "commit",
      "-qm",
      "spoofed manifest proposal\n\n"
        + "Agentify-Proposal-Version: 1\n"
        + "Agentify-Proposal-Repository: fixture/proposal\n"
        + `Agentify-Proposal-Base: ${repository.applicationCommit}`,
    );
    const spoofedManifest = git(repository.cwd, "rev-parse", "HEAD");
    git(repository.cwd, "switch", "--detach", "--quiet", repository.applicationCommit);
    assert.throws(
      () => adoptLearningProposal({
        cwd: repository.cwd,
        repository_id: "fixture/proposal",
        proposal_commit: spoofedManifest,
        expected_head: repository.applicationCommit,
      }),
      /immutable manifest identity field repository_id/,
    );
  } finally {
    fs.rmSync(repository.cwd, { recursive: true, force: true });
  }
});

test("fresh clones resume bounded backlog proposals without repeating completed commits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-clones-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const firstClone = path.join(root, "clone-1");
  const secondClone = path.join(root, "clone-2");
  const thirdClone = path.join(root, "clone-3");
  try {
    fs.mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    git(seed, "config", "user.name", "Agentify Test");
    git(seed, "config", "user.email", "agentify@example.invalid");
    git(seed, "config", "core.autocrlf", "false");
    write(seed, "package.json", "{}\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "fixture");
    const initial = git(seed, "rev-parse", "HEAD");
    const observedAt = readGitCommitTimestamp(seed, initial);
    const evidence = buildSpecialistEvidenceReference({
      cwd: seed,
      supportingCommit: initial,
      repositoryPath: "package.json",
      sourceType: "validated_bootstrap",
      observedAt,
      actor: "test-installer",
    });
    initializeTeamMemoryStore({
      cwd: seed,
      repositoryId: "fixture/multi-clone",
      supportingCommit: initial,
      evidence: [evidence],
      actor: "agentify-installer",
      options: { now: () => new Date(observedAt) },
    });
    installSelfUpdatePolicy({ cwd: seed, supportingCommit: initial, observedAt });
    git(seed, "add", ".agentify");
    git(seed, "commit", "-qm", "install Agentify");
    const applicationCommits: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      write(seed, `src/change-${index}.ts`, `export const change${index} = true;\n`);
      git(seed, "add", `src/change-${index}.ts`);
      git(seed, "commit", "-qm", `accepted change ${index}`);
      applicationCommits.push(git(seed, "rev-parse", "HEAD"));
    }
    git(root, "init", "--bare", "-q", origin);
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "-u", "origin", "main");
    git(origin, "symbolic-ref", "HEAD", "refs/heads/main");

    cloneRepository(root, origin, firstClone);
    git(firstClone, "config", "user.name", "Agentify Test");
    git(firstClone, "config", "user.email", "agentify@example.invalid");
    const first = reconcileAcceptedMerges({
      cwd: firstClone,
      repository_id: "fixture/multi-clone",
      default_branch: "main",
      max_commits: 4,
    });
    assert.deepEqual(
      first.processed.map((entry) => entry.accepted_commit),
      applicationCommits.slice(0, 4),
    );
    const firstVerified = verifyLearningSelfUpdateDiff(
      firstClone,
      git(firstClone, "rev-parse", "HEAD"),
    );
    for (const relativePath of firstVerified.paths) git(firstClone, "add", "--", relativePath);
    const defaultHead = git(firstClone, "rev-parse", "HEAD");
    git(
      firstClone,
      "commit",
      "-qm",
      "first bounded proposal\n\n"
        + "Agentify-Proposal-Version: 1\n"
        + "Agentify-Proposal-Repository: fixture/multi-clone\n"
        + `Agentify-Proposal-Base: ${defaultHead}`,
    );
    const firstProposal = git(firstClone, "rev-parse", "HEAD");
    git(firstClone, "push", "-q", "origin", "HEAD:refs/heads/agentify/knowledge-maintenance");

    cloneRepository(root, origin, secondClone);
    git(secondClone, "config", "user.name", "Agentify Test");
    git(secondClone, "config", "user.email", "agentify@example.invalid");
    adoptLearningProposal({
      cwd: secondClone,
      repository_id: "fixture/multi-clone",
      proposal_commit: firstProposal,
      expected_head: defaultHead,
    });
    const second = reconcileAcceptedMerges({
      cwd: secondClone,
      repository_id: "fixture/multi-clone",
      default_branch: "main",
      max_commits: 4,
    });
    assert.deepEqual(
      second.processed.map((entry) => entry.accepted_commit),
      applicationCommits.slice(4),
    );
    const secondVerified = verifyLearningSelfUpdateDiff(secondClone, defaultHead);
    for (const relativePath of secondVerified.paths) git(secondClone, "add", "--", relativePath);
    git(
      secondClone,
      "commit",
      "-qm",
      "completed bounded proposal\n\n"
        + "Agentify-Proposal-Version: 1\n"
        + "Agentify-Proposal-Repository: fixture/multi-clone\n"
        + `Agentify-Proposal-Base: ${defaultHead}`,
    );
    const secondProposal = git(secondClone, "rev-parse", "HEAD");
    git(
      secondClone,
      "push",
      "-q",
      "--force-with-lease=refs/heads/agentify/knowledge-maintenance:" + firstProposal,
      "origin",
      "HEAD:refs/heads/agentify/knowledge-maintenance",
    );

    cloneRepository(root, origin, thirdClone);
    git(thirdClone, "config", "user.name", "Agentify Test");
    git(thirdClone, "config", "user.email", "agentify@example.invalid");
    adoptLearningProposal({
      cwd: thirdClone,
      repository_id: "fixture/multi-clone",
      proposal_commit: secondProposal,
      expected_head: defaultHead,
    });
    const repeated = reconcileAcceptedMerges({
      cwd: thirdClone,
      repository_id: "fixture/multi-clone",
      default_branch: "main",
      max_commits: 4,
    });
    assert.deepEqual(repeated.processed, []);
    const repeatedVerified = verifyLearningSelfUpdateDiff(thirdClone, defaultHead);
    for (const relativePath of repeatedVerified.paths) git(thirdClone, "add", "--", relativePath);
    assert.equal(
      git(thirdClone, "write-tree"),
      git(thirdClone, "rev-parse", `${secondProposal}^{tree}`),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
