import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  hasCommittedGitCheckout,
  runInDisposableValidationCheckout,
} from "../../src/core/installer/validation-isolation.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-validation-isolation-test-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".venv/\n.cache/\n");
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "committed\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

test("validation uses committed evidence and cannot mutate target topology", () => {
  const cwd = repository();
  try {
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "dirty target state\n");
    fs.mkdirSync(path.join(cwd, ".venv"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".venv", "existing"), "target dependency\n");
    let checkout = "";
    const result = runInDisposableValidationCheckout({
      cwd,
      operation(checkoutCwd) {
        checkout = checkoutCwd;
        assert.equal(fs.readFileSync(path.join(checkoutCwd, "tracked.txt"), "utf-8"), "committed\n");
        assert.equal(fs.existsSync(path.join(checkoutCwd, ".venv")), false);
        assert.equal(git(checkoutCwd, "remote"), "");
        fs.mkdirSync(path.join(checkoutCwd, ".cache"), { recursive: true });
        fs.writeFileSync(path.join(checkoutCwd, ".cache", "generated"), "validation residue\n");
        return "passed";
      },
    });
    assert.deepEqual(result, { ok: true, value: "passed" });
    assert.notEqual(checkout, cwd);
    assert.equal(fs.existsSync(checkout), false);
    assert.equal(fs.readFileSync(path.join(cwd, "tracked.txt"), "utf-8"), "dirty target state\n");
    assert.equal(fs.readFileSync(path.join(cwd, ".venv", "existing"), "utf-8"), "target dependency\n");
    assert.equal(fs.existsSync(path.join(cwd, ".cache")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("post-install validation receives only explicit managed overlays", () => {
  const cwd = repository();
  try {
    const managed = path.join(cwd, ".agentify", "manifest.json");
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "{\"ready\":true}\n");
    fs.writeFileSync(path.join(cwd, "untracked-user-file"), "private working state\n");
    let checkout = "";
    const result = runInDisposableValidationCheckout({
      cwd,
      overlayPaths: [".agentify"],
      operation(checkoutCwd) {
        checkout = checkoutCwd;
        assert.equal(
          fs.readFileSync(path.join(checkoutCwd, ".agentify", "manifest.json"), "utf-8"),
          "{\"ready\":true}\n",
        );
        assert.equal(fs.existsSync(path.join(checkoutCwd, "untracked-user-file")), false);
        return true;
      },
    });
    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(fs.existsSync(checkout), false);
    assert.equal(fs.readFileSync(managed, "utf-8"), "{\"ready\":true}\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("validator exceptions fail closed and still remove the checkout", () => {
  const cwd = repository();
  try {
    let checkout = "";
    const result = runInDisposableValidationCheckout({
      cwd,
      operation(checkoutCwd) {
        checkout = checkoutCwd;
        throw new Error("validator crashed");
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /validator crashed/);
    assert.equal(fs.existsSync(checkout), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("synthetic directories are not mistaken for committed repositories", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-validation-non-git-"));
  try {
    assert.equal(hasCommittedGitCheckout(cwd), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
