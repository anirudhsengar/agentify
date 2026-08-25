import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PACKAGE_NAME = "@anirudhsengar/agentify";
const PACKAGE_VERSION = "__AGENTIFY_RUNTIME_VERSION__";
const RUNTIME_FILES = new Set(["task-runtime.mjs", "learning-runtime.mjs"]);
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function packageDirectory(root) {
  return path.join(root, "node_modules", "@anirudhsengar", "agentify");
}

function cacheScope() {
  const username = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "unknown";
    }
  })();
  return createHash("sha256")
    .update(`${os.homedir()}\0${username}`)
    .digest("hex")
    .slice(0, 16);
}

function validateDirectory(directory, requirePrivate) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`unsafe Agentify runtime directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Agentify runtime directory has an unexpected owner: ${directory}`);
  }
  if (requirePrivate && process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`Agentify runtime directory is not private: ${directory}`);
  }
  const real = fs.realpathSync(directory);
  if (real !== path.resolve(directory)) {
    throw new Error(`Agentify runtime directory resolves through a link: ${directory}`);
  }
  return real;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`unsafe Agentify runtime directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Agentify runtime directory has an unexpected owner: ${directory}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    fs.chmodSync(directory, 0o700);
  }
  return validateDirectory(directory, true);
}

function readRegularFile(filePath, maximumBytes) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      throw new Error(`unsafe Agentify runtime file: ${filePath}`);
    }
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      throw new Error(`Agentify runtime file has an unexpected owner: ${filePath}`);
    }
    if (process.platform !== "win32" && (before.mode & 0o022) !== 0) {
      throw new Error(`Agentify runtime file is writable by another principal: ${filePath}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || bytes.length !== after.size
    ) {
      throw new Error(`Agentify runtime file changed while reading: ${filePath}`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readInstalledPackage(root) {
  try {
    validateDirectory(root, true);
    const directory = validateDirectory(packageDirectory(root), false);
    const metadata = JSON.parse(
      readRegularFile(path.join(directory, "package.json"), MAX_METADATA_BYTES).toString("utf8"),
    );
    assert.equal(metadata.name, PACKAGE_NAME);
    assert.equal(metadata.version, PACKAGE_VERSION);
    return directory;
  } catch {
    return null;
  }
}

function installExactPackage(root) {
  validateDirectory(root, true);
  const result = spawnSync(
    npmCommand(),
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--package-lock=false",
      "--prefix",
      root,
      `${PACKAGE_NAME}@${PACKAGE_VERSION}`,
    ],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `failed to install ${PACKAGE_NAME}@${PACKAGE_VERSION}: ${result.stderr || result.stdout}`,
    );
  }
}

function resolvePackageDirectory() {
  assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const cacheParent = ensurePrivateDirectory(
    path.join(os.tmpdir(), `agentify-runtime-cache-${cacheScope()}`),
  );
  const cacheRoot = path.join(cacheParent, PACKAGE_VERSION);
  const existing = readInstalledPackage(cacheRoot);
  if (existing !== null) return existing;

  const temporary = fs.mkdtempSync(path.join(cacheParent, `${PACKAGE_VERSION}.tmp-`));
  if (process.platform !== "win32") fs.chmodSync(temporary, 0o700);
  try {
    installExactPackage(temporary);
    const installed = readInstalledPackage(temporary);
    if (installed === null) throw new Error("installed Agentify package failed identity validation");
    try {
      fs.renameSync(temporary, cacheRoot);
    } catch (error) {
      const winner = readInstalledPackage(cacheRoot);
      if (winner === null) throw error;
      return winner;
    }
    const promoted = readInstalledPackage(cacheRoot);
    if (promoted === null) throw new Error("promoted Agentify runtime cache failed validation");
    return promoted;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function executeRuntime(packageRoot, runtimeFile, args) {
  const runtimeBytes = readRegularFile(
    path.join(packageRoot, "dist", runtimeFile),
    MAX_RUNTIME_BYTES,
  );
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-runtime-exec-"));
  if (process.platform !== "win32") fs.chmodSync(executionRoot, 0o700);
  try {
    const executionPath = path.join(executionRoot, runtimeFile);
    fs.writeFileSync(executionPath, runtimeBytes, { flag: "wx", mode: 0o500 });
    const result = spawnSync(process.execPath, [executionPath, ...args], {
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
}

export function runAgentifyRuntime(runtimeFile, args) {
  if (!RUNTIME_FILES.has(runtimeFile)) {
    throw new Error(`unsupported Agentify runtime: ${runtimeFile}`);
  }
  return executeRuntime(resolvePackageDirectory(), runtimeFile, args);
}
