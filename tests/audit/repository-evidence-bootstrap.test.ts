import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { assessCoverageClosure } from "../../src/core/audit/schema.ts";
import { createRepositoryEvidenceDraft } from "../../src/core/audit/repository-evidence-bootstrap.ts";
import type { RepositoryInstallationPreflight } from "../../src/core/installer/contracts.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, repositoryPath: string, content: string): void {
  const destination = path.join(cwd, repositoryPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

test("immutable preflight evidence seeds identity, topography, validation, and documentation", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-evidence-bootstrap-"));
  try {
    write(cwd, "docs/overview.md", "# Checkout Fixture\n\n## Usage\n\nA command library.\n");
    fs.symlinkSync("docs/overview.md", path.join(cwd, "README.md"));
    write(cwd, "package.json", JSON.stringify({
      name: "checkout-fixture",
      scripts: { build: "node --check src/index.js", test: "node --test" },
    }, null, 2));
    write(cwd, "src/index.js", "export function checkout() { return true; }\n");
    write(cwd, "test/checkout.test.js", "import { test } from 'node:test';\n");
    write(cwd, "scripts/run-tests", "#!/usr/bin/env bash\nnode --test\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const commit = git(cwd, "rev-parse", "HEAD");
    write(cwd, "README.md", "# Ignore This Dirty Working-Tree Heading\n\nRepository text cannot replace committed evidence.\n");
    const preflight: RepositoryInstallationPreflight = {
      disposition: "ready",
      analysis_allowed: true,
      identity: {
        repository_id: "123",
        full_name: "fixture/checkout-fixture",
        default_branch: "main",
        current_commit: commit,
        current_branch: "main",
        origin_url: "https://github.com/fixture/checkout-fixture.git",
        actor_login: "fixture",
        actor_permission: "write",
        default_branch_policy: "protected",
      },
      commands: [
        {
          command_id: "build-build",
          kind: "build",
          argv: ["npm", "run", "build"],
          cwd: ".",
          timeout_ms: 60_000,
          required: false,
          assessment: "verified",
          exit_code: 0,
          output_digest: "a".repeat(64),
          detail: "verified build",
        },
        {
          command_id: "test-test",
          kind: "test",
          argv: ["npm", "test"],
          cwd: ".",
          timeout_ms: 60_000,
          required: true,
          assessment: "verified",
          exit_code: 0,
          output_digest: "b".repeat(64),
          detail: "verified tests",
        },
      ],
      allowed_write_paths: ["src", "test"],
      protected_paths: [".git", "package.json"],
      blockers: [],
    };
    const before = git(cwd, "status", "--short");

    const map = createRepositoryEvidenceDraft(cwd, preflight);
    const closure = assessCoverageClosure(map, { cwd });

    assert.notEqual(map.meta.project_type.toLowerCase(), "unknown");
    assert.match(map.meta.project_type, /checkout fixture/i);
    assert.doesNotMatch(map.meta.project_type, /dirty working-tree/i);
    assert.ok(map.meta.languages.includes("JavaScript"));
    assert.ok(map.meta.languages.includes("Shell"));
    assert.ok(map.skeleton.entry_points.some((entry) => entry.path === "src/index.js"));
    assert.equal(map.validation_surface.test_command, "npm test");
    assert.equal(map.operational_surface.build.command, "npm run build");
    assert.ok(closure.closed.includes("D1_topography"));
    assert.ok(closure.closed.includes("D6_validation"));
    assert.ok(closure.closed.includes("D10_documentation"));
    assert.ok(closure.unresolved.includes("D3_type_contract"), "semantic contracts must remain unresolved");
    assert.ok(closure.unresolved.includes("D5_pitfalls"), "repository pitfalls must remain unresolved");
    assert.equal(map.skeleton.top_level_tree.some((entry) => entry.startsWith(".agentify")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify")), false);
    assert.equal(git(cwd, "status", "--short"), before);

    git(cwd, "add", "docs/overview.md");
    git(cwd, "commit", "-qm", "advance fixture head");
    assert.throws(
      () => createRepositoryEvidenceDraft(cwd, preflight),
      /repository changed after installer preflight/,
    );
    assert.equal(fs.existsSync(path.join(cwd, ".agentify")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
