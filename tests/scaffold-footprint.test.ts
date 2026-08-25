import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { installScaffoldRuntime } from "../src/core/scaffold-installer.ts";
import { packageRoot } from "../src/core/pi-sdk-runtime.ts";

function lineCount(value: string): number {
  return value.split(/\r?\n/).length;
}

test("installed GitHub runtime is a compact pinned shim, not bundled dependency source", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-compact-runtime-"));
  try {
    installScaffoldRuntime({ cwd, packageRoot: packageRoot() });
    const runtimeDir = path.join(cwd, ".github", "agentify");
    const files = ["runtime-loader.mjs", "task-runtime.mjs", "learning-runtime.mjs"];
    let totalBytes = 0;
    let totalLines = 0;
    for (const file of files) {
      const absolute = path.join(runtimeDir, file);
      assert.ok(fs.existsSync(absolute), `${file} must be installed`);
      const content = fs.readFileSync(absolute, "utf8");
      totalBytes += Buffer.byteLength(content);
      totalLines += lineCount(content);
      execFileSync(process.execPath, ["--check", absolute], { stdio: "pipe" });
    }
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
    const loader = fs.readFileSync(path.join(runtimeDir, "runtime-loader.mjs"), "utf8");
    assert.match(loader, new RegExp(`PACKAGE_VERSION = ["']${packageJson.version.replaceAll(".", "\\.")}["']`));
    assert.doesNotMatch(loader, /__AGENTIFY_RUNTIME_VERSION__/);
    assert.ok(totalLines < 220, `installed runtime must stay compact; got ${totalLines} lines`);
    assert.ok(totalBytes < 16_000, `installed runtime must stay compact; got ${totalBytes} bytes`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
