import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  isLearningManagedPath,
  isKnowledgeOnlyChange,
} from "../../src/core/learning/knowledge-paths.ts";
import { verifyLearningSelfUpdateDiff } from "../../src/core/learning/self-update.ts";

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

function repository(): { cwd: string; head: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-diff-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  write(cwd, "README.md", "fixture\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return { cwd, head: git(cwd, "rev-parse", "HEAD") };
}

test("learning update allowlist excludes policy, workflow, and application paths", () => {
  assert.equal(isLearningManagedPath(".agentify/manifest.json"), true);
  assert.equal(isLearningManagedPath(".agentify/agents/specialists/billing.json"), true);
  assert.equal(isLearningManagedPath(".agentify/knowledge/episodes/task.json"), true);
  assert.equal(isLearningManagedPath(".agentify/history/memory/task/000000000001.json"), true);
  assert.equal(isLearningManagedPath(".agentify/policies/runtime.json"), false);
  assert.equal(isLearningManagedPath(".agentify/runtime/checkpoint.json"), false);
  assert.equal(isLearningManagedPath(".agentify/state-transactions/run.json"), false);
  assert.equal(isLearningManagedPath(".github/agentify/learning-runtime.mjs"), false);
  assert.equal(isLearningManagedPath("package.json"), false);
  assert.equal(isLearningManagedPath("package-lock.json"), false);
  assert.equal(isLearningManagedPath("src/index.ts"), false);
});

test("self-update verifier accepts only regular Agentify knowledge files", () => {
  const fixture = repository();
  try {
    write(
      fixture.cwd,
      ".agentify/knowledge/codebase/fact.json",
      `${JSON.stringify({ fact: true })}\n`,
    );
    const allowed = verifyLearningSelfUpdateDiff(fixture.cwd, fixture.head);
    assert.deepEqual(allowed.paths, [".agentify/knowledge/codebase/fact.json"]);

    write(
      fixture.cwd,
      ".agentify/policies/learned.json",
      `${JSON.stringify({ expanded: true })}\n`,
    );
    assert.throws(
      () => verifyLearningSelfUpdateDiff(fixture.cwd, fixture.head),
      /cannot modify \.agentify\/policies\/learned\.json/,
    );
    fs.rmSync(path.join(fixture.cwd, ".agentify", "policies"), {
      recursive: true,
      force: true,
    });

    write(fixture.cwd, "src/application.ts", "export const changed = true;\n");
    assert.throws(
      () => verifyLearningSelfUpdateDiff(fixture.cwd, fixture.head),
      /cannot modify src\/application\.ts/,
    );
    fs.rmSync(path.join(fixture.cwd, "src"), { recursive: true, force: true });

    assert.throws(
      () => verifyLearningSelfUpdateDiff(fixture.cwd, "f".repeat(40)),
      /expected HEAD/,
    );
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("self-update rejects symlinked knowledge files when the platform supports them", () => {
  const fixture = repository();
  try {
    const target = path.join(fixture.cwd, "outside.json");
    write(fixture.cwd, "outside.json", "{}\n");
    const link = path.join(fixture.cwd, ".agentify", "knowledge", "codebase", "link.json");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(target, link, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    assert.throws(
      () => verifyLearningSelfUpdateDiff(fixture.cwd, fixture.head),
      /symlink/,
    );
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("self-update validates both sides of renames and copies", () => {
  const rejected = [
    ["package.json", ".agentify/knowledge/package.json"],
    ["src/payments/refund.ts", ".agentify/knowledge/refund.json"],
    [".agentify/knowledge/fact.json", "src/fact.json"],
    [".agentify/policies/policy.json", ".agentify/knowledge/policy.json"],
  ] as const;
  for (const [source, destination] of rejected) {
    const fixture = repository();
    try {
      write(fixture.cwd, source, "protected source\n");
      git(fixture.cwd, "add", source);
      git(fixture.cwd, "commit", "-qm", "add rename source");
      const head = git(fixture.cwd, "rev-parse", "HEAD");
      fs.mkdirSync(path.dirname(path.join(fixture.cwd, destination)), { recursive: true });
      fs.renameSync(path.join(fixture.cwd, source), path.join(fixture.cwd, destination));
      git(fixture.cwd, "add", "-A");
      assert.throws(
        () => verifyLearningSelfUpdateDiff(fixture.cwd, head),
        /learning self-update cannot modify/,
        `${source} -> ${destination} must be rejected`,
      );
    } finally {
      fs.rmSync(fixture.cwd, { recursive: true, force: true });
    }
  }

  const allowed = repository();
  try {
    const source = ".agentify/knowledge/codebase/fact.json";
    const destination = ".agentify/knowledge/codebase/fact-renamed.json";
    write(allowed.cwd, source, "{}\n");
    git(allowed.cwd, "add", source);
    git(allowed.cwd, "commit", "-qm", "add knowledge fact");
    const head = git(allowed.cwd, "rev-parse", "HEAD");
    fs.renameSync(path.join(allowed.cwd, source), path.join(allowed.cwd, destination));
    git(allowed.cwd, "add", "-A");
    assert.deepEqual(
      new Set(verifyLearningSelfUpdateDiff(allowed.cwd, head).paths),
      new Set([source, destination]),
    );
  } finally {
    fs.rmSync(allowed.cwd, { recursive: true, force: true });
  }

  const copied = repository();
  try {
    write(copied.cwd, "package.json", "{}\n");
    git(copied.cwd, "add", "package.json");
    git(copied.cwd, "commit", "-qm", "add protected copy source");
    const head = git(copied.cwd, "rev-parse", "HEAD");
    write(copied.cwd, ".agentify/knowledge/package.json", "{}\n");
    git(copied.cwd, "add", ".agentify/knowledge/package.json");
    assert.throws(
      () => verifyLearningSelfUpdateDiff(copied.cwd, head),
      /cannot modify package\.json/,
    );
  } finally {
    fs.rmSync(copied.cwd, { recursive: true, force: true });
  }
});

test("knowledge-only classification validates previous and current paths", () => {
  assert.equal(isKnowledgeOnlyChange([{
    status: "renamed",
    path: ".agentify/knowledge/new.json",
    previous_path: ".agentify/knowledge/old.json",
  }]), true);
  assert.equal(isKnowledgeOnlyChange([{
    status: "renamed",
    path: ".agentify/knowledge/package.json",
    previous_path: "package.json",
  }]), false);
  assert.equal(isKnowledgeOnlyChange([{
    status: "renamed",
    path: "src/fact.json",
    previous_path: ".agentify/knowledge/fact.json",
  }]), false);
});
