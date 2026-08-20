import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  canonicalizePackedArchive,
  canonicalPackageMode,
  isPackageTextPath,
  validateInventory,
  validatePackageFileBytes,
} from "../../scripts/pack-release.mjs";

const executablePaths = [
  "bin/agentify.js",
  "dist/learning-runtime.mjs",
  "dist/task-runtime.mjs",
  "scaffold/.github/agentify/validation-smoke.mjs",
  "scaffold/.github/scripts/complete-accepted-task-merge.mjs",
  "scaffold/.github/scripts/publish-task-draft.mjs",
  "scaffold/.github/scripts/run-task-lifecycle.mjs",
  "scaffold/.github/scripts/task-state-github.mjs",
];

function writeOctal(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function testArchive(files, executableMode) {
  const blocks = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    header.write(`package/${file.path}`, 0, 100, "utf8");
    writeOctal(header, 100, 8, executablePaths.includes(file.path) ? executableMode : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, file.bytes.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, file.bytes, Buffer.alloc(Math.ceil(file.bytes.length / 512) * 512 - file.bytes.length));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
}

assert.equal(isPackageTextPath("dist/cli.js"), true);
assert.equal(isPackageTextPath("scaffold/policy.json"), true);
assert.equal(isPackageTextPath("LICENSE"), true);
assert.equal(isPackageTextPath("assets/logo.png"), false);
assert.equal(canonicalPackageMode("bin/agentify.js"), 0o755);
assert.equal(canonicalPackageMode("README.md"), 0o644);

assert.doesNotThrow(() => validatePackageFileBytes("README.md", Buffer.from("one\ntwo\n")));
assert.throws(() => validatePackageFileBytes("README.md", Buffer.from("one\r\ntwo\r\n")), /canonical LF/);
assert.throws(() => validatePackageFileBytes("README.md", Buffer.from("one\rtwo\n")), /canonical LF/);

const binary = Buffer.from([0x00, 0x0d, 0xff, 0x0a]);
const before = Buffer.from(binary);
assert.doesNotThrow(() => validatePackageFileBytes("assets/logo.png", binary));
assert.deepEqual(binary, before, "binary package bytes must not be normalized");

const archiveFiles = [
  ...executablePaths.map((filePath) => ({ path: filePath, bytes: Buffer.from("#!/usr/bin/env node\n") })),
  { path: "README.md", bytes: Buffer.from("canonical\n") },
  { path: "assets/logo.png", bytes: binary },
];
const archiveInventory = archiveFiles.map((file) => ({ path: file.path }));
const canonicalFromWindowsModes = canonicalizePackedArchive(testArchive(archiveFiles, 0o644), archiveInventory);
const canonicalFromLinuxModes = canonicalizePackedArchive(testArchive(archiveFiles, 0o755), archiveInventory);
assert.deepEqual(canonicalFromWindowsModes, canonicalFromLinuxModes, "tar modes must canonicalize across operating systems");
assert.equal(canonicalFromWindowsModes[9], 0xff, "gzip OS metadata must be canonical");
assert.ok(gunzipSync(canonicalFromWindowsModes).includes(binary), "binary payload bytes must survive tar metadata canonicalization");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-pack-release-test-"));
try {
  fs.mkdirSync(path.join(scratch, "docs"));
  fs.writeFileSync(path.join(scratch, "docs", "README.md"), "canonical\n");
  fs.writeFileSync(path.join(scratch, "image.png"), binary);
  const inventory = validateInventory({
    root: scratch,
    entries: [
      { path: "docs/README.md", size: 10, mode: 0o644 },
      { path: "image.png", size: binary.length, mode: 0o644 },
    ],
  });
  assert.equal(inventory.length, 2);
  assert.equal(inventory[0].text, true);
  assert.equal(inventory[1].text, false);

  fs.writeFileSync(path.join(scratch, "nested.tgz"), "not really an archive");
  assert.throws(
    () => validateInventory({ root: scratch, entries: [{ path: "nested.tgz", size: 21, mode: 0o644 }] }),
    /Forbidden package entry/,
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log("release packer tests passed");
