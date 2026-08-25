import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PACKAGE_NAME = "@anirudhsengar/agentify";
const PACKAGE_VERSION = "__AGENTIFY_RUNTIME_VERSION__";
const RUNTIME_FILES = new Set(["task-runtime.mjs", "learning-runtime.mjs"]);

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function packageDirectory(root) {
  return path.join(root, "node_modules", "@anirudhsengar", "agentify");
}

function readInstalledPackage(root) {
  const directory = packageDirectory(root);
  const metadataPath = path.join(directory, "package.json");
  try {
    const directoryStat = fs.lstatSync(directory);
    const metadataStat = fs.lstatSync(metadataPath);
    assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
    assert.ok(metadataStat.isFile() && !metadataStat.isSymbolicLink());
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.name, PACKAGE_NAME);
    assert.equal(metadata.version, PACKAGE_VERSION);
    return fs.realpathSync(directory);
  } catch {
    return null;
  }
}

function installExactPackage(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
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
  const cacheRoot = path.join(os.tmpdir(), "agentify-runtime-cache", PACKAGE_VERSION);
  const existing = readInstalledPackage(cacheRoot);
  if (existing !== null) return existing;

  const temporary = `${cacheRoot}.${process.pid}.${Date.now()}`;
  try {
    installExactPackage(temporary);
    const installed = readInstalledPackage(temporary);
    if (installed === null) throw new Error("installed Agentify package failed identity validation");
    fs.mkdirSync(path.dirname(cacheRoot), { recursive: true, mode: 0o700 });
    try {
      fs.renameSync(temporary, cacheRoot);
    } catch (error) {
      const winner = readInstalledPackage(cacheRoot);
      if (winner === null) throw error;
      fs.rmSync(temporary, { recursive: true, force: true });
      return winner;
    }
    const promoted = readInstalledPackage(cacheRoot);
    if (promoted === null) throw new Error("promoted Agentify runtime cache failed validation");
    return promoted;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function runAgentifyRuntime(runtimeFile, args) {
  if (!RUNTIME_FILES.has(runtimeFile)) throw new Error(`unsupported Agentify runtime: ${runtimeFile}`);
  const packageRoot = resolvePackageDirectory();
  const runtimePath = path.join(packageRoot, "dist", runtimeFile);
  const runtimeStat = fs.lstatSync(runtimePath);
  if (!runtimeStat.isFile() || runtimeStat.isSymbolicLink()) {
    throw new Error(`Agentify package is missing trusted runtime ${runtimeFile}`);
  }
  const realRuntime = fs.realpathSync(runtimePath);
  if (!realRuntime.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error("Agentify runtime resolved outside the verified package root");
  }
  const result = spawnSync(process.execPath, [realRuntime, ...args], {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
