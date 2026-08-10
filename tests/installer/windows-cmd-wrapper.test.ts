import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_INSTALLER_PROCESS_RUNNER } from "../../src/core/installer/process-runner.ts";
import { resolveValidationInvocation } from "../../src/core/task-lifecycle/validation-runner.ts";

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
