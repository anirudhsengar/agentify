import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Reuse one caller-qualified tarball when AGENTIFY_TEST_TARBALL is set.
 * Standalone smoke tests build and pack when no exact tarball is provided.
 */
export function resolveExactArtifact({ repoRoot, packageJson, runNpm }) {
  const provided = process.env.AGENTIFY_TEST_TARBALL?.trim();
  if (provided) {
    const tarballPath = path.resolve(provided);
    const stat = fs.statSync(tarballPath);
    assert.ok(stat.isFile() && stat.size > 0, "AGENTIFY_TEST_TARBALL must name one non-empty regular file");
    const listed = spawnSync("tar", ["-tf", tarballPath], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr || "could not inventory AGENTIFY_TEST_TARBALL");
    const files = listed.stdout.split(/\r?\n/).filter(Boolean).map((entry) => ({
      path: entry.replace(/^package\//, "").replace(/\/$/, ""),
    }));
    return {
      tarballPath,
      owned: false,
      artifact: { name: packageJson.name, version: packageJson.version, files },
    };
  }

  const packed = runNpm(["run", "--silent", "pack:release"]);
  const artifact = JSON.parse(packed.stdout);
  assert.equal(artifact?.name, packageJson.name, "npm pack must preserve the scoped package identity");
  assert.equal(artifact?.version, packageJson.version, "npm pack must preserve the release version");
  assert.equal(typeof artifact?.filename, "string", "npm pack result must include filename");
  assert.ok(artifact.filename.trim().length > 0, "npm pack filename must be non-empty");
  return {
    tarballPath: path.join(repoRoot, artifact.filename),
    owned: true,
    artifact: { ...artifact, files: artifact.inventory },
  };
}

export function removeOwnedArtifact(resolved) {
  if (resolved?.owned === true) fs.rmSync(resolved.tarballPath, { force: true });
}
