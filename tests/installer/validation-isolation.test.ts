import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  discoverRepositoryCommands,
  type InstallerProcessRunner,
} from "../../src/core/installer/index.ts";
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

function lockedNodeRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-validation-dependencies-test-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    scripts: { test: "fixture-test" },
    devDependencies: { "fixture-tool": "1.0.0" },
  }));
  fs.writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    packages: {},
  }));
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

test("locked dependencies are provisioned before validation in the same disposable checkout", () => {
  const cwd = lockedNodeRepository();
  try {
    const calls: Array<{ command: string; cwd: string }> = [];
    const provisioned = new Set<string>();
    const runner: InstallerProcessRunner = {
      run(request) {
        const command = `${request.program} ${request.args.join(" ")}`;
        calls.push({ command, cwd: request.cwd });
        const passed = command === "npm ci --ignore-scripts --no-audit --no-fund"
          ? (provisioned.add(request.cwd), true)
          : command === "npm run test" && provisioned.has(request.cwd);
        return {
          status: passed ? 0 : 127,
          stdout: passed ? "passed\n" : "",
          stderr: passed ? "" : "dependency unavailable\n",
          timedOut: false,
          errorMessage: null,
        };
      },
    };
    const discovered = discoverRepositoryCommands(cwd, runner, true);
    assert.deepEqual(calls.map((call) => call.command), [
      "npm ci --ignore-scripts --no-audit --no-fund",
      "npm run test",
    ]);
    assert.equal(new Set(calls.map((call) => call.cwd)).size, 1);
    assert.notEqual(calls[0]?.cwd, cwd);
    assert.equal(fs.existsSync(calls[0]!.cwd), false);
    assert.ok(discovered.commands.some((command) =>
      command.kind === "install" && command.assessment === "verified"
    ));
    assert.ok(discovered.commands.some((command) =>
      command.kind === "test" && command.assessment === "verified"
    ));
    assert.deepEqual(discovered.blockers, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("failed dependency provisioning prevents validation from running", () => {
  const cwd = lockedNodeRepository();
  try {
    const calls: string[] = [];
    const runner: InstallerProcessRunner = {
      run(request) {
        calls.push(`${request.program} ${request.args.join(" ")}`);
        return {
          status: request.args[0] === "ci" ? 1 : 0,
          stdout: "",
          stderr: request.args[0] === "ci" ? "install failed\n" : "",
          timedOut: false,
          errorMessage: null,
        };
      },
    };
    const discovered = discoverRepositoryCommands(cwd, runner, true);
    assert.deepEqual(calls, ["npm ci --ignore-scripts --no-audit --no-fund"]);
    assert.ok(discovered.commands.some((command) =>
      command.kind === "install" && command.assessment === "failed"
    ));
    assert.ok(discovered.commands.some((command) =>
      command.kind === "test" && command.assessment === "failed"
    ));
    assert.ok(discovered.blockers.some((blocker) => blocker.code === "validation_failed"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
