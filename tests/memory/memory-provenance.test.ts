import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  TeamMemoryError,
  initializeTeamMemoryStore,
  persistMemoryCandidate,
  type EvidenceReference,
} from "../../src/core/memory/index.ts";
import { codebaseCandidate } from "./helpers.ts";

interface GitFixture {
  cwd: string;
  commit: string;
  content: string;
  digest: string;
}

function hasCode(error: unknown, code: TeamMemoryError["code"]): boolean {
  return error instanceof TeamMemoryError && error.code === code;
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    env,
    encoding: "utf-8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function commitEnvironment(timestamp: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Agentify Tests",
    GIT_AUTHOR_EMAIL: "agentify@example.invalid",
    GIT_COMMITTER_NAME: "Agentify Tests",
    GIT_COMMITTER_EMAIL: "agentify@example.invalid",
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  };
}

function createGitFixture(prefix: string): GitFixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(cwd, ["init", "--quiet"]);
  runGit(cwd, ["config", "user.name", "Agentify Tests"]);
  runGit(cwd, ["config", "user.email", "agentify@example.invalid"]);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  const content = "export const bootstrap = true;\nexport const version = 1;\n";
  fs.writeFileSync(path.join(cwd, "src", "bootstrap.ts"), content);
  runGit(cwd, ["add", "src/bootstrap.ts"]);
  runGit(
    cwd,
    ["commit", "--quiet", "--message", "seed provenance fixture"],
    commitEnvironment("2026-07-30T00:00:00Z"),
  );
  const commit = runGit(cwd, ["rev-parse", "HEAD"]);
  return {
    cwd,
    commit,
    content,
    digest: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

function trackedEvidence(
  fixture: GitFixture,
  overrides: Partial<EvidenceReference> = {},
): EvidenceReference {
  return {
    evidence_id: "bootstrap-evidence",
    source_type: "validated_bootstrap",
    repository_path: "src/bootstrap.ts",
    commit_sha: fixture.commit,
    sha256: fixture.digest,
    line_start: 1,
    line_end: 2,
    external_ref: null,
    description: "Tracked bootstrap evidence",
    observed_at: "2026-07-30T00:00:00.000Z",
    actor: "agentify-installer",
    ...overrides,
  };
}

function initializeWithTrackedEvidence(
  fixture: GitFixture,
  evidence = trackedEvidence(fixture),
): void {
  initializeTeamMemoryStore({
    cwd: fixture.cwd,
    repositoryId: "owner/repo",
    supportingCommit: evidence.commit_sha,
    evidence: [evidence],
    options: { now: () => new Date("2026-07-30T00:00:00.000Z") },
  });
}

test("production provenance accepts a reachable commit and exact tracked bytes", () => {
  const fixture = createGitFixture("agentify-memory-provenance-valid-");
  try {
    initializeWithTrackedEvidence(fixture);
    assert.ok(fs.existsSync(path.join(fixture.cwd, ".agentify", "manifest.json")));
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("production provenance rejects mismatched bytes, unknown commits, invalid lines, and absent paths", () => {
  const cases: ReadonlyArray<{
    name: string;
    mutate: (fixture: GitFixture) => EvidenceReference;
    pattern: RegExp;
  }> = [
    {
      name: "digest",
      mutate: (fixture) => trackedEvidence(fixture, { sha256: "0".repeat(64) }),
      pattern: /digest does not match/,
    },
    {
      name: "commit",
      mutate: (fixture) => trackedEvidence(fixture, { commit_sha: "f".repeat(40) }),
      pattern: /unknown commit/,
    },
    {
      name: "line-range",
      mutate: (fixture) => trackedEvidence(fixture, { line_end: 99 }),
      pattern: /line range/,
    },
    {
      name: "path",
      mutate: (fixture) => trackedEvidence(fixture, { repository_path: "missing.ts" }),
      pattern: /tracked file/,
    },
  ];

  for (const testCase of cases) {
    const fixture = createGitFixture(`agentify-memory-provenance-${testCase.name}-`);
    try {
      assert.throws(
        () => initializeWithTrackedEvidence(fixture, testCase.mutate(fixture)),
        (error) => hasCode(error, "invalid_input")
          && testCase.pattern.test((error as Error).message),
      );
      assert.equal(
        fs.existsSync(path.join(fixture.cwd, ".agentify", "manifest.json")),
        false,
      );
      assert.equal(
        fs.existsSync(path.join(fixture.cwd, ".agentify")),
        false,
        "failed initialization must not leave an empty operational root",
      );
    } finally {
      fs.rmSync(fixture.cwd, { recursive: true, force: true });
    }
  }
});

test("repository evidence cannot use a tracked symlink", { skip: process.platform === "win32" }, () => {
  const fixture = createGitFixture("agentify-memory-provenance-symlink-");
  try {
    initializeWithTrackedEvidence(fixture);
    fs.writeFileSync(path.join(fixture.cwd, "evidence-target.txt"), "target\n");
    fs.symlinkSync("evidence-target.txt", path.join(fixture.cwd, "evidence-link"));
    runGit(fixture.cwd, ["add", "evidence-target.txt", "evidence-link"]);
    runGit(
      fixture.cwd,
      ["commit", "--quiet", "--message", "add symlink evidence"],
      commitEnvironment("2026-07-30T00:02:00Z"),
    );
    const commit = runGit(fixture.cwd, ["rev-parse", "HEAD"]);
    const symlinkDigest = crypto.createHash("sha256").update("evidence-target.txt").digest("hex");
    const candidate = codebaseCandidate("symlink-candidate", "symlink-memory", commit);

    assert.throws(
      () => persistMemoryCandidate(fixture.cwd, {
        ...candidate,
        source_type: "merged_code",
        evidence: [{
          ...candidate.evidence[0]!,
          source_type: "merged_code",
          repository_path: "evidence-link",
          commit_sha: commit,
          sha256: symlinkDigest,
          line_start: null,
          line_end: null,
        }],
      }),
      (error) => hasCode(error, "unsafe_path")
        && /symlink/.test((error as Error).message),
    );
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});
