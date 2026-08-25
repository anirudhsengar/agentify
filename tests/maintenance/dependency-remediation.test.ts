import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const REGISTRY_SEMVER = /^(?:\^|~)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface LockPackage {
  resolved?: string;
  version?: string;
}

interface PackageLock {
  packages?: Record<string, LockPackage>;
}

test("production dependencies use registry semver specifications", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as PackageManifest;
  const lock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  ) as PackageLock;

  for (const [name, specification] of Object.entries(manifest.dependencies ?? {})) {
    assert.match(specification, REGISTRY_SEMVER, `${name} must use a registry semver specification`);
    const locked = lock.packages?.[`node_modules/${name}`];
    assert.ok(locked?.version, `${name} must be represented in the lockfile`);
    assert.match(
      locked.resolved ?? "",
      /^https:\/\/registry\.npmjs\.org\//u,
      `${name} must resolve from the npm registry`,
    );
  }

  // Zero-dependency package: esbuild inlines everything into dist/, so the
  // published artifact must declare no production dependencies. The pinned
  // pi packages live in devDependencies and are bundled at build time.
  assert.deepEqual(
    manifest.dependencies ?? {},
    {},
    "published package must stay zero-dependency; runtime libraries belong in devDependencies",
  );
  assert.equal(manifest.devDependencies?.["@earendil-works/pi-ai"], "0.84.0");
  assert.equal(manifest.devDependencies?.["@earendil-works/pi-coding-agent"], "0.84.0");
});
