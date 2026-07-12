import * as fs from "node:fs";
import * as path from "node:path";
import {
  GENERATED_SURFACE_PATHS,
  normalizeArtifactPath,
} from "../artifacts/generated-surface.ts";
import { markerForPath } from "../manifest.ts";

export type AuditSnapshotEntry = {
  ownership: "managed" | "unmanaged";
  content: Buffer;
  mode: number;
};

export type AuditArtifactSnapshot = Map<string, AuditSnapshotEntry>;

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

function listGeneratedSurfaceFiles(cwd: string): string[] {
  const files = new Set<string>();
  for (const rel of GENERATED_SURFACE_PATHS) {
    for (const filePath of listFilesRecursively(path.join(cwd, rel))) {
      files.add(filePath);
    }
  }
  return [...files];
}

function fileHasManagedMarker(relativePath: string, content: Buffer): boolean {
  const marker = markerForPath(relativePath);
  if (marker === "sha256") return true;
  return content.toString("utf-8").includes(marker);
}

export function collectAuditArtifactSnapshot(cwd: string): AuditArtifactSnapshot {
  const snapshot: AuditArtifactSnapshot = new Map();
  for (const filePath of listGeneratedSurfaceFiles(cwd)) {
    if (!fs.existsSync(filePath)) continue;
    const rel = toRel(cwd, filePath);
    const content = fs.readFileSync(filePath);
    snapshot.set(rel, {
      ownership: fileHasManagedMarker(rel, content) ? "managed" : "unmanaged",
      content,
      mode: fs.statSync(filePath).mode & 0o777,
    });
  }
  return snapshot;
}

function restoreSnapshotFile(
  cwd: string,
  relativePath: string,
  entry: AuditSnapshotEntry,
): void {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entry.content, { mode: entry.mode });
  try {
    fs.chmodSync(filePath, entry.mode);
  } catch {
    // Best effort on filesystems without chmod support.
  }
}

function cleanupEmptyGeneratedDirs(cwd: string): void {
  const dirs = GENERATED_SURFACE_PATHS
    .map((rel) => path.join(cwd, rel))
    .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory())
    .sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Directory was not empty or disappeared; both are fine.
    }
  }
}

export function rollbackGeneratedSurface(
  cwd: string,
  snapshot: AuditArtifactSnapshot,
): { removed: number; restored: number } {
  let removed = 0;
  let restored = 0;
  for (const filePath of listGeneratedSurfaceFiles(cwd)) {
    const rel = toRel(cwd, filePath);
    const entry = snapshot.get(rel);
    if (entry) {
      restoreSnapshotFile(cwd, rel, entry);
      restored += 1;
      continue;
    }
    fs.rmSync(filePath, { force: true });
    removed += 1;
  }
  for (const [rel, entry] of snapshot) {
    const filePath = path.join(cwd, rel);
    if (!fs.existsSync(filePath)) {
      restoreSnapshotFile(cwd, rel, entry);
      restored += 1;
    }
  }
  cleanupEmptyGeneratedDirs(cwd);
  return { removed, restored };
}
