import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactWrite } from "../types.ts";
import type { RenderedArtifact } from "../artifacts/renderers.ts";
import { normalizeArtifactPath } from "../artifacts/generated-surface.ts";
import {
  codebaseMapRelativePath,
  kindForPath,
  manifestFileFromContent,
  manifestRelativePath,
  markerForPath,
  type ManagedManifestFile,
} from "../manifest.ts";

function toRel(cwd: string, filePath: string): string {
  return normalizeArtifactPath(path.relative(cwd, filePath));
}

function listFilesRecursively(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

function writeFileUnderRoot(
  root: string,
  relativePath: string,
  content: string | Buffer,
): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o644 });
}

export function makeStagingRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-staging-"));
}

export function writeRenderedArtifactsToStaging(
  stagingRoot: string,
  artifacts: readonly RenderedArtifact[],
  metadata: Map<string, ManagedManifestFile>,
): void {
  for (const artifact of artifacts) {
    writeFileUnderRoot(stagingRoot, artifact.relativePath, artifact.content);
    metadata.set(artifact.relativePath, manifestFileFromContent({
      relativePath: artifact.relativePath,
      content: artifact.content,
      kind: artifact.kind,
      required: artifact.required,
      marker: artifact.marker,
      source: artifact.source,
    }));
  }
}

export function copyCanonicalMapToStaging(
  cwd: string,
  stagingRoot: string,
  stateDir: string,
  metadata: Map<string, ManagedManifestFile>,
): void {
  const mapRelPath = codebaseMapRelativePath(stateDir);
  const source = path.join(cwd, mapRelPath);
  if (!fs.existsSync(source)) return;
  const content = fs.readFileSync(source);
  writeFileUnderRoot(stagingRoot, mapRelPath, content);
  metadata.set(mapRelPath, manifestFileFromContent({
    relativePath: mapRelPath,
    content,
    kind: "state",
    required: true,
    marker: markerForPath(mapRelPath),
    source: "write_map",
  }));
}

export function collectStagedFiles(
  stagingRoot: string,
  stateDir: string,
): Array<{ relativePath: string; content: Buffer }> {
  const manifestRelPath = manifestRelativePath(stateDir);
  return listFilesRecursively(stagingRoot)
    .map((filePath) => ({
      relativePath: toRel(stagingRoot, filePath),
      content: fs.readFileSync(filePath),
    }))
    .filter((file) => file.relativePath !== manifestRelPath);
}

export function addWriteMetadata(
  stagingRoot: string,
  writes: readonly ArtifactWrite[],
  source: string,
  metadata: Map<string, ManagedManifestFile>,
): void {
  for (const write of writes) {
    if (write.action === "conflict") continue;
    // For "alongside" actions, the writer wrote the content to
    // `alongsidePath` (a sibling of the canonical). The manifest
    // entry should key on the canonical path and record the
    // alongside path so `verifyManifest` and `revert` can find it.
    const contentPath = write.action === "alongside" && write.alongsidePath
      ? write.alongsidePath
      : write.path;
    const canonicalRelative = toRel(stagingRoot, write.path);
    const contentRelative = toRel(stagingRoot, contentPath);
    const filePath = path.join(stagingRoot, contentRelative);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath);
    const alongsideRel = write.action === "alongside" ? contentRelative : undefined;
    metadata.set(canonicalRelative, manifestFileFromContent({
      relativePath: canonicalRelative,
      content,
      kind: kindForPath(canonicalRelative),
      required: undefined,
      marker: markerForPath(canonicalRelative),
      source,
      alongsidePath: alongsideRel,
    }));
  }
}
