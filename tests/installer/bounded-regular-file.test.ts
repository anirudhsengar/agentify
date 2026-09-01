import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readBoundedRegularFile } from "../../src/core/installer/bounded-regular-file.ts";

test("bounded regular-file reads reject oversized input", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-bounded-read-"));
  try {
    const file = path.join(cwd, "policy.md");
    fs.writeFileSync(file, "12345");
    assert.equal(readBoundedRegularFile(file, 5)?.toString("utf8"), "12345");
    assert.equal(readBoundedRegularFile(file, 4), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("bounded regular-file reads never follow a final symlink", { skip: process.platform === "win32" }, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-bounded-read-link-"));
  try {
    const target = path.join(cwd, "target.md");
    const link = path.join(cwd, "policy.md");
    fs.writeFileSync(target, "Do not submit AI-authored code.\n");
    fs.symlinkSync(target, link);
    assert.equal(readBoundedRegularFile(link, 1024), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
