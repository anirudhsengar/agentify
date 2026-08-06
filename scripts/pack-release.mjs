#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const EXPECTED_PACKAGE_NAME = "@anirudhsengar/agentify";
const EXPECTED_PACKAGE_MANAGER = "npm@11.19.0";
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".sh",
  ".txt", ".xml", ".yaml", ".yml",
]);
const TEXT_BASENAMES = new Set(["LICENSE"]);
const EXECUTABLE_PACKAGE_PATHS = new Set([
  "bin/agentify.js",
  "dist/learning-runtime.mjs",
  "dist/task-runtime.mjs",
  "scaffold/.github/scripts/complete-accepted-task-merge.mjs",
  "scaffold/.github/scripts/publish-task-draft.mjs",
  "scaffold/.github/scripts/run-task-lifecycle.mjs",
  "scaffold/.github/scripts/task-state-github.mjs",
]);
const FORBIDDEN_PATH_PATTERNS = [
  /(?:^|\/)src\//,
  /(?:^|\/)(?:node_modules|coverage|screenshots|videos)\//,
  /(?:^|\/)(?:raw-model|provider-session|session-transcript|pack-result)/i,
  /(?:^|\/)(?:tmp|temp|scratch)(?:\/|\.|$)/i,
  /\.(?:tgz|tar|zip)$/i,
  /(?:^|\/)\.npmrc$/i,
  /(?:^|\/)\.env(?:\.|$)/i,
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function isPackageTextPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  return TEXT_BASENAMES.has(basename) || TEXT_EXTENSIONS.has(path.posix.extname(basename).toLowerCase());
}

export function validatePackageFileBytes(relativePath, bytes) {
  assert.ok(Buffer.isBuffer(bytes), "package file bytes must be a Buffer");
  if (isPackageTextPath(relativePath)) {
    assert.equal(
      bytes.includes(0x0d),
      false,
      `Package text must use canonical LF without carriage-return bytes: ${relativePath}`,
    );
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalPackageMode(relativePath) {
  return EXECUTABLE_PACKAGE_PATHS.has(relativePath.replaceAll("\\", "/")) ? 0o755 : 0o644;
}

function parseTarOctal(header, offset, length, fieldName) {
  const value = header.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/s, "").trim();
  assert.match(value, /^[0-7]+$/, `release tar ${fieldName} must use octal encoding`);
  return Number.parseInt(value, 8);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  assert.equal(Buffer.byteLength(encoded), length, "canonical tar field width overflow");
  header.write(encoded, offset, length, "ascii");
}

function updateTarChecksum(header) {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encoded = `${checksum.toString(8).padStart(6, "0")}\0 `;
  assert.equal(Buffer.byteLength(encoded), 8, "canonical tar checksum width overflow");
  header.write(encoded, 148, 8, "ascii");
}

export function canonicalizePackedArchive(archiveBytes, expectedInventory) {
  assert.ok(Buffer.isBuffer(archiveBytes), "packed archive bytes must be a Buffer");
  const tarBytes = gunzipSync(archiveBytes);
  const expectedPaths = new Set(expectedInventory.map((entry) => entry.path));
  const seenPaths = new Set();
  let offset = 0;

  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    assert.ok(name.startsWith("package/"), `release tar entry must remain package-scoped: ${name}`);
    const relativePath = name.slice("package/".length);
    assert.equal(header[156], 0x30, `release tar entry must be a regular file: ${relativePath}`);
    assert.equal(expectedPaths.has(relativePath), true, `unexpected release tar entry: ${relativePath}`);
    assert.equal(seenPaths.has(relativePath), false, `duplicate release tar entry: ${relativePath}`);
    seenPaths.add(relativePath);

    writeTarOctal(header, 100, 8, canonicalPackageMode(relativePath));
    updateTarChecksum(header);
    const size = parseTarOctal(header, 124, 12, `${relativePath} size`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  assert.deepEqual([...seenPaths].sort(), [...expectedPaths].sort(), "release tar inventory must match inspected package inventory");
  assert.deepEqual(
    [...EXECUTABLE_PACKAGE_PATHS].filter((entry) => !seenPaths.has(entry)),
    [],
    "all canonical package executables must be present",
  );

  const canonical = gzipSync(tarBytes, { level: 9, mtime: 0 });
  canonical[9] = 0xff;
  return canonical;
}

function readRegularFile(absolutePath, relativePath) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    assert.ok(opened.isFile(), `Package entry must be a regular file: ${relativePath}`);

    const after = fs.lstatSync(absolutePath);
    assert.equal(after.isSymbolicLink(), false, `Package entry must not be a symlink: ${relativePath}`);
    assert.equal(after.dev, opened.dev, `Package entry changed while opening: ${relativePath}`);
    assert.equal(after.ino, opened.ino, `Package entry changed while opening: ${relativePath}`);

    const bytes = fs.readFileSync(descriptor);
    const final = fs.fstatSync(descriptor);
    assert.equal(final.size, bytes.length, `Package entry changed while reading: ${relativePath}`);
    return { bytes, stat: final };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function validateInventory({ root, entries }) {
  assert.ok(Array.isArray(entries) && entries.length > 0, "package inventory must be non-empty");
  const seen = new Set();
  return entries.map((entry) => {
    assert.equal(typeof entry?.path, "string", "every package inventory entry must have a path");
    const relativePath = entry.path.replaceAll("\\", "/");
    assert.ok(relativePath.length > 0 && !relativePath.startsWith("/") && !relativePath.includes(".."), `Unsafe package path: ${relativePath}`);
    assert.equal(seen.has(relativePath), false, `Duplicate package path: ${relativePath}`);
    seen.add(relativePath);
    for (const pattern of FORBIDDEN_PATH_PATTERNS) {
      assert.equal(pattern.test(relativePath), false, `Forbidden package entry: ${relativePath}`);
    }
    const absolutePath = path.resolve(root, ...relativePath.split("/"));
    assert.ok(absolutePath.startsWith(`${root}${path.sep}`), `Package path escapes repository: ${relativePath}`);
    const { bytes } = readRegularFile(absolutePath, relativePath);
    const sha256 = validatePackageFileBytes(relativePath, bytes);
    return { path: relativePath, size: bytes.length, mode: canonicalPackageMode(relativePath), sha256, text: isPackageTextPath(relativePath) };
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 15 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function parseSinglePackResult(stdout, phase) {
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed) && parsed.length === 1, `${phase} must return exactly one npm pack result`);
  return parsed[0];
}

function expectedTarballName(packageJson) {
  return `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
}

function requireCleanRepository() {
  const isolatedTest = process.env.AGENTIFY_PACK_ISOLATED_TEST === "1";
  const allowDirty = process.env.AGENTIFY_PACK_ALLOW_DIRTY === "1";
  if (isolatedTest && allowDirty) return;
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.trim();
  assert.equal(status, "", `pack:release requires a clean repository; found:\n${status}`);
}

function activeNpmVersion(npmCliPath) {
  return run(process.execPath, [npmCliPath, "--version"]).stdout.trim();
}

export function runReleasePack() {
  const npmCliPath = process.env.npm_execpath;
  assert.equal(typeof npmCliPath, "string", "pack:release must run through npm so npm_execpath identifies the active CLI");
  requireCleanRepository();

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  assert.equal(packageJson.name, EXPECTED_PACKAGE_NAME, "unexpected release package identity");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "package version must be semver");
  assert.equal(packageJson.packageManager, EXPECTED_PACKAGE_MANAGER, "release packaging npm version must stay pinned");
  assert.equal(packageLock.name, packageJson.name, "package-lock identity must match package.json");
  assert.equal(packageLock.version, packageJson.version, "package-lock version must match package.json");
  assert.equal(packageLock.packages?.[""]?.name, packageJson.name, "package-lock root identity must match package.json");
  assert.equal(packageLock.packages?.[""]?.version, packageJson.version, "package-lock root version must match package.json");

  const npmVersion = activeNpmVersion(npmCliPath);
  const npm = (args) => run(process.execPath, [npmCliPath, ...args]);
  const outputPath = path.join(repoRoot, expectedTarballName(packageJson));
  assert.equal(fs.existsSync(outputPath), false, `Refusing to overwrite existing release artifact: ${path.basename(outputPath)}`);

  let packedPath = null;
  try {
    const build = npm(["run", "build"]);
    if (build.stdout) process.stderr.write(build.stdout);
    if (build.stderr) process.stderr.write(build.stderr);

    const dryRun = parseSinglePackResult(npm(["pack", "--dry-run", "--json", "--ignore-scripts"]).stdout, "package inventory dry run");
    assert.equal(dryRun.name, packageJson.name, "dry-run package identity mismatch");
    assert.equal(dryRun.version, packageJson.version, "dry-run package version mismatch");
    const inspectedInventory = validateInventory({ root: repoRoot, entries: dryRun.files });

    const packed = parseSinglePackResult(npm(["pack", "--json", "--ignore-scripts"]).stdout, "release pack");
    assert.equal(packed.name, packageJson.name, "packed package identity mismatch");
    assert.equal(packed.version, packageJson.version, "packed package version mismatch");
    assert.equal(packed.filename, path.basename(outputPath), "packed filename mismatch");
    packedPath = path.resolve(repoRoot, packed.filename);
    const npmArtifact = readRegularFile(packedPath, packed.filename);
    const canonicalBytes = canonicalizePackedArchive(npmArtifact.bytes, inspectedInventory);
    fs.writeFileSync(packedPath, canonicalBytes);
    const artifact = readRegularFile(packedPath, packed.filename);
    const stat = artifact.stat;
    assert.ok(stat.isFile() && stat.size > 0, "release artifact must be one non-empty regular file");
    assert.deepEqual(
      (packed.files ?? []).map((entry) => [entry.path, entry.size]),
      inspectedInventory.map((entry) => [entry.path, entry.size]),
      "actual package inventory must equal the inspected pre-pack inventory",
    );

    return {
      filename: packed.filename,
      name: packed.name,
      version: packed.version,
      packedBytes: stat.size,
      unpackedBytes: packed.unpackedSize,
      inventoryCount: inspectedInventory.length,
      inventory: inspectedInventory,
      sha256: createHash("sha256").update(artifact.bytes).digest("hex"),
      nodeVersion: process.version,
      npmVersion,
    };
  } catch (error) {
    if (packedPath) fs.rmSync(packedPath, { force: true });
    else fs.rmSync(outputPath, { force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(runReleasePack())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
