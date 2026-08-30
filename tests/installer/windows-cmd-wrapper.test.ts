import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_INSTALLER_PROCESS_RUNNER } from "../../src/core/installer/process-runner.ts";
import { resolveValidationInvocation } from "../../src/core/task-lifecycle/validation-runner.ts";

test("Windows npm stays a direct Node invocation, separate from batch wrappers", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-command & boundary-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
  const node = path.join(cwd, "node.exe");
  const npmCli = path.join(cwd, "node_modules", "npm", "bin", "npm-cli.js");
  const calls: unknown[][] = [];
  const spawn = t.mock.method(childProcess, "spawnSync", (...args: unknown[]) => {
    calls.push(args);
    return { status: 0, stdout: "ok", stderr: "" };
  });
  try {
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(npmCli, "");
    fs.writeFileSync(path.join(cwd, "probe.bat"), "@echo off\r\n");
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "execPath", { value: node });
    syncBuiltinESMExports();
    for (const program of ["npm", "probe.bat", "git"]) {
      assert.equal(DEFAULT_INSTALLER_PROCESS_RUNNER.run({
        program, args: ["test"], cwd, timeoutMs: 10_000,
      }).status, 0);
    }
    assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
      [node, [npmCli, "test"]],
      ["cmd.exe", ["/d", "/s", "/c", path.join(cwd, "probe.bat"), "test"]],
      ["git", ["test"]],
    ]);
    for (const call of calls) {
      assert.equal((call[2] as { shell: boolean }).shell, false);
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "execPath", execPath);
    spawn.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("installer process runner executes Windows .bat wrappers via cmd.exe", () => {
  if (process.platform !== "win32") return;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-bat-runner-"));
  try {
    const script = path.join(cwd, "probe.bat");
    fs.writeFileSync(script, "@echo off\r\necho bat-ok\r\n");
    const result = DEFAULT_INSTALLER_PROCESS_RUNNER.run({
      program: "probe.bat",
      args: [],
      cwd,
      timeoutMs: 10_000,
    });
    assert.equal(result.status, 0, result.errorMessage ?? result.stderr);
    assert.match(result.stdout, /bat-ok/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("installer process runner rejects .bat scripts outside the repository cwd", () => {
  if (process.platform !== "win32") return;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-bat-confine-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-bat-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "escape.bat"), "@echo off\r\necho escaped\r\n");
    assert.throws(
      () => DEFAULT_INSTALLER_PROCESS_RUNNER.run({
        program: path.join(outside, "escape.bat"),
        args: [],
        cwd,
        timeoutMs: 10_000,
      }),
      /inside the repository cwd/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("validation invocation resolves Windows .bat wrappers through cmd.exe", () => {
  if (process.platform !== "win32") return;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-bat-validation-"));
  try {
    fs.writeFileSync(path.join(cwd, "gradlew.bat"), "@echo off\r\necho gradle-ok\r\n");
    const invocation = resolveValidationInvocation(["gradlew.bat", "test"], cwd);
    assert.match(invocation.command.toLowerCase(), /cmd\.exe$/);
    assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(invocation.args[3], path.join(cwd, "gradlew.bat"));
    assert.deepEqual(invocation.args.slice(4), ["test"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
